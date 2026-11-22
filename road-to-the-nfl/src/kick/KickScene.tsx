import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { CONFIG } from '../config';
import { Rng } from '../sim/rng';
import type { Camera } from './camera';
import { sound } from '../audio/sound';
import { describeWind, goalPlaneY, powerSpeedFrac, resolveKick, type KickResult, type KickSetup, type KickerRatings, type Vec3 } from './physics';
import { buildCamera, drawMeters, drawScene, type Phase, type SceneView } from './render';

export interface SessionLine {
  label: string;
  made: number;
  att: number;
  long: number;
}

interface Props {
  setup: KickSetup;
  kicker: KickerRatings;
  accent: string;
  kickerName: string;
  session: SessionLine;
  seed: number;
  onResult: (r: KickResult) => void;
  onAgain: () => void;
  onNewSpot: () => void;
  onExit: () => void;
}

interface Runtime {
  phase: Phase;
  phaseStart: number;
  aimX: number;
  power: number;
  powerLocked: number | null;
  accuracy: number;
  accStartLeft: boolean;
  accuracyLocked: number | null;
  result: KickResult | null;
  called: boolean; // banner shown
  decidedAt: number | null; // result known (sound, stats)
  lockAt: number | null; // accuracy locked: snap and approach begin
  fi: number; // flight playback position, in path samples
  slowBlend: number;
  slowHit: boolean;
  stepsPlayed: number;
  bounces: number[]; // path indices where the ball hits the turf
  nextBounce: number;
  lookBoost: number;
  shakeUntil: number;
  contactAt: number | null;
  keys: { left: boolean; right: boolean };
}

const fresh = (): Runtime => ({
  phase: 'aim',
  phaseStart: 0,
  aimX: 0,
  power: 0,
  powerLocked: null,
  accuracy: -1,
  accStartLeft: true,
  accuracyLocked: null,
  result: null,
  called: false,
  decidedAt: null,
  lockAt: null,
  fi: 0,
  slowBlend: 0,
  slowHit: false,
  stepsPlayed: 0,
  bounces: [],
  nextBounce: 0,
  lookBoost: 0,
  shakeUntil: -1,
  contactAt: null,
  keys: { left: false, right: false },
});

/** Playback speed through a close call: normal, easing down to slow motion around the posts, then back. */
function slowScale(fi: number, decideIndex: number): number {
  const S = CONFIG.slowMo;
  const x = (decideIndex - fi) / 60; // flight seconds until the posts
  const lo = S.timeScale;
  if (x > S.leadS) return 1;
  if (x > S.leadS - S.rampS) return 1 + (lo - 1) * ((S.leadS - x) / S.rampS);
  if (x > -S.holdS) return lo;
  if (x > -S.holdS - S.rampS) return lo + (1 - lo) * ((-S.holdS - x) / S.rampS);
  return 1;
}

/** The crowd and the posts react the moment the result is known. */
function react(r: KickResult) {
  if (r.outcome === 'GOOD_UPRIGHT' || r.outcome === 'UPRIGHT_NO' || r.outcome === 'GOOD_CROSSBAR' || r.outcome === 'CROSSBAR_NO') sound.clang();
  if (r.outcome === 'BLOCKED') sound.block();
  if (r.made) sound.roar(r.slowMo ? 1.3 : 1);
  else sound.groan();
}

const HASH_LABEL = { L: 'Left hash', M: 'Middle', R: 'Right hash' } as const;

export function callText(r: KickResult): { big: string; good: boolean } {
  switch (r.outcome) {
    case 'GOOD':
      return { big: "IT'S GOOD!", good: true };
    case 'GOOD_UPRIGHT':
      return { big: 'OFF THE UPRIGHT… GOOD!', good: true };
    case 'GOOD_CROSSBAR':
      return { big: 'OFF THE CROSSBAR… GOOD!', good: true };
    case 'WIDE_LEFT':
      return { big: 'NO GOOD — WIDE LEFT', good: false };
    case 'WIDE_RIGHT':
      return { big: 'NO GOOD — WIDE RIGHT', good: false };
    case 'SHORT':
      return { big: 'NO GOOD — SHORT', good: false };
    case 'UPRIGHT_NO':
      return { big: 'DOINK! NO GOOD', good: false };
    case 'CROSSBAR_NO':
      return { big: 'OFF THE CROSSBAR — NO GOOD', good: false };
    case 'BLOCKED':
      return { big: 'BLOCKED!', good: false };
  }
}

function detailText(r: KickResult, setup: KickSetup): string {
  const strike = r.inSweetSpot ? 'Pure contact' : r.strikeMiss < 0 ? 'Hooked it left' : 'Sliced it right';
  const leg = `Had the leg from ${Math.round(r.carryYd)}`;
  switch (r.outcome) {
    case 'WIDE_LEFT':
    case 'WIDE_RIGHT':
      return `Missed by ${r.missByFt.toFixed(1)} ft · ${strike}`;
    case 'SHORT':
      return `Came up ${Math.max(1, Math.round(r.shortByYd))} yd short · ${leg}`;
    case 'BLOCKED':
      return 'Got a hand on it at the line';
    case 'UPRIGHT_NO':
    case 'CROSSBAR_NO':
      return `${strike} · so close`;
    default:
      return `${setup.distanceYd} yards · ${strike} · ${leg}`;
  }
}

export function KickScene({ setup, kicker, kickerName, accent, session, seed, onResult, onAgain, onNewSpot, onExit }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rt = useRef<Runtime>(fresh());
  const camRef = useRef<Camera | null>(null);
  const t0 = useRef(performance.now() / 1000);
  const [ui, setUi] = useState<{ phase: Phase; result: KickResult | null; called: boolean; slow: boolean }>({ phase: 'aim', result: null, called: false, slow: false });
  const [muted, setMuted] = useState(sound.muted);

  const cb = useRef({ onResult, onAgain, onNewSpot, onExit, setup, kicker });
  cb.current = { onResult, onAgain, onNewSpot, onExit, setup, kicker };

  const now = () => performance.now() / 1000 - t0.current;

  // New setup or new attempt → reset the scene.
  useEffect(() => {
    rt.current = fresh();
    rt.current.phaseStart = now();
    setUi({ phase: 'aim', result: null, called: false, slow: false });
    sound.crowd(CONFIG.audio.crowdIdle, 1.5);
  }, [setup, seed]);

  const setPhase = (p: Phase) => {
    rt.current.phase = p;
    rt.current.phaseStart = now();
    setUi((u) => ({ ...u, phase: p }));
  };

  const advance = useCallback(() => {
    sound.start();
    const s = rt.current;
    const t = now();
    switch (s.phase) {
      case 'aim':
        setPhase('power');
        break;
      case 'power':
        s.powerLocked = s.power;
        s.accStartLeft = Math.random() < 0.5;
        s.accuracy = s.accStartLeft ? -1 : 1;
        setPhase('accuracy');
        break;
      case 'accuracy': {
        s.accuracyLocked = s.accuracy;
        // Dev-only hook so automated checks can force a strike (never in a build).
        if (import.meta.env.DEV) {
          const force = (window as unknown as { __rtnForce?: { accuracy?: number; aimX?: number } }).__rtnForce;
          if (force?.accuracy !== undefined) s.accuracyLocked = force.accuracy;
          if (force?.aimX !== undefined) s.aimX = force.aimX;
        }
        const { setup: su, kicker: k } = cb.current;
        const r = resolveKick(su, { aimXFt: s.aimX, power: s.powerLocked ?? 0, accuracy: s.accuracyLocked }, k, new Rng(seed * 7919 + 17));
        s.result = r;
        s.lockAt = t;
        s.bounces = [];
        for (let i = Math.max(1, r.decideIndex - 5); i < r.path.length - 1; i++) {
          const a = r.path[i - 1];
          const b = r.path[i];
          const c = r.path[i + 1];
          if (b.z < 0.05 && a.z > 0.05 && c.z >= b.z) s.bounces.push(i);
        }
        sound.crowd(CONFIG.audio.crowdHush, 0.4);
        setUi((u) => ({ ...u, result: r }));
        setPhase('flight');
        break;
      }
      case 'flight': {
        // Skip ahead: first to the call, then to the end.
        if (!s.result || s.contactAt === null) break;
        const callAt = s.result.decideIndex + (s.result.slowMo ? CONFIG.slowMo.holdS * 60 : 0);
        s.fi = Math.max(s.fi, s.called ? s.result.path.length - 1 : callAt + 0.01);
        break;
      }
      case 'result':
        cb.current.onAgain();
        break;
    }
  }, [seed]);

  // Keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const s = rt.current;
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (!e.repeat) advance();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        s.keys.left = true;
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        s.keys.right = true;
      } else if (e.code === 'KeyN' && (s.phase === 'result' || s.phase === 'aim')) {
        cb.current.onNewSpot();
      } else if (e.code === 'KeyM') {
        sound.start();
        setMuted(sound.toggleMute());
      } else if (e.code === 'Escape') {
        cb.current.onExit();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft') rt.current.keys.left = false;
      if (e.code === 'ArrowRight') rt.current.keys.right = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [advance]);

  // Frame loop
  useEffect(() => {
    let raf = 0;
    let last = now();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const m = CONFIG.meters;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const t = now();
      const dt = Math.min(0.05, t - last);
      last = t;
      const s = rt.current;
      const su = cb.current.setup;
      const pt = t - s.phaseStart;

      if (s.phase === 'aim') {
        const dir = (s.keys.right ? 1 : 0) - (s.keys.left ? 1 : 0);
        s.aimX = Math.max(-m.aimRangeFt, Math.min(m.aimRangeFt, s.aimX + dir * m.aimKeySpeedFtS * dt));
      } else if (s.phase === 'power') {
        const up = m.powerMax * m.powerFillS;
        const u = pt % (2 * up);
        s.power = (u < up ? u : 2 * up - u) / m.powerFillS;
      } else if (s.phase === 'accuracy') {
        const travel = (pt * 2) / m.accuracySweepS;
        const passes = Math.floor(travel / 2);
        if (passes >= m.accuracyMaxPasses) {
          s.accuracy = (s.accStartLeft ? 1 : -1) * (m.accuracyMaxPasses % 2 === 1 ? 1 : -1);
          advance();
        } else {
          const frac = travel % 2;
          const forward = passes % 2 === 0 === s.accStartLeft;
          s.accuracy = forward ? -1 + frac : 1 - frac;
        }
      }

      // Ball
      const x0 = su.hash === 'L' ? -CONFIG.levels[su.level].hashWidthFt / 2 : su.hash === 'R' ? CONFIG.levels[su.level].hashWidthFt / 2 : 0;
      let ball: Vec3 = { x: x0, y: 0, z: 0 };
      let tracer: Vec3[] = [];
      let spin = 0;
      let held = true;
      const A = CONFIG.kickerAnim;
      const SM = CONFIG.slowMo;
      if (s.result && s.lockAt !== null) {
        const r = s.result;
        const k = t - s.lockAt;
        const stepTimes = [0.25, 0.5, 0.75, 1].map((f) => f * A.stepsEndS);
        while (s.stepsPlayed < stepTimes.length && k >= stepTimes[s.stepsPlayed]) {
          sound.step();
          s.stepsPlayed++;
        }
        if (s.contactAt === null && k >= A.contactS) {
          s.contactAt = t;
          s.shakeUntil = t + CONFIG.presentation.shakeOnContactS;
          sound.thump(powerSpeedFrac(s.powerLocked ?? 1));
          sound.crowd(CONFIG.audio.crowdFlight, (r.decideIndex / 60) * 0.9);
        }
      }
      if (s.result && s.contactAt !== null) {
        held = false;
        const r = s.result;
        const path = r.path;
        const scale = r.slowMo ? slowScale(s.fi, r.decideIndex) : 1;
        s.fi += dt * 60 * CONFIG.presentation.flightPlaybackSpeed * scale;
        const fi = s.fi;
        const blendWant = r.slowMo ? (1 - scale) / (1 - SM.timeScale) : 0;
        s.slowBlend += (blendWant - s.slowBlend) * Math.min(1, dt * 10);
        if (s.slowBlend < 0.002) s.slowBlend = 0;
        sound.slowMo(s.slowBlend);
        if (r.slowMo && !s.slowHit && s.slowBlend > 0.25) {
          s.slowHit = true;
          sound.slowMoHit();
          setUi((u) => ({ ...u, slow: true }));
        }
        const i = Math.min(path.length - 1, Math.floor(fi));
        const f = Math.min(1, fi - i);
        const a = path[i];
        const b = path[Math.min(path.length - 1, i + 1)];
        ball = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
        tracer = path.slice(0, i + 1).concat([ball]);
        spin = fi * 0.42;
        if (s.decidedAt === null && i >= r.decideIndex) {
          s.decidedAt = t;
          react(r);
          cb.current.onResult(r);
        }
        const callAt = r.decideIndex + (r.slowMo ? SM.holdS * 60 : 0);
        if (!s.called && fi >= callAt) {
          s.called = true;
          setUi((u) => ({ ...u, called: true, slow: false }));
        }
        while (s.nextBounce < s.bounces.length && i >= s.bounces[s.nextBounce]) {
          const bi = s.bounces[s.nextBounce];
          const drop = path[Math.max(0, bi - 3)].z - path[bi].z;
          sound.thud(Math.min(1, drop / 3));
          s.nextBounce++;
        }
        if (s.phase === 'flight' && fi >= path.length - 1 + CONFIG.presentation.resultDelayS * 60 && s.called) {
          setPhase('result');
          sound.crowd(CONFIG.audio.crowdIdle, 3);
        }
        const want = Math.max(0, ball.z - 14) * 0.45;
        s.lookBoost += (want - s.lookBoost) * Math.min(1, dt * 3);
      } else {
        s.lookBoost += (0 - s.lookBoost) * Math.min(1, dt * 3);
      }

      // Size
      const wrap = wrapRef.current!;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const shake = t < s.shakeUntil ? (s.shakeUntil - t) / CONFIG.presentation.shakeOnContactS : 0;
      const slow =
        s.result && s.result.slowMo && s.slowBlend > 0 && s.result.crossXFt !== null
          ? { blend: s.slowBlend, focus: { x: s.result.crossXFt, y: goalPlaneY(su.distanceYd), z: s.result.crossZFt ?? 12 }, ball }
          : undefined;
      const cam = buildCamera(w, h, su, s.lookBoost, shake, t, slow);
      camRef.current = cam;
      const view: SceneView = {
        setup: su,
        kicker: cb.current.kicker,
        accent,
        time: t,
        phase: s.phase,
        aimX: s.aimX,
        ball,
        ballSpin: spin,
        ballHeld: held,
        tracer,
        sinceContact: s.contactAt === null ? null : t - s.contactAt,
        sinceLock: s.lockAt === null ? null : t - s.lockAt,
        sinceDecide: s.decidedAt === null ? null : t - s.decidedAt,
        made: s.decidedAt === null || !s.result ? null : s.result.made,
        slowBlend: s.slowBlend,
        lookBoost: s.lookBoost,
        shake,
        power: s.power,
        powerLocked: s.powerLocked,
        accuracy: s.accuracy,
        accuracyLocked: s.accuracyLocked,
      };
      drawScene(ctx, cam, w, h, view);
      if (s.slowBlend < 0.03) drawMeters(ctx, w, h, view);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [accent, advance]);

  // Mouse / touch aim: find the aim x whose marker sits under the pointer.
  const onPointerMove = (e: React.PointerEvent) => {
    const s = rt.current;
    const cam = camRef.current;
    if (s.phase !== 'aim' || !cam) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const planeY = goalPlaneY(cb.current.setup.distanceYd);
    const R = CONFIG.meters.aimRangeFt;
    let lo = -R;
    let hi = R;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const p = cam.project({ x: mid, y: planeY, z: 14 });
      if (!p) return;
      if (p.sx < mx) lo = mid;
      else hi = mid;
    }
    s.aimX = (lo + hi) / 2;
  };

  const steps: { key: Phase; label: string }[] = [
    { key: 'aim', label: 'Aim' },
    { key: 'power', label: 'Power' },
    { key: 'accuracy', label: 'Accuracy' },
    { key: 'flight', label: 'Flight' },
  ];
  const stepIdx = ui.phase === 'result' ? 3 : steps.findIndex((s) => s.key === ui.phase);
  const hint =
    ui.phase === 'aim'
      ? 'Read the wind · ← → or mouse to aim · SPACE / click to set'
      : ui.phase === 'power'
        ? 'SPACE to stop near the top · past the line = more leg, smaller sweet spot'
        : ui.phase === 'accuracy'
          ? 'SPACE in the green'
          : '';
  const call = ui.called && ui.result ? callText(ui.result) : null;
  const level = CONFIG.levels[setup.level];

  return (
    <div className={`scene ${ui.slow ? 'slowmo' : ''}`} ref={wrapRef} style={{ '--accent': accent } as CSSProperties}>
      <canvas ref={canvasRef} className="scene-canvas" onPointerMove={onPointerMove} onPointerDown={() => advance()} />

      <div className="bug">
        <div className="bug-team">{session.label}</div>
        <div className="bug-cell">
          <span className="bug-k">FG</span>
          <span className="bug-v">
            {session.made}/{session.att}
          </span>
        </div>
        <div className="bug-cell">
          <span className="bug-k">LONG</span>
          <span className="bug-v">{session.long || '—'}</span>
        </div>
        <div className="bug-cell bug-level">{level.label.toUpperCase()}</div>
      </div>

      <div className="steps">
        {steps.map((s, i) => (
          <div key={s.key} className={`step ${i === stepIdx ? 'on' : ''} ${i < stepIdx ? 'done' : ''}`}>
            {s.label}
          </div>
        ))}
      </div>

      <div className="wind">
        <div className="wind-dial">
          <div className="wind-arrow" style={{ transform: `rotate(${setup.windToDeg}deg)`, opacity: setup.windMph < 1 ? 0.25 : 1 }}>
            <svg viewBox="0 0 40 40" width="100%" height="100%">
              <path d="M20 4 L28 16 L23 16 L23 34 L17 34 L17 16 L12 16 Z" fill="currentColor" />
            </svg>
          </div>
          <div className="wind-posts">▲ posts</div>
        </div>
        <div className="wind-txt">
          <div className="wind-mph">
            {Math.round(setup.windMph)}
            <small> MPH</small>
          </div>
          <div className="wind-desc">{describeWind(setup.windMph, setup.windToDeg)}</div>
        </div>
      </div>

      {!call && (
        <div className="lower-third">
          <div className="lt-accent" />
          <div className="lt-body">
            <div className="lt-name">{kickerName}</div>
            <div className="lt-title">{setup.distanceYd}-yard field goal</div>
            <div className="lt-row">
              <span>{HASH_LABEL[setup.hash]}</span>
              <span>Wind {Math.round(setup.windMph)} mph · {describeWind(setup.windMph, setup.windToDeg)}</span>
              <span>Clear</span>
            </div>
          </div>
        </div>
      )}

      {hint && <div className="hint">{hint}</div>}

      <button
        className="mute"
        title="Sound on/off (M)"
        onClick={() => {
          sound.start();
          setMuted(sound.toggleMute());
        }}
      >
        {muted ? '🔇' : '🔊'}
      </button>

      {call && ui.result && (
        <div className={`call ${call.good ? 'good' : 'miss'}`} key={seed}>
          <div className="call-big">{call.big}</div>
          <div className="call-sub">{detailText(ui.result, setup)}</div>
          {ui.phase === 'result' && (
            <div className="actions">
              <button onClick={() => onAgain()}>
                <kbd>Space</kbd> Kick again
              </button>
              <button onClick={() => onNewSpot()}>
                <kbd>N</kbd> New spot
              </button>
              <button onClick={() => onExit()}>
                <kbd>Esc</kbd> Setup
              </button>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

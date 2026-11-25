import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CONFIG } from '../config';
import { Rng } from '../sim/rng';
import type { Camera } from './camera';
import { sound } from '../audio/sound';
import type { Kit } from './figures';
import { describeWind, goalPlaneY, powerSpeedFrac, rate, resolveKick, type Trajectory, type KickResult, type KickSetup, type KickerRatings, type Vec3 } from './physics';
import { buildCamera, buildReplayCamera, drawMeters, drawScene, FIREWORK_TIMES, type Phase, type SceneView, type Venue } from './render';
import { afterKick, inFlight, preKick, type BoothContext, type Caption } from './booth';
import { applyDifficulty, readSettings, writeSettings } from '../career/story';

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
  kickerNumber?: string;
  teamKit?: Kit;
  oppKit?: Kit;
  session?: SessionLine;
  /** Replaces the practice score bug (game mode). */
  bug?: ReactNode;
  /** Situation card title, e.g. "Extra point". Defaults to "N-yard field goal". */
  cardTitle?: string;
  /** Small tag on the card, e.g. "GAME-WINNER". */
  cardTag?: string;
  weatherLabel?: string;
  /** 0..1 raw pressure of the moment (Composure reduces its effect). */
  pressure?: number;
  /** Opponent called a timeout to ice the kicker. */
  iced?: string | null;
  /** 'practice' shows Kick again / New spot / Setup; 'game' shows one Continue button. */
  mode?: 'practice' | 'game';
  continueLabel?: string;
  /** A made kick here ties or wins the game: celebrate. */
  clutch?: 'winner' | 'tie' | 'lead' | null;
  /** The longest field goal to beat in the current record book. */
  recordLong?: { value: number; scope: string } | null;
  /** Video board lines. */
  board?: [string, string];
  /** Painted in the end zone. */
  endzone?: string;
  /** Your crowd or theirs: road crowds groan at your makes and roar at your misses. */
  home?: boolean;
  /** No timeouts, clock running: aim before the snap. */
  hurry?: boolean;
  /** Broadcast booth context (game day). */
  booth?: Partial<BoothContext>;
  venue?: Venue;
  /** Ice Water trait: icing doesn't speed up the meters. */
  icingImmune?: boolean;
  seed: number;
  onResult: (r: KickResult) => void;
  onAgain: () => void;
  onNewSpot?: () => void;
  onExit?: () => void;
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
  icedUntil: number;
  celebrateAt: number | null;
  trajectory: Trajectory;
  badSnap: boolean;
  snapAt: number | null;
  hurryEnds: number | null;
  replayAt: number | null;
  replayDone: boolean;
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
  icedUntil: 0,
  celebrateAt: null,
  trajectory: 'normal',
  badSnap: false,
  snapAt: null,
  hurryEnds: null,
  replayAt: null,
  replayDone: false,
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
function react(r: KickResult, home: boolean) {
  if (r.outcome === 'GOOD_UPRIGHT' || r.outcome === 'UPRIGHT_NO' || r.outcome === 'GOOD_CROSSBAR' || r.outcome === 'CROSSBAR_NO') sound.clang();
  if (r.outcome === 'BLOCKED') sound.block();
  // On the road the crowd is against you: they groan at your makes and roar at your misses.
  if (r.made === home) sound.roar(r.slowMo ? 1.3 : 1);
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

export function KickScene(props: Props) {
  const { setup, kickerName, accent, session, seed, onResult, onAgain, mode = 'practice' } = props;
  const settings = useMemo(() => readSettings(), []);
  // Difficulty shifts the ratings the kick uses.
  const kicker = useMemo(() => applyDifficulty(props.kicker, settings.difficulty), [props.kicker, settings.difficulty]);
  const home = props.home ?? true;
  const venue: Venue = props.venue ?? { time: 'night', dome: false, snowField: setup.weather === 'snow' };
  const onNewSpot = props.onNewSpot ?? (() => {});
  const onExit = props.onExit ?? (() => {});
  const P = CONFIG.practice;
  const teamKit = props.teamKit ?? P.team;
  const oppKit = props.oppKit ?? P.opponent;
  const kickerNumber = props.kickerNumber ?? P.kickerNumber;
  // Composure decides how much of the moment's pressure reaches the meters.
  const cf = rate(kicker.composure, CONFIG.pressure.composureFactor);
  const eff = Math.min(1, (props.pressure ?? 0) * cf);
  const speedMult = (1 + eff * CONFIG.pressure.speedGain + (props.iced && !props.icingImmune ? CONFIG.icing.speedGain * cf : 0)) * CONFIG.difficulty[settings.difficulty].meterSpeed;
  const [traj, setTraj] = useState<Trajectory>('normal');
  const [tutorial, setTutorial] = useState(!settings.tutorialDone);
  const [touch, setTouch] = useState(false);
  const [caption, setCaption] = useState<Caption | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [snapUi, setSnapUi] = useState<null | 'live' | 'saved' | 'botched'>(null);
  const [hurryLeft, setHurryLeft] = useState<number | null>(null);
  const boothCtx: BoothContext = {
    kickerName,
    distance: setup.distanceYd,
    xp: props.cardTitle?.startsWith('Extra') ?? false,
    windMph: setup.windMph,
    windWords: describeWind(setup.windMph, setup.windToDeg),
    weather: setup.weather ?? 'clear',
    pressure: props.pressure ?? 0,
    tag: props.cardTag ?? null,
    iced: !!props.iced,
    vouched: false,
    hurry: !!props.hurry,
    swirl: !!setup.swirl,
    home,
    seasonLine: null,
    longest: null,
    practice: mode === 'practice',
    ...props.booth,
  };
  const [icing, setIcing] = useState(!!props.iced);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rt = useRef<Runtime>(fresh());
  const camRef = useRef<Camera | null>(null);
  const t0 = useRef(performance.now() / 1000);
  const [ui, setUi] = useState<{ phase: Phase; result: KickResult | null; called: boolean; slow: boolean }>({ phase: 'aim', result: null, called: false, slow: false });
  const [muted, setMuted] = useState(sound.muted);

  const lastName = kickerName.split(' ').slice(-1)[0].toUpperCase();
  const isRecord = (r: KickResult) => !!props.recordLong && r.made && !props.cardTitle?.startsWith('Extra') && setup.distanceYd > props.recordLong.value;
  let clutch = props.clutch ?? null;
  if (import.meta.env.DEV) {
    const force = (window as unknown as { __rtnForce?: { clutch?: 'winner' | 'tie' | 'lead' } }).__rtnForce;
    if (force?.clutch) clutch = force.clutch;
  }
  const boardLines: [string, string] = props.board ?? (session ? ['FREE PRACTICE', `FG ${session.made}/${session.att} · LONG ${session.long || '-'}`] : ['ROAD TO THE NFL', `${setup.distanceYd}-YARD TRY`]);
  const cb = useRef({ onResult, onAgain, onNewSpot, onExit, setup, kicker, mode, eff, speedMult, teamKit, oppKit, kickerNumber, clutch, isRecord, boardLines, home, venue, boothCtx });
  cb.current = { onResult, onAgain, onNewSpot, onExit, setup, kicker, mode, eff, speedMult, teamKit, oppKit, kickerNumber, clutch, isRecord, boardLines, home, venue, boothCtx };
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  const now = () => performance.now() / 1000 - t0.current;

  // New setup or new attempt → reset the scene.
  useEffect(() => {
    rt.current = fresh();
    rt.current.phaseStart = now();
    setUi({ phase: 'aim', result: null, called: false, slow: false });
    setTraj('normal');
    setReplaying(false);
    setSnapUi(null);
    sound.crowd(CONFIG.audio.crowdIdle + cb.current.eff * 0.35, 1.5);
    // Rare bad snaps, more often on a wet field.
    const S = CONFIG.story.snap;
    const wet = setup.weather === 'rain' || setup.weather === 'snow';
    rt.current.badSnap = new Rng(seed * 31 + 7).next() < (wet ? S.badWeather : S.chance);
    setCaption(preKick(cb.current.boothCtx, seed));
    if (props.hurry) {
      rt.current.hurryEnds = now() + CONFIG.story.hurry.seconds;
      setHurryLeft(CONFIG.story.hurry.seconds);
    } else setHurryLeft(null);
    if (props.iced) {
      rt.current.icedUntil = now() + CONFIG.icing.waitS;
      setIcing(true);
      sound.whistle();
      const id = window.setTimeout(() => setIcing(false), CONFIG.icing.waitS * 1000);
      return () => window.clearTimeout(id);
    }
    setIcing(false);
    return undefined;
  }, [setup, seed]);

  // Heartbeat while lining up a big kick.
  useEffect(() => {
    const live = ui.phase === 'aim' || ui.phase === 'power' || ui.phase === 'accuracy';
    sound.heartbeat(live && eff > 0.3 ? eff : 0);
    sound.chant(live && (props.pressure ?? 0) >= 0.35 && mode === 'game' && !venue.dome ? (home ? 'home' : 'road') : null);
    return () => {
      sound.heartbeat(0);
      sound.chant(null);
    };
  }, [ui.phase, eff]);

  // Booth captions follow the kick.
  useEffect(() => {
    if (ui.phase === 'flight' && !ui.called) setCaption(inFlight(boothCtx, seed, rt.current.trajectory));
    if (ui.called && ui.result) setCaption(afterKick(boothCtx, ui.result, seed));
  }, [ui.phase, ui.called]);

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
        if (t < s.icedUntil) break;
        s.hurryEnds = null;
        setHurryLeft(null);
        setPhase('power');
        break;
      case 'snap':
        // Got the ball down in time
        if (s.snapAt !== null && t - s.snapAt <= CONFIG.story.snap.windowS) launch(t, CONFIG.story.snap.recoveredShift, 1, 'saved');
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
          const force = (window as unknown as { __rtnForce?: { accuracy?: number; aimX?: number; badSnap?: boolean } }).__rtnForce;
          if (force?.accuracy !== undefined) s.accuracyLocked = force.accuracy;
          if (force?.aimX !== undefined) s.aimX = force.aimX;
          if (force?.badSnap) s.badSnap = true;
        }
        if (s.badSnap) {
          s.snapAt = t;
          setSnapUi('live');
          sound.thud(0.5);
          setPhase('snap');
          break;
        }
        launch(t, 0, 1, null);
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
        if (s.replayAt !== null) {
          s.replayAt = null;
          s.replayDone = true;
          setReplaying(false);
          break;
        }
        cb.current.onAgain();
        break;
    }
  }, [seed]);

  /** Resolve the kick and start the approach. A bad snap shifts the strike. */
  function launch(t: number, shift: number, powerScale: number, snap: 'saved' | 'botched' | null) {
    const s = rt.current;
    if (snap) setSnapUi(snap);
    const dirShift = shift ? (Math.random() < 0.5 ? -1 : 1) * shift : 0;
    const { setup: su, kicker: k } = cb.current;
    const r = resolveKick(
      { ...su, rush: cb.current.eff },
      { aimXFt: s.aimX, power: (s.powerLocked ?? 0) * powerScale, accuracy: Math.max(-1, Math.min(1, (s.accuracyLocked ?? 0) + dirShift)), trajectory: s.trajectory },
      k,
      new Rng(seed * 7919 + 17),
    );
    s.result = r;
    s.lockAt = t;
    s.snapAt = null;
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
  }

  const startReplay = () => {
    const s = rt.current;
    if (!s.result || s.result.crossXFt === null) return;
    s.replayAt = now();
    setReplaying(true);
  };

  const cycleTraj = (dir: 1 | -1) => {
    const order: Trajectory[] = ['low', 'normal', 'high'];
    const s = rt.current;
    if (s.phase !== 'aim') return;
    const i = Math.max(0, Math.min(2, order.indexOf(s.trajectory) + dir));
    s.trajectory = order[i];
    setTraj(order[i]);
  };
  const setTrajectory = (t: Trajectory) => {
    if (rt.current.phase !== 'aim') return;
    rt.current.trajectory = t;
    setTraj(t);
  };

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
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        cycleTraj(1);
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        cycleTraj(-1);
      } else if (e.code === 'KeyR' && s.phase === 'result' && s.replayAt === null) {
        startReplay();
      } else if (e.code === 'KeyN' && cb.current.mode === 'practice' && (s.phase === 'result' || s.phase === 'aim')) {
        cb.current.onNewSpot();
      } else if (e.code === 'KeyM') {
        sound.start();
        setMuted(sound.toggleMute());
      } else if (e.code === 'Escape' && cb.current.mode === 'practice') {
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
      const pt = (t - s.phaseStart) * cb.current.speedMult;

      if (s.phase === 'aim' && s.hurryEnds !== null) {
        const left = s.hurryEnds - t;
        if (left <= 0) advance();
        else if (Math.ceil(left) !== Math.ceil(left + dt)) setHurryLeft(Math.ceil(left));
      }
      if (s.phase === 'snap' && s.snapAt !== null && t - s.snapAt > CONFIG.story.snap.windowS) launch(t, CONFIG.story.snap.botchedShift, 0.92, 'botched');
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
          // Pressure makes the marker wobble.
          const wob = cb.current.eff * CONFIG.pressure.shake;
          s.accuracy = Math.max(-1, Math.min(1, s.accuracy + wob * (Math.sin(t * 23) + 0.6 * Math.sin(t * 37 + 1))));
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
          react(r, cb.current.home);
          cb.current.onResult(r);
          if (r.made && (cb.current.clutch || cb.current.isRecord(r))) {
            s.celebrateAt = t;
            s.shakeUntil = t + 0.5;
            if (cb.current.home) {
              sound.roar(1.5);
              for (const ft of FIREWORK_TIMES) timers.current.push(window.setTimeout(() => sound.firework(), ft * 1000));
            }
            setUi((u) => ({ ...u }));
          }
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
          sound.crowd(CONFIG.audio.crowdIdle + cb.current.eff * 0.2, 3);
          const big = !!cb.current.clutch || r.slowMo || cb.current.isRecord(r) || (r.made && cb.current.setup.distanceYd >= 50) || r.outcome === 'BLOCKED';
          if (big && !s.replayDone && r.crossXFt !== null && cb.current.mode === 'game') {
            s.replayAt = t + 0.6;
            setReplaying(true);
          }
        }
        const want = Math.max(0, ball.z - 14) * 0.45;
        s.lookBoost += (want - s.lookBoost) * Math.min(1, dt * 3);
      } else {
        s.lookBoost += (0 - s.lookBoost) * Math.min(1, dt * 3);
      }

      // Replay: the same flight from the end zone, at half speed.
      let replayCam = false;
      if (s.replayAt !== null && s.result && t >= s.replayAt) {
        const path = s.result.path;
        const fi = (t - s.replayAt) * 60 * 0.5;
        const end = Math.min(path.length - 1, s.result.decideIndex + 55);
        if (fi >= end) {
          s.replayAt = null;
          s.replayDone = true;
          setReplaying(false);
        } else {
          const i = Math.floor(fi);
          const f = fi - i;
          const a = path[i];
          const b = path[Math.min(path.length - 1, i + 1)];
          ball = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
          tracer = path.slice(0, i + 1).concat([ball]);
          spin = fi * 0.42;
          held = false;
          replayCam = true;
        }
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
      const cam = replayCam && s.result ? buildReplayCamera(w, h, su, ball, s.result.crossXFt ?? 0) : buildCamera(w, h, su, s.lookBoost, shake, t, slow);
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
        teamKit: cb.current.teamKit,
        oppKit: cb.current.oppKit,
        kickerNumber: cb.current.kickerNumber,
        kickerName: kickerName,
        pressure: cb.current.eff,
        celebrateT: s.celebrateAt === null ? null : t - s.celebrateAt,
        board: cb.current.boardLines,
        boardFlash:
          s.celebrateAt === null
            ? null
            : cb.current.clutch === 'winner'
              ? `${lastName} WINS IT!`
              : cb.current.clutch === 'tie'
                ? `${lastName} TIES IT!`
                : cb.current.clutch === 'lead'
                  ? 'GO-AHEAD KICK!'
                  : 'NEW RECORD!',
        endzone: props.endzone ?? '',
        venue: cb.current.venue,
        snapT: s.phase === 'snap' && s.snapAt !== null ? t - s.snapAt : null,
        replay: replayCam,
      };
      drawScene(ctx, cam, w, h, view);
      if (s.slowBlend < 0.03 && !replayCam) drawMeters(ctx, w, h, view);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [accent, advance]);

  // Mouse / touch aim: find the aim x whose marker sits under the pointer.
  const onPointerMove = (e: React.PointerEvent) => {
    const s = rt.current;
    const cam = camRef.current;
    if (s.phase !== 'aim' || !cam) return;
    if (e.pointerType === 'touch' && e.type === 'pointermove' && e.buttons === 0) return;
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
  const hint = icing || tutorial
    ? ''
    : ui.phase === 'aim'
      ? touch
        ? 'Read the wind · drag to aim · tap Set aim'
        : 'Read the wind · ← → or mouse to aim · ↑ ↓ high or low · SPACE / click to set'
      : ui.phase === 'power'
        ? 'SPACE to stop near the top · past the line = more leg, smaller sweet spot'
        : ui.phase === 'accuracy'
          ? 'SPACE in the green'
          : '';
  const baseCall = ui.called && ui.result ? callText(ui.result) : null;
  const call =
    baseCall && ui.result?.made && clutch
      ? { big: clutch === 'winner' ? `${lastName} WINS IT!` : clutch === 'tie' ? `${lastName} TIES IT!` : `${lastName} PUTS THEM AHEAD!`, good: true, clutch: true }
      : baseCall
        ? { ...baseCall, clutch: false }
        : null;
  const recordCall = ui.called && ui.result && isRecord(ui.result) ? `New ${props.recordLong!.scope} record · ${setup.distanceYd} yards` : null;
  const level = CONFIG.levels[setup.level];

  return (
    <div className={`scene ${ui.slow ? 'slowmo' : ''}`} ref={wrapRef} style={{ '--accent': accent } as CSSProperties}>
      <canvas
        ref={canvasRef}
        className="scene-canvas"
        onPointerMove={onPointerMove}
        onPointerDown={(e) => {
          // Touch: tapping in the aim step moves the target; the Set aim button locks it.
          if (e.pointerType === 'touch' || e.pointerType === 'pen') {
            if (!touch) setTouch(true);
            if (rt.current.phase === 'aim') {
              onPointerMove(e);
              return;
            }
          }
          advance();
        }}
      />

      {props.bug ??
        (session && (
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
        ))}

      {icing && props.iced && (
        <div className="icing">
          <div className="icing-big">Timeout</div>
          <div className="icing-sub">{props.iced}</div>
        </div>
      )}

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
          <div className="wind-desc">
            {describeWind(setup.windMph, setup.windToDeg)}
            {setup.swirl && setup.windMph >= 4 && <span className="swirl-tag">Swirling</span>}
          </div>
        </div>
      </div>

      {!call && (
        <div className="lower-third">
          <div className="lt-accent" />
          <div className="lt-body">
            <div className="lt-name">
              {kickerName}
              {props.cardTag && <span className="lt-tag">{props.cardTag}</span>}
            </div>
            <div className="lt-title">{props.cardTitle ?? `${setup.distanceYd}-yard field goal`}</div>
            <div className="lt-row">
              <span>{HASH_LABEL[setup.hash]}</span>
              <span>Wind {Math.round(setup.windMph)} mph · {describeWind(setup.windMph, setup.windToDeg)}</span>
              <span>{props.weatherLabel ?? CONFIG.weather[setup.weather ?? 'clear'].label}</span>
            </div>
          </div>
        </div>
      )}

      {hint && <div className="hint">{hint}</div>}

      {caption && !replaying && !ui.slow && (
        <div className={`booth ${caption.who === 'Analyst' ? 'analyst' : ''}`} key={caption.text}>
          <span className="booth-who">{caption.who}</span>
          <span className="booth-text">{caption.text}</span>
        </div>
      )}

      {(ui.phase === 'aim' || ui.phase === 'power' || ui.phase === 'accuracy') && (
        <div className={`traj ${ui.phase !== 'aim' ? 'locked' : ''}`}>
          {(['low', 'normal', 'high'] as Trajectory[]).map((t) => (
            <button key={t} className={traj === t ? 'on' : ''} onClick={() => setTrajectory(t)} title={t === 'high' ? 'Clears the rush, hangs in the wind, a little shorter' : t === 'low' ? 'Cuts through the wind, easier to block' : 'Full distance'}>
              {t === 'low' ? '↓ Low' : t === 'high' ? '↑ High' : 'Normal'}
            </button>
          ))}
        </div>
      )}

      {hurryLeft !== null && ui.phase === 'aim' && (
        <div className="hurry">
          <div className="hurry-n">{hurryLeft}</div>
          <div className="hurry-l">Clock running · aim fast</div>
        </div>
      )}

      {snapUi && ui.phase !== 'result' && (
        <div className={`snap snap-${snapUi}`}>
          {snapUi === 'live' ? (
            <>
              <div className="snap-big">Bad snap!</div>
              <div className="snap-sub">{touch ? 'Tap' : 'Press SPACE'} now to get it down</div>
              <div className="snap-bar">
                <div style={{ animationDuration: `${CONFIG.story.snap.windowS}s` }} />
              </div>
            </>
          ) : (
            <div className="snap-sub">{snapUi === 'saved' ? 'Holder gets it down!' : 'The hold is a mess!'}</div>
          )}
        </div>
      )}

      {touch && ui.phase === 'aim' && (
        <button className="set-aim" onClick={() => advance()}>
          Set aim
        </button>
      )}

      {replaying && (
        <div className="replay-tag">
          <span className="rec-dot" /> Replay
        </div>
      )}

      {tutorial && (ui.phase === 'aim' || ui.phase === 'power' || ui.phase === 'accuracy' || ui.phase === 'flight') && (
        <div className="tutorial">
          <div className="tut-step">How to kick · {ui.phase === 'aim' ? '1 of 4' : ui.phase === 'power' ? '2 of 4' : ui.phase === 'accuracy' ? '3 of 4' : '4 of 4'}</div>
          <div className="tut-text">
            {ui.phase === 'aim'
              ? `Read the wind on the dial and the flags on the uprights, then move the target to play it. ${touch ? 'Drag' : 'Use ← → or the mouse'}. Pick a kick: High clears the rush but drifts more; Low cuts through wind but can get blocked. ${touch ? 'Tap Set aim' : 'Press Space or click'} when you're lined up.`
              : ui.phase === 'power'
                ? 'The power meter climbs. Stop it near the white line. Going past it adds distance but shrinks the green sweet spot on the next meter.'
                : ui.phase === 'accuracy'
                  ? 'Stop the marker in the green. Early or late hooks or slices the ball. Big moments make the meters faster and shakier.'
                  : 'Watch it fly. Close calls go to slow motion. Space skips ahead.'}
          </div>
          <button
            className="ghost small"
            onClick={() => {
              writeSettings({ tutorialDone: true });
              setTutorial(false);
            }}
          >
            Got it, don't show again
          </button>
        </div>
      )}

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

      {call && ui.result && !replaying && (
        <div className={`call ${call.good ? 'good' : 'miss'} ${call.clutch ? 'clutch' : ''}`} key={seed}>
          <div className="call-big">{call.big}</div>
          {recordCall && <div className="call-record">{recordCall}</div>}
          <div className="call-sub">{detailText(ui.result, setup)}</div>
          {ui.phase === 'result' && mode === 'game' && (
            <div className="actions">
              <button onClick={() => onAgain()}>
                <kbd>Space</kbd> {props.continueLabel ?? 'Continue'}
              </button>
              {ui.result.crossXFt !== null && (
                <button onClick={startReplay}>
                  <kbd>R</kbd> Replay
                </button>
              )}
            </div>
          )}
          {ui.phase === 'result' && mode === 'practice' && (
            <div className="actions">
              <button onClick={() => onAgain()}>
                <kbd>Space</kbd> Kick again
              </button>
              <button onClick={() => onNewSpot()}>
                <kbd>N</kbd> New spot
              </button>
              {ui.result.crossXFt !== null && (
                <button onClick={startReplay}>
                  <kbd>R</kbd> Replay
                </button>
              )}
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

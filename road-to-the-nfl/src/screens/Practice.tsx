import { useMemo, useState, type CSSProperties } from 'react';
import { sound } from '../audio/sound';
import { CONFIG, type LevelKey } from '../config';
import { KickScene, type SessionLine } from '../kick/KickScene';
import { describeWind, maxRangeYd, type Hash, type KickResult, type KickSetup } from '../kick/physics';

const DIRS: { deg: number; label: string }[] = [
  { deg: 180, label: 'In your face' },
  { deg: 135, label: 'In face, L→R' },
  { deg: 90, label: 'Left → right' },
  { deg: 45, label: 'At back, L→R' },
  { deg: 0, label: 'At your back' },
  { deg: 315, label: 'At back, R→L' },
  { deg: 270, label: 'Right → left' },
  { deg: 225, label: 'In face, R→L' },
];

interface LogEntry {
  distanceYd: number;
  made: boolean;
}

function randomSetup(level: LevelKey): KickSetup {
  const range = maxRangeYd(CONFIG.practice.kicker);
  const lo = CONFIG.levels[level].xpDistanceYd;
  const hi = Math.round(range + 4);
  const r = Math.random();
  const windMph = r < 0.2 ? 0 : Math.round(Math.random() ** 1.4 * 22);
  return {
    level,
    distanceYd: Math.round(lo + (hi - lo) * Math.random() ** 0.8),
    hash: (['L', 'M', 'R'] as Hash[])[Math.floor(Math.random() * 3)],
    windMph,
    windToDeg: DIRS[Math.floor(Math.random() * DIRS.length)].deg,
  };
}

export function Practice({ onExit }: { onExit: () => void }) {
  const P = CONFIG.practice;
  const [setup, setSetup] = useState<KickSetup>({ level: 'college', distanceYd: 40, hash: 'M', windMph: 8, windToDeg: 135 });
  const [kicking, setKicking] = useState(false);
  const [seed, setSeed] = useState(1);
  const [log, setLog] = useState<LogEntry[]>([]);

  const session: SessionLine = useMemo(() => {
    const made = log.filter((l) => l.made);
    return { label: 'FREE PRACTICE', made: made.length, att: log.length, long: made.reduce((m, l) => Math.max(m, l.distanceYd), 0) };
  }, [log]);

  const range = maxRangeYd(P.kicker);
  const set = <K extends keyof KickSetup>(k: K, v: KickSetup[K]) => setSetup((s) => ({ ...s, [k]: v }));

  if (kicking) {
    return (
      <KickScene
        setup={setup}
        kicker={P.kicker}
        kickerName={P.kickerName}
        endzone="PRACTICE"
        accent={P.accent}
        session={session}
        seed={seed}
        onResult={(r: KickResult) => setLog((l) => [...l, { distanceYd: setup.distanceYd, made: r.made }])}
        onAgain={() => setSeed((s) => s + 1)}
        onNewSpot={() => {
          setSetup((s) => randomSetup(s.level));
          setSeed((s) => s + 1);
        }}
        onExit={() => setKicking(false)}
      />
    );
  }

  const buckets = [
    [0, 29],
    [30, 39],
    [40, 49],
    [50, 99],
  ].map(([lo, hi]) => {
    const inB = log.filter((l) => l.distanceYd >= lo && l.distanceYd <= hi);
    return { label: hi === 99 ? `${lo}+` : `${lo}–${hi}`, made: inB.filter((l) => l.made).length, att: inB.length };
  });

  return (
    <div className="screen setup" style={{ '--accent': P.accent } as CSSProperties}>
      <header className="screen-head">
        <button className="link" onClick={onExit}>
          ← Menu
        </button>
        <h1>Free Practice</h1>
        <div className="sub">
          {P.kickerName} · every rating {P.kicker.power} · range about {Math.round(range)} yds on a calm day
        </div>
      </header>

      <div className="setup-grid">
        <section className="card">
          <h2>Level</h2>
          <div className="seg">
            {(Object.keys(CONFIG.levels) as LevelKey[]).map((k) => (
              <button key={k} className={setup.level === k ? 'on' : ''} onClick={() => set('level', k)}>
                {CONFIG.levels[k].label}
              </button>
            ))}
          </div>
          <p className="note">
            Uprights {fmtFt(CONFIG.levels[setup.level].uprightWidthFt)} apart · hashes {fmtFt(CONFIG.levels[setup.level].hashWidthFt)} apart
          </p>

          <h2>
            Distance <span className="val">{setup.distanceYd} yds</span>
          </h2>
          <input
            type="range"
            min={P.minDistanceYd}
            max={P.maxDistanceYd}
            value={setup.distanceYd}
            onChange={(e) => set('distanceYd', Number(e.target.value))}
          />
          <div className="quick">
            {[CONFIG.levels[setup.level].xpDistanceYd, 30, 40, 45, 50, 55, 60, 65, 70].map((d) => (
              <button key={d} className={setup.distanceYd === d ? 'on' : ''} onClick={() => set('distanceYd', d)}>
                {d === CONFIG.levels[setup.level].xpDistanceYd ? `PAT ${d}` : d}
              </button>
            ))}
          </div>

          <h2>Hash</h2>
          <div className="seg">
            {(['L', 'M', 'R'] as Hash[]).map((h) => (
              <button key={h} className={setup.hash === h ? 'on' : ''} onClick={() => set('hash', h)}>
                {h === 'L' ? 'Left' : h === 'M' ? 'Middle' : 'Right'}
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>
            Wind <span className="val">{setup.windMph} mph</span>
          </h2>
          <input type="range" min={0} max={P.maxWindMph} value={setup.windMph} onChange={(e) => set('windMph', Number(e.target.value))} />
          <div className="rose">
            <div className="rose-posts">GOALPOSTS ▲</div>
            {DIRS.map((d) => {
              const a = (d.deg * Math.PI) / 180;
              return (
                <button
                  key={d.deg}
                  title={d.label}
                  className={`rose-btn ${setup.windToDeg === d.deg ? 'on' : ''}`}
                  style={{ left: `${50 + Math.sin(a) * 38}%`, top: `${50 - Math.cos(a) * 38}%`, transform: `translate(-50%,-50%) rotate(${d.deg}deg)` }}
                  onClick={() => set('windToDeg', d.deg)}
                >
                  ↑
                </button>
              );
            })}
            <div className="rose-center">YOU</div>
          </div>
          <p className="note">Arrows show where the wind blows. Now: {describeWind(setup.windMph, setup.windToDeg)}.</p>
        </section>

        <section className="card">
          <h2>This session</h2>
          <div className="buckets">
            {buckets.map((b) => (
              <div key={b.label} className="bucket">
                <div className="bucket-l">{b.label}</div>
                <div className="bucket-v">{b.att ? `${b.made}/${b.att}` : '—'}</div>
              </div>
            ))}
          </div>
          <div className="go-row">
            <button className="ghost" onClick={() => setSetup(randomSetup(setup.level))}>
              Random situation
            </button>
            <button
              className="primary"
              onClick={() => {
                sound.start();
                setKicking(true);
              }}
            >
              Kick
            </button>
          </div>
          <p className="note">In the scene: Space or click to set aim, power and accuracy. N for a new random spot, Esc to come back here.</p>
        </section>
      </div>
    </div>
  );
}

function fmtFt(ft: number): string {
  const whole = Math.floor(ft + 1e-6);
  const inches = Math.round((ft - whole) * 12);
  return inches ? `${whole} ft ${inches} in` : `${whole} ft`;
}

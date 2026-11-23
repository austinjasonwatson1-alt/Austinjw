import { useState, type CSSProperties } from 'react';
import { CONFIG } from '../../config';
import { accentFor, kitFor } from '../../career/look';
import { autoMakeProb } from '../../career/progression';
import type { Career } from '../../career/types';
import { KickScene } from '../../kick/KickScene';
import type { KickSetup } from '../../kick/physics';

export interface SeriesKick {
  setup: KickSetup;
  pressure?: number;
  label?: string;
}

interface Props {
  title: string;
  intro: string;
  kicks: SeriesKick[];
  career: Career;
  rival?: { name: string; results: boolean[] };
  /** Text for the results screen given my makes. */
  verdict?: (makes: boolean[]) => string;
  onDone: (makes: boolean[]) => void;
  onBack?: () => void;
}

export function KickSeries({ title, intro, kicks, career, rival, verdict, onDone, onBack }: Props) {
  const [stage, setStage] = useState<'intro' | 'kick' | 'done'>('intro');
  const [i, setI] = useState(0);
  const [makes, setMakes] = useState<boolean[]>([]);
  const accent = accentFor(career.team);
  const P = CONFIG.practice;

  const simAll = () => {
    const out = kicks.map((k) => Math.random() < autoMakeProb(career.skills, k.setup.distanceYd, k.setup.weather ?? 'clear', k.setup.windMph, k.pressure ?? 0));
    setMakes(out);
    setStage('done');
  };

  if (stage === 'intro' || stage === 'done') {
    const m = makes.filter(Boolean).length;
    return (
      <div className="screen panel-screen" style={{ '--accent': accent } as CSSProperties}>
        <div className="panel-wrap">
          <div className="eyebrow">{stage === 'intro' ? 'Up next' : 'Results'}</div>
          <h1 className="panel-title">{title}</h1>
          {stage === 'intro' && <p className="lede">{intro}</p>}
          <div className="series-grid">
            {kicks.map((k, idx) => {
              const mine = stage === 'done' ? makes[idx] : undefined;
              const theirs = rival && stage === 'done' ? rival.results[idx] : undefined;
              return (
                <div key={idx} className="series-kick">
                  <div className="sk-d">{k.setup.distanceYd}</div>
                  <div className="sk-meta">
                    {k.label ?? `${k.setup.hash === 'M' ? 'Middle' : k.setup.hash === 'L' ? 'Left hash' : 'Right hash'}${k.setup.windMph ? ` · ${k.setup.windMph} mph` : ''}`}
                  </div>
                  {mine !== undefined && <div className={`sk-res ${mine ? 'good' : 'miss'}`}>{mine ? 'Good' : 'Miss'}</div>}
                  {theirs !== undefined && <div className={`sk-rival ${theirs ? 'good' : 'miss'}`}>{rival!.name.split(' ')[1]}: {theirs ? 'Good' : 'Miss'}</div>}
                </div>
              );
            })}
          </div>
          {stage === 'done' && (
            <div className="series-score">
              You {m}/{kicks.length}
              {rival && ` · ${rival.name} ${rival.results.filter(Boolean).length}/${kicks.length}`}
              {verdict && <div className="series-verdict">{verdict(makes)}</div>}
            </div>
          )}
          <div className="btn-row">
            {stage === 'intro' ? (
              <>
                {onBack && (
                  <button className="ghost" onClick={onBack}>
                    Back
                  </button>
                )}
                <button className="ghost" onClick={simAll}>
                  Sim it
                </button>
                <button className="primary" onClick={() => setStage('kick')}>
                  Start kicking
                </button>
              </>
            ) : (
              <button className="primary" onClick={() => onDone(makes)}>
                Continue
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const k = kicks[i];
  const m = makes.filter(Boolean).length;
  const r = rival ? rival.results.slice(0, i).filter(Boolean).length : 0;
  return (
    <KickScene
      key={i}
      mode="game"
      setup={k.setup}
      kicker={career.skills}
      kickerName={career.kicker.name}
      kickerNumber={career.kicker.number}
      accent={accent}
      teamKit={kitFor(career.team, P.team)}
      pressure={k.pressure ?? 0}
      cardTag={k.label}
      endzone={career.team ? career.team.name.split(' ').slice(-1)[0].toUpperCase() : ''}
      board={[title.toUpperCase(), `KICK ${i + 1} OF ${kicks.length} · ${m} MADE`]}
      seed={career.seed + i * 13 + makes.length}
      continueLabel={i < kicks.length - 1 ? 'Next kick' : 'See results'}
      bug={
        <div className="bug">
          <div className="bug-team">{title.toUpperCase()}</div>
          <div className="bug-cell">
            <span className="bug-k">KICK</span>
            <span className="bug-v">
              {i + 1}/{kicks.length}
            </span>
          </div>
          <div className="bug-cell">
            <span className="bug-k">YOU</span>
            <span className="bug-v">{m}</span>
          </div>
          {rival && (
            <div className="bug-cell">
              <span className="bug-k">{rival.name.split(' ')[1]?.toUpperCase()}</span>
              <span className="bug-v">{r}</span>
            </div>
          )}
        </div>
      }
      onResult={(res) => setMakes((prev) => [...prev.slice(0, i), res.made])}
      onAgain={() => {
        if (i < kicks.length - 1) setI(i + 1);
        else setStage('done');
      }}
    />
  );
}

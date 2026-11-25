import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { sound } from '../../audio/sound';
import { CONFIG } from '../../config';
import { gameSetup, recordGame, type GameSummary } from '../../career/career';
import { GameSim, type AskMoment, type KickMoment, type TickerLine } from '../../career/gamesim';
import { applyPress, effectiveSkills, hasTrait } from '../../career/story';
import { accentFor, kitFor, oppKitFor } from '../../career/look';
import type { Career, SchedGame } from '../../career/types';
import { KickScene } from '../../kick/KickScene';
import { describeWind, type KickSetup } from '../../kick/physics';
import { longTargets } from '../../career/records';
import { ScoreBug } from './ScoreBug';

interface Props {
  career: Career;
  game: SchedGame;
  onFinish: (c: Career) => void;
}

const Q = ['', '1st', '2nd', '3rd', '4th', 'OT'];

export function GameDay({ career, game, onFinish }: Props) {
  const sim = useMemo(() => new GameSim(gameSetup(career, game)), [career, game]);
  const [lines, setLines] = useState<TickerLine[]>([]);
  const [phase, setPhase] = useState<'pregame' | 'ticker' | 'ask' | 'kickIntro' | 'kick' | 'post'>('pregame');
  const [ask, setAsk] = useState<AskMoment | null>(null);
  const [moment, setMoment] = useState<KickMoment | null>(null);
  const [fast, setFast] = useState(career.role !== 'starter');
  const [summary, setSummary] = useState<{ c: Career; s: GameSummary } | null>(null);
  const madeRef = useRef(false);
  const kickNo = useRef(0);
  const tickerRef = useRef<HTMLDivElement>(null);
  const accent = accentFor(career.team);
  const team = career.team!;
  const lvl = CONFIG.levels[career.level];

  // Ticker loop
  useEffect(() => {
    if (phase !== 'ticker') return;
    const id = window.setInterval(
      () => {
        const step = sim.next();
        if (step.line) setLines((l) => [...l, step.line!]);
        if (step.ask) {
          window.clearInterval(id);
          setAsk(step.ask);
          setFast(false);
          setPhase('ask');
          return;
        }
        if (step.kick) {
          setMoment(step.kick);
          setFast(false);
          setPhase('kickIntro');
        }
        if (step.done) {
          window.clearInterval(id);
          const res = recordGame(career, sim);
          setSummary({ c: res.career, s: res.summary });
          setPhase('post');
        }
      },
      fast ? 70 : 620,
    );
    return () => window.clearInterval(id);
  }, [phase, fast, sim, career]);

  useEffect(() => {
    tickerRef.current?.scrollTo({ top: tickerRef.current.scrollHeight, behavior: 'smooth' });
  }, [lines]);

  useEffect(() => {
    if (phase !== 'kickIntro') return;
    const id = window.setTimeout(() => setPhase('kick'), 1500);
    return () => window.clearTimeout(id);
  }, [phase]);

  const last = lines[lines.length - 1];
  const usScore = last?.us ?? 0;
  const themScore = last?.them ?? 0;

  if (phase === 'kick' && moment) {
    const setup: KickSetup = {
      level: career.level,
      distanceYd: moment.distance,
      hash: moment.hash,
      windMph: Math.max(0, game.windMph + ((kickNo.current * 7) % 5) - 2),
      windToDeg: game.windToDeg,
      weather: game.weather,
      swirl: !!game.swirl,
    };
    const s = career.season;
    return (
      <KickScene
        key={`k${kickNo.current}`}
        mode="game"
        setup={setup}
        kicker={effectiveSkills(career, game.weather)}
        home={game.home}
        hurry={moment.hurry}
        icingImmune={hasTrait(career, 'iceWater')}
        venue={{ time: game.time ?? 'night', dome: !!game.dome, snowField: game.weather === 'snow' }}
        booth={{
          vouched: moment.vouched,
          seasonLine: s && s.fga ? `${s.fgm} of ${s.fga} on field goals this season` : null,
          longest: s?.long ?? null,
        }}
        kickerName={career.kicker.name}
        kickerNumber={career.kicker.number}
        accent={accent}
        teamKit={kitFor(team, CONFIG.practice.team)}
        oppKit={oppKitFor(game.opp)}
        pressure={moment.pressure}
        iced={moment.iced ? `${game.opp.name} call timeout to ice ${career.kicker.name.split(' ')[0]}.` : null}
        clutch={moment.tag === 'GAME-WINNER' ? 'winner' : moment.tag === 'TO TIE' ? 'tie' : moment.tag === 'GO-AHEAD' ? 'lead' : null}
        recordLong={moment.xp ? null : longTargets(career)}
        endzone={(game.home ? team : game.opp).name.split(' ').slice(-1)[0].toUpperCase()}
        board={[
          game.home ? `${game.opp.short} ${moment.them}   ${team.short} ${moment.us}` : `${team.short} ${moment.us}   ${game.opp.short} ${moment.them}`,
          moment.q >= 5 ? 'OVERTIME' : `${['', '1ST', '2ND', '3RD', '4TH'][moment.q]} ${moment.clock}`,
        ]}
        cardTitle={moment.title}
        cardTag={moment.tag ?? undefined}
        weatherLabel={`${CONFIG.weather[game.weather].label} · ${game.tempF}°`}
        seed={career.seed + game.week * 101 + kickNo.current}
        bug={<ScoreBug us={team} them={game.opp} usScore={moment.us} themScore={moment.them} q={moment.q} clock={moment.clock} home={game.home} />}
        onResult={(r) => {
          madeRef.current = r.made;
        }}
        onAgain={() => {
          kickNo.current += 1;
          sim.answer(madeRef.current);
          setMoment(null);
          setPhase('ticker');
          sound.crowd(CONFIG.audio.crowdIdle, 1);
        }}
      />
    );
  }

  if (phase === 'post' && summary) return <PostGame career={career} summary={summary.s} after={summary.c} onContinue={(c) => onFinish(c)} />;

  const header = (
    <div className="gd-head">
      <ScoreBug us={team} them={game.opp} usScore={usScore} themScore={themScore} q={last?.q ?? 1} clock={last?.clock ?? (career.level === 'hs' ? '12:00' : '15:00')} home={game.home} />
      <div className="gd-meta">
        {game.label ?? `Week ${game.week}`} · {CONFIG.weather[game.weather].label}, {game.tempF}° · Wind {game.windMph} mph {game.windMph ? `(${describeWind(game.windMph, game.windToDeg).toLowerCase()})` : ''}
      </div>
    </div>
  );

  return (
    <div className="screen gameday" style={{ '--accent': accent } as CSSProperties}>
      {header}
      {phase === 'pregame' ? (
        <div className="panel-wrap">
          <div className="eyebrow">{game.label ?? `${lvl.label} · Week ${game.week}`}</div>
          <h1 className="panel-title">
            {game.home ? `${game.opp.name} at ${team.name}` : `${team.name} at ${game.opp.name}`}
          </h1>
          <p className="lede">
            {career.role === 'starter'
              ? `You're the kicker. The game sims drive by drive and stops whenever the coach sends you out. Coach trust: ${career.trust}.`
              : `You're the backup behind ${career.rival?.name}. The game sims quickly; stay ready.`}
          </p>
          <div className="btn-row">
            <button
              className="primary"
              onClick={() => {
                sound.start();
                setPhase('ticker');
              }}
            >
              Kickoff
            </button>
          </div>
        </div>
      ) : (
        <div className="ticker-wrap">
          <div className="ticker" ref={tickerRef}>
            {lines.map((l, i) => (
              <div key={i} className={`tk tk-${l.tone}`}>
                <span className="tk-clock">
                  {Q[l.q] ?? ''} {l.q < 5 ? l.clock : ''}
                </span>
                <span className="tk-text">{l.text}</span>
                <span className="tk-score">
                  {l.us}-{l.them}
                </span>
              </div>
            ))}
            {phase === 'ask' && ask && (
              <div className="ask">
                <div className="ask-who">Coach</div>
                <div className="ask-q">
                  "{ask.distance} yards. That's past where I'd normally send you. Can you make it?"
                </div>
                <p className="note">
                  {ask.spot} · {ask.q >= 5 ? 'OT' : `${['', '1st', '2nd', '3rd', '4th'][ask.q]} ${ask.clock}`} · {ask.us}-{ask.them}. Say yes and make it: big trust gain. Say yes and miss: it craters. Say no: he punts, and remembers.
                </p>
                <div className="btn-row">
                  <button
                    className="primary"
                    onClick={() => {
                      const step = sim.answerAsk(true);
                      if (step.line) setLines((l) => [...l, step.line!]);
                      setAsk(null);
                      setPhase('ticker');
                    }}
                  >
                    "I've got it"
                  </button>
                  <button
                    className="ghost"
                    onClick={() => {
                      const step = sim.answerAsk(false);
                      if (step.line) setLines((l) => [...l, step.line!]);
                      setAsk(null);
                      setPhase('ticker');
                    }}
                  >
                    "Not from there"
                  </button>
                </div>
              </div>
            )}
            {phase === 'kickIntro' && moment && (
              <div className="tk-moment">
                <div className="tkm-big">{moment.xp ? 'Extra point' : `${moment.distance}-yard try`}</div>
                <div className="tkm-sub">
                  {moment.tag ? `${moment.tag} · ` : ''}Field goal unit, take the field
                </div>
              </div>
            )}
          </div>
          {phase === 'ticker' && (
            <div className="btn-row">
              <button className="ghost" onClick={() => setFast((f) => !f)}>
                {fast ? 'Normal speed' : career.role === 'starter' ? 'Fast-forward to my next kick' : 'Fast-forward'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PostGame({ career, summary, after: after0, onContinue }: { career: Career; summary: GameSummary; after: Career; onContinue: (c: Career) => void }) {
  const [after, setAfter] = useState(after0);
  const [answered, setAnswered] = useState<number | null>(null);
  const press = summary.press;
  const g = summary.game;
  const r = g.result!;
  const won = r.us > r.them;
  const accent = accentFor(career.team);
  const fgs = r.kicks.filter((k) => !k.xp);
  const xps = r.kicks.filter((k) => k.xp);
  return (
    <div className="screen panel-screen" style={{ '--accent': accent } as CSSProperties}>
      <div className="panel-wrap">
        <div className="eyebrow">{g.label ?? `Week ${g.week}`} · Final</div>
        <h1 className={`panel-title ${won ? '' : 'loss'}`}>
          {won ? 'Win' : r.us < r.them ? 'Loss' : 'Tie'} · {career.team!.short} {r.us}, {g.opp.short} {r.them}
          {r.ot ? ' (OT)' : ''}
        </h1>
        <div className="post-grid">
          <section className="card">
            <h2>Your kicks</h2>
            {r.kicks.length === 0 ? (
              <p className="note">{career.role === 'starter' ? 'No kicks today.' : `You watched from the sideline.${after.role === 'starter' ? ' Next week, the job is yours.' : ''}`}</p>
            ) : (
              <>
                <div className="kick-chart">
                  <div className="kc-axis">
                    {[20, 30, 40, 50, 60].map((d) => (
                      <span key={d} style={{ left: `${((d - 15) / 50) * 100}%` }}>
                        {d}
                      </span>
                    ))}
                  </div>
                  {r.kicks.map((k, i) => (
                    <div
                      key={i}
                      className={`kc-dot ${k.made ? 'good' : 'miss'} ${k.xp ? 'xp' : ''}`}
                      style={{ left: `${((Math.min(65, k.d) - 15) / 50) * 100}%`, top: `${18 + (i % 3) * 14}px` }}
                      title={`${k.xp ? 'XP' : 'FG'} ${k.d} · ${k.made ? 'good' : 'miss'}`}
                    />
                  ))}
                </div>
                <div className="kick-list">
                  {r.kicks.map((k, i) => (
                    <div key={i} className="kl-row">
                      <span>{k.xp ? 'Extra point' : `${k.d}-yd FG`}</span>
                      <span className="kl-when">
                        {Q[k.q]} {k.q < 5 ? k.clock : ''}
                        {k.gw ? ' · clutch' : ''}
                      </span>
                      <span className={k.made ? 'good' : 'miss'}>{k.made ? 'Good' : 'No good'}</span>
                    </div>
                  ))}
                </div>
                <p className="note">
                  FG {fgs.filter((k) => k.made).length}/{fgs.length} · XP {xps.filter((k) => k.made).length}/{xps.length}
                </p>
              </>
            )}
          </section>
          <section className="card">
            <h2>Earned</h2>
            <div className="big-num">+{Math.floor(summary.pointsEarned * 10) / 10}</div>
            <p className="note">skill points · {Math.floor(after.points)} to spend</p>
            <h2>Coach trust</h2>
            <TrustMeter value={summary.trustAfter} before={summary.trustBefore} />
            {summary.notes.length > 0 && (
              <ul className="notes">
                {summary.notes.map((n, i) => (
                  <li key={i} className={n.startsWith('NEW ') ? 'rec-note' : n.startsWith('Game-winning') ? 'gw-note' : ''}>
                    {n}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        {press && (
          <section className="card press">
            <div className="eyebrow">Press conference · {press.headline}</div>
            <p className="press-q">"{press.question}"</p>
            {answered === null ? (
              <div className="press-choices">
                {press.choices.map((ch, i) => (
                  <button
                    key={ch.label}
                    className="ghost"
                    onClick={() => {
                      setAfter(applyPress(after, press, i));
                      setAnswered(i);
                    }}
                  >
                    <b>{ch.label}</b>
                    <span>"{ch.quote}"</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="note">
                You said: "{press.choices[answered].quote}"{' '}
                {press.choices[answered].trust > 0 ? 'The coach liked that.' : press.choices[answered].trust < 0 ? "The coach didn't love that." : ''}
              </p>
            )}
          </section>
        )}
        {after.slump && (
          <p className="note warn">
            Slump: {after.slump.reason.toLowerCase()}. Composure and touch are down until it fades or you make a big kick.
          </p>
        )}
        <div className="btn-row">
          <button className="primary" onClick={() => onContinue(after)}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

export function TrustMeter({ value, before }: { value: number; before?: number }) {
  const d = before === undefined ? 0 : Math.round(value - before);
  return (
    <div className="trust">
      <div className="trust-bar">
        <div className="trust-fill" style={{ width: `${value}%` }} />
        {before !== undefined && <div className="trust-before" style={{ left: `${before}%` }} />}
      </div>
      <div className="trust-txt">
        {Math.round(value)}
        {d !== 0 && <span className={d > 0 ? 'good' : 'miss'}> {d > 0 ? `+${d}` : d}</span>}
        <span className="trust-lbl"> {value >= 75 ? 'Full trust: long tries and big moments' : value >= 45 ? 'Steady' : value >= 20 ? 'Shaky: he may pass on long kicks' : 'On thin ice'}</span>
      </div>
    </div>
  );
}

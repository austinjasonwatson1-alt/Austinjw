import { useEffect, useState, type CSSProperties } from 'react';
import { sound } from '../../audio/sound';
import { CONFIG } from '../../config';
import {
  afterDraftResult,
  afterReview,
  applyDrill,
  applyOffseasonCamp,
  applyShowcase,
  campKicks,
  careerTotals,
  canEnterPortal,
  chooseOffer,
  choosePortal,
  enterPortal,
  currentGame,
  declareForDraft,
  finishOffseason,
  resolveCamp,
  resolveTryout,
  retire,
  rivalCampResults,
  seasonLabel,
  simUnsignedWeek,
  spendPoint,
  toggleAutoXp,
  tryoutKicks,
} from '../../career/career';
import { accentFor } from '../../career/look';
import { playoffRace, sorted } from '../../career/standings';
import { SCOPE_NAME } from '../../career/records';
import { addLegacy, blankCounters, TRAITS } from '../../career/story';
import { coachRangeYd, levelCost, nextLevelEffect, overall, SKILLS } from '../../career/progression';
import { saveCareer } from '../../career/save';
import type { Career, Offer, SkillKey } from '../../career/types';
import { maxRangeYd, type Hash, type KickSetup } from '../../kick/physics';
import { GameDay, TrustMeter } from './GameDay';
import { KickSeries, type SeriesKick } from './KickSeries';

type Tab = 'home' | 'schedule' | 'skills' | 'practice' | 'depth' | 'stats';
type Overlay =
  | { kind: 'game' }
  | { kind: 'series'; title: string; intro: string; kicks: SeriesKick[]; rival?: { name: string; results: boolean[] }; verdict?: (m: boolean[]) => string; done: (m: boolean[]) => void }
  | null;

const STAGE_LABEL = { hs: 'High school', college: 'College', draft: 'The draft', nfl: 'NFL', retired: 'Retired' };

function kick(c: Career, d: number, hash: Hash = 'M', windMph = 0, windToDeg = 0): KickSetup {
  return { level: c.level, distanceYd: d, hash, windMph, windToDeg, weather: 'clear' };
}

export function CareerApp({ initial, onMenu }: { initial: Career; onMenu: () => void }) {
  const [c, setC] = useState<Career>(initial);
  const [tab, setTab] = useState<Tab>('home');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [saved, setSaved] = useState(true);

  // Autosave on every change (games, spending, decisions).
  useEffect(() => {
    setSaved(saveCareer(c));
  }, [c]);

  const accent = accentFor(c.team);
  const update = (n: Career) => {
    setC(n);
    setOverlay(null);
  };

  if (overlay?.kind === 'game') {
    const g = currentGame(c);
    if (g) return <GameDay career={c} game={g} onFinish={update} />;
  }
  if (overlay?.kind === 'series') {
    return <KickSeries title={overlay.title} intro={overlay.intro} kicks={overlay.kicks} career={c} rival={overlay.rival} verdict={overlay.verdict} onDone={overlay.done} onBack={() => setOverlay(null)} />;
  }

  if (c.pending?.kind === 'retired' && c.summary) return <Summary c={c} onMenu={onMenu} />;

  const s = c.season;
  return (
    <div className="screen career" style={{ '--accent': accent, '--team': c.team?.primary ?? '#1a2340' } as CSSProperties}>
      <header className="c-head">
        <div className="c-head-inner">
          <button className="link" onClick={onMenu}>
            ← Menu
          </button>
          <div className="c-id">
            <div className="c-team">{c.team?.name ?? 'Free agent'}</div>
            <h1 className="c-name">
              {c.kicker.name} <span className="c-num">#{c.kicker.number}</span>
            </h1>
            <div className="c-sub">
              {STAGE_LABEL[c.stage]}
              {c.stage !== 'draft' && ` · ${seasonLabel(c)}`} · {c.year} · Age {c.age} · {c.role === 'starter' ? 'Starter' : c.role === 'backup' ? 'Backup' : 'Unsigned'}
            </div>
          </div>
          <div className="c-ovr">
            <div className="c-ovr-n">{overall(c.skills)}</div>
            <div className="c-ovr-l">Overall</div>
          </div>
        </div>
        <nav className="tabs">
          {(
            [
              ['home', 'Home'],
              ['schedule', 'Schedule'],
              ['skills', `Skills${Math.floor(c.points) >= 1 ? ` · ${Math.floor(c.points)}` : ''}`],
              ['practice', 'Practice'],
              ['depth', 'Depth chart'],
              ['stats', 'Career stats'],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </nav>
      </header>

      <main className="c-main">
        {!saved && <p className="note warn">Saving is blocked in this browser window, so this career will not be kept after you close it.</p>}
        {tab === 'home' && <Home c={c} setC={setC} setOverlay={setOverlay} goSkills={() => setTab('skills')} />}
        {tab === 'schedule' && <Schedule c={c} />}
        {tab === 'skills' && <Skills c={c} setC={setC} />}
        {tab === 'practice' && <Practice c={c} setC={setC} setOverlay={setOverlay} />}
        {tab === 'depth' && <Depth c={c} />}
        {tab === 'stats' && <Stats c={c} />}
        {s && tab === 'home' && null}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home: the next thing to do, season line, trust, news

function Home({ c, setC, setOverlay, goSkills }: { c: Career; setC: (c: Career) => void; setOverlay: (o: Overlay) => void; goSkills: () => void }) {
  const s = c.season;
  return (
    <div className="home-grid">
      <section className="card next">
        <NextUp c={c} setC={setC} setOverlay={setOverlay} goSkills={goSkills} />
      </section>
      <section className="card">
        <h2>This season</h2>
        {s ? (
          <div className="line-grid">
            <Stat k="Record" v={`${s.w}-${s.l}`} />
            <Stat k="FG" v={`${s.fgm}/${s.fga}`} />
            <Stat k="FG%" v={s.fga ? `${Math.round((s.fgm / s.fga) * 100)}` : '—'} />
            <Stat k="Long" v={s.long || '—'} />
            <Stat k="XP" v={`${s.xpm}/${s.xpa}`} />
            <Stat k="Points" v={s.points} />
          </div>
        ) : (
          <p className="note">The season hasn't started.</p>
        )}
        <RaceLine c={c} />
        {c.slump && (
          <div className="race race-out">
            In a slump ({c.slump.reason.toLowerCase()}): composure and touch down {Math.round(c.slump.level * 100)}%. A big make ends it.
          </div>
        )}
        <h2>Coach trust</h2>
        <TrustMeter value={c.trust} />
        <p className="note">
          Range today: about {Math.floor(maxRangeYd(c.skills))} yds on a calm day. Coach will send you out from about {Math.floor(coachRangeYd(c.skills, 'clear', 0, c.trust))}.
        </p>
        <h2>Skill points</h2>
        <p className="note">
          <b className="pts">{Math.floor(c.points)}</b> to spend.{' '}
          <button className="link inline" onClick={goSkills}>
            Open skills
          </button>
        </p>
        <label className="toggle">
          <input id="autoxp" type="checkbox" checked={c.settings.autoXp} onChange={() => setC(toggleAutoXp(c))} /> Resolve extra points automatically
        </label>
      </section>
      <section className="card news">
        <h2>News</h2>
        <ul>
          {c.news.slice(0, 14).map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="stat">
      <div className="stat-v">{v}</div>
      <div className="stat-k">{k}</div>
    </div>
  );
}

function NextUp({ c, setC, setOverlay, goSkills }: { c: Career; setC: (c: Career) => void; setOverlay: (o: Overlay) => void; goSkills: () => void }) {
  const p = c.pending;
  const done = (n: Career) => {
    setC(n);
    setOverlay(null);
  };

  if (p?.kind === 'camp') {
    const rival = rivalCampResults(c, p.rival);
    return (
      <Next eyebrow="Camp competition" title={p.title} body={`${p.why} Five kicks each from ${campKicks().join(', ')} yards. Most makes wins the job.`}>
        <button
          className="primary"
          onClick={() =>
            setOverlay({
              kind: 'series',
              title: 'Camp battle',
              intro: `You and ${p.rival.name} (overall ${p.rival.overall}) alternate five kicks. Most makes wins the job. A tie goes to whoever made the longer kicks.`,
              kicks: campKicks().map((d, i) => ({ setup: kick(c, d, (['M', 'L', 'R', 'M', 'L'] as Hash[])[i], i * 2, 90) })),
              rival: { name: p.rival.name, results: rival },
              verdict: (m) => {
                const a = m.filter(Boolean).length;
                const b = rival.filter(Boolean).length;
                const reach = (res: boolean[]) => res.reduce((t, made, i) => t + (made ? campKicks()[i] : 0), 0);
                return a > b || (a === b && reach(m) >= reach(rival)) ? 'You win the job.' : c.stage === 'nfl' ? `${p.rival.name} wins the job. You're cut.` : `${p.rival.name} wins the job. You're the backup.`;
              },
              done: (m) => done(resolveCamp(c, m, rival)),
            })
          }
        >
          Start camp battle
        </button>
      </Next>
    );
  }

  if (p?.kind === 'showcase') {
    const recruiting = p.purpose === 'recruiting';
    const dists = recruiting ? CONFIG.career.recruiting.showcaseDistances : CONFIG.career.draft.showcaseDistances;
    return (
      <Next
        eyebrow={recruiting ? 'Summer showcase' : 'Pro day'}
        title={recruiting ? 'Kick for the college scouts' : 'Kick for the NFL scouts'}
        body={recruiting ? `Five kicks, ${dists[0]} to ${dists[dists.length - 1]} yards. Your makes, your stats and your ratings set your star rating, and the stars set your offers.` : `Six kicks, ${dists[0]} to ${dists[dists.length - 1]} yards. Your makes, college stats and awards set your draft stock. Kickers go late, if at all.`}
      >
        <button
          className="primary"
          onClick={() =>
            setOverlay({
              kind: 'series',
              title: recruiting ? 'Summer showcase' : 'Pro day',
              intro: recruiting ? 'College scouts are watching. Every make helps your star rating.' : 'All 32 teams sent someone. Every make moves your draft stock.',
              kicks: dists.map((d, i) => ({ setup: kick(c, d, (['M', 'L', 'R'] as Hash[])[i % 3], 4, 0) })),
              done: (m) => done(applyShowcase(c, m)),
            })
          }
        >
          Start
        </button>
      </Next>
    );
  }

  if (p?.kind === 'offers') return <Offers title={p.title} offers={p.offers} c={c} onPick={(o) => done(chooseOffer(c, o))} />;

  if (p?.kind === 'portal') {
    return (
      <Offers
        title="Transfer portal"
        eyebrow={`Transfer portal · ${c.team?.name ?? ''} · ${4 - c.seasonNo} season${4 - c.seasonNo === 1 ? '' : 's'} of eligibility left`}
        offers={p.offers}
        c={c}
        onPick={(o) => done(choosePortal(c, o))}
        footer={
          <div className="btn-row">
            <button className="ghost" onClick={() => done(choosePortal(c, null))}>
              Withdraw and return to {c.team?.short}
            </button>
            <span className="note">The coach won't wait: withdraw and you face a camp battle with a new kicker, and his trust drops.</span>
          </div>
        }
      />
    );
  }

  if (p?.kind === 'declare') {
    return (
      <Next eyebrow="Decision" title={p.forced ? 'Your college career is over' : 'Declare for the NFL draft?'} body={p.forced ? 'Four seasons done. Time to go pro.' : `You've played three seasons. Leave now, or come back for one more year to build your stock.`}>
        {!p.forced && (
          <button className="ghost" onClick={() => done(declareForDraft(c, false))}>
            Stay one more year
          </button>
        )}
        <button className="primary" onClick={() => done(declareForDraft(c, true))}>
          Declare for the draft
        </button>
      </Next>
    );
  }

  if (p?.kind === 'draftResult') {
    return (
      <Next eyebrow="The draft" title={p.drafted ? 'Drafted' : 'Undrafted'} body={p.text}>
        <button className="primary" onClick={() => done(afterDraftResult(c))}>
          {p.drafted ? 'Report to camp' : 'See free-agent offers'}
        </button>
      </Next>
    );
  }

  if (p?.kind === 'tryout') {
    return (
      <Next eyebrow="Tryout" title={`The ${p.team.name} want a look`} body={`Four kicks: ${tryoutKicks().join(', ')} yards. Make three and the job is yours for the rest of the season.`}>
        <button className="ghost" onClick={() => done({ ...c, pending: null })}>
          Pass
        </button>
        <button
          className="primary"
          onClick={() =>
            setOverlay({
              kind: 'series',
              title: `${p.team.short} tryout`,
              intro: 'Make three of four.',
              kicks: tryoutKicks().map((d, i) => ({ setup: kick(c, d, (['M', 'R', 'L', 'M'] as Hash[])[i], 6, 180) })),
              verdict: (m) => (m.filter(Boolean).length >= 3 ? `The ${p.team.name} sign you.` : 'They thank you for coming in.'),
              done: (m) => done(resolveTryout(c, m)),
            })
          }
        >
          Start tryout
        </button>
      </Next>
    );
  }

  if (p?.kind === 'review') {
    const l = p.line;
    return (
      <Next eyebrow={`${l.year} season review`} title={`${l.label} season${l.postseason && l.postseason !== 'No postseason' ? ` · ${l.postseason}` : ''}`} body={p.notes.join(' · ')}>
        {l.honors.length > 0 && <div className="honor-row">{l.honors.map((h) => <span key={h} className="chip">{h}</span>)}</div>}
        <button className="primary" onClick={() => done(afterReview(c))}>
          On to the offseason
        </button>
      </Next>
    );
  }

  if (p?.kind === 'offseason') {
    const nextStep =
      c.stage === 'hs' ? (c.seasonNo === 1 ? 'Summer showcase' : 'College offers') : c.stage === 'college' ? (c.seasonNo >= 3 ? 'The draft decision' : 'Next season') : 'Next season';
    return (
      <Next eyebrow="Offseason" title="Get better" body={`Offseason camp pays the biggest chunk of skill points all year. Spend them, then move on. Age ${c.age}.${canEnterPortal(c) ? ' Thinking about transferring? Do camp first: entering the portal ends your offseason.' : ''}`}>
        {!p.campDone && (
          <>
            <button className="ghost" onClick={() => done(applyOffseasonCamp(c, [0, 1, 2, 3, 4].map(() => Math.random() < 0.55)))}>
              Sim camp
            </button>
            <button
              className="primary"
              onClick={() =>
                setOverlay({
                  kind: 'series',
                  title: 'Offseason camp',
                  intro: `Five kicks with wind. Each make adds points on top of the base.`,
                  kicks: [35, 42, 47, 50, 53].map((d, i) => ({ setup: kick(c, d, (['L', 'R', 'M', 'L', 'R'] as Hash[])[i], 6 + i * 2, [90, 270, 180, 45, 0][i]) })),
                  done: (m) => done(applyOffseasonCamp(c, m)),
                })
              }
            >
              Attend camp
            </button>
          </>
        )}
        <button className="ghost" onClick={goSkills}>
          Spend points ({Math.floor(c.points)})
        </button>
        {canEnterPortal(c) && (
          <button className="ghost" onClick={() => done(enterPortal(c))}>
            Enter transfer portal
          </button>
        )}
        {c.stage === 'nfl' && (
          <button className="ghost danger" onClick={() => done(retire(c))}>
            Retire
          </button>
        )}
        <button className="primary" onClick={() => done(finishOffseason(c))}>
          {nextStep} →
        </button>
      </Next>
    );
  }

  const g = currentGame(c);
  if (g) {
    const lvl = CONFIG.levels[c.level];
    return (
      <Next
        eyebrow={g.label ?? `${lvl.label} · Week ${g.week}`}
        title={`${g.home ? 'vs' : 'at'} ${g.opp.name}`}
        body={`${CONFIG.weather[g.weather].label}, ${g.tempF}° · wind ${g.windMph} mph. ${c.role === 'starter' ? 'You kick every field goal and extra point the coach sends you out for.' : `You're the backup behind ${c.rival?.name}. Win the job back if he slumps.`}`}
      >
        {!c.drillDone && c.role !== 'unsigned' && <span className="note">Weekly drill available on the Practice tab.</span>}
        <button
          className="primary"
          onClick={() => {
            sound.start();
            setOverlay({ kind: 'game' });
          }}
        >
          Play {g.label ? 'game' : `week ${g.week}`}
        </button>
      </Next>
    );
  }

  if (c.role === 'unsigned' && c.inSeason) {
    return (
      <Next eyebrow={`Unsigned · Week ${c.week + 1}`} title="Waiting for a call" body="Teams call when their kicker is hurt or slumping. Keep your leg ready.">
        <button className="ghost danger" onClick={() => done(retire(c, 'Walks away while unsigned.'))}>
          Retire
        </button>
        <button className="primary" onClick={() => done(simUnsignedWeek(c))}>
          Next week
        </button>
      </Next>
    );
  }

  return <Next eyebrow="" title="Nothing scheduled" body="" />;
}

function Next({ eyebrow, title, body, children }: { eyebrow: string; title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="next-up">
      <div className="eyebrow">{eyebrow}</div>
      <h2 className="next-title">{title}</h2>
      {body && <p className="lede">{body}</p>}
      <div className="btn-row">{children}</div>
    </div>
  );
}

function Offers({ title, offers, c, onPick, eyebrow, footer }: { title: string; offers: Offer[]; c: Career; onPick: (o: Offer) => void; eyebrow?: string; footer?: React.ReactNode }) {
  return (
    <div className="next-up">
      <div className="eyebrow">{eyebrow ?? (c.stars && c.stage === 'hs' ? `${'★'.repeat(c.stars)}${'☆'.repeat(5 - c.stars)} recruit` : 'Offers')}</div>
      <h2 className="next-title">{title}</h2>
      <div className="offers">
        {offers.map((o) => (
          <div key={o.id} className="offer" style={{ '--team': o.team.primary, '--team2': o.team.secondary } as CSSProperties}>
            <div className="offer-band" />
            <div className="offer-body">
              <div className="offer-kind">{{ walkon: 'Walk-on', scholarship: 'Scholarship', starter: 'Starting job', drafted: 'Drafted', udfa: 'Undrafted free agent', freeAgent: 'Contract', transfer: o.rivalOvr === null ? 'Transfer · starting job' : 'Transfer · compete' }[o.kind]}</div>
              <div className="offer-title">{o.title}</div>
              <p className="note">{o.note}</p>
              <p className="note">{o.rivalOvr === null ? 'The job is yours.' : `Camp battle vs a kicker rated about ${o.rivalOvr}.`}</p>
              {o.contract && <p className="note">{o.contract.years} yr · ${o.contract.salary.toFixed(2)}M/yr</p>}
              <button className="primary" onClick={() => onPick(o)}>
                Choose
              </button>
            </div>
          </div>
        ))}
      </div>
      {offers.length === 0 && <p className="note">No schools reached out.</p>}
      {footer}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills

function Skills({ c, setC }: { c: Career; setC: (c: Career) => void }) {
  return (
    <div className="skills">
      <div className="skills-head">
        <div>
          <div className="eyebrow">Skill points</div>
          <div className="big-num">{Math.floor(c.points)}</div>
        </div>
        <p className="note">Costs: 1 point per level below 60, 2 from 60 to 79, 3 from 80 to 89, 5 from 90 up. Spending is permanent. {c.age >= 33 ? 'From your mid-thirties Power slips each year, so points go toward holding it up.' : ''}</p>
      </div>
      <h2>Traits</h2>
      <div className="traits">
        {TRAITS.map((t) => {
          const have = (c.traits ?? []).includes(t.id);
          const [now, goal] = t.progress(c.counters ?? blankCounters());
          return (
            <div key={t.id} className={`trait ${have ? 'have' : ''}`}>
              <div className="trait-name">
                {have ? '★ ' : ''}
                {t.name}
              </div>
              <div className="trait-effect">{t.effect}</div>
              <div className="note">{have ? 'Unlocked' : `${t.goal} · ${Math.min(now, goal)}/${goal}`}</div>
              {!have && (
                <div className="rec-bar">
                  <div style={{ width: `${Math.min(100, (now / goal) * 100)}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <h2>Skills</h2>
      {SKILLS.map(({ key, label, blurb }) => {
        const v = c.skills[key];
        const cost = levelCost(v);
        const can = c.points >= cost && v < 99;
        return (
          <div key={key} className="skill">
            <div className="skill-top">
              <div className="skill-name">{label}</div>
              <div className="skill-v">{v}</div>
            </div>
            <div className="skill-bar">
              <div className="skill-fill" style={{ width: `${v}%` }} />
              {[60, 80, 90].map((t) => (
                <div key={t} className="skill-tick" style={{ left: `${t}%` }} />
              ))}
            </div>
            <div className="skill-foot">
              <span className="note">{blurb}</span>
              <span className="note">{v < 99 ? `Next: ${nextLevelEffect(key as SkillKey, c.skills)}` : 'Maxed'}</span>
              <button className={can ? 'primary small' : 'ghost small'} disabled={!can} onClick={() => setC(spendPoint(c, key as SkillKey))}>
                +1 · {v < 99 ? `${cost} pt${cost > 1 ? 's' : ''}` : '—'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Practice: the weekly drill

function drillKicks(c: Career, key: SkillKey): { kicks: SeriesKick[]; intro: string } {
  const range = Math.floor(maxRangeYd(c.skills));
  switch (key) {
    case 'power':
      return { intro: 'Three kicks at the edge of your range.', kicks: [range - 6, range - 3, range - 1].map((d) => ({ setup: kick(c, d) })) };
    case 'accuracy':
      return { intro: 'Three kicks from the hashes. Hit the sweet spot.', kicks: [38, 42, 46].map((d, i) => ({ setup: kick(c, d, i % 2 ? 'R' : 'L') })) };
    case 'composure':
      return { intro: 'Three kicks with the pressure turned all the way up.', kicks: [36, 40, 44].map((d) => ({ setup: kick(c, d), pressure: 0.9, label: 'Pressure' })) };
    case 'windControl':
      return { intro: 'Three kicks in a stiff crosswind.', kicks: [35, 40, 44].map((d, i) => ({ setup: kick(c, d, 'M', 15 + i * 3, i % 2 ? 270 : 90) })) };
    case 'consistency':
      return { intro: 'The same 43-yarder, three times.', kicks: [43, 43, 43].map((d) => ({ setup: kick(c, d, 'L', 4, 135) })) };
  }
}

function Practice({ c, setC, setOverlay }: { c: Career; setC: (c: Career) => void; setOverlay: (o: Overlay) => void }) {
  const can = c.inSeason && !c.drillDone && c.role !== 'unsigned' && !c.pending;
  return (
    <div className="practice">
      <div className="eyebrow">Weekly drill</div>
      <h2 className="next-title">{can ? 'Pick a skill to work on' : c.drillDone ? 'Drill done this week' : 'Drills run during the season'}</h2>
      <p className="lede">
        Three kicks. Each make adds {CONFIG.career.points.drillPerMake} toward the skill you pick, and progress carries over to the next drill.
        {c.drillBank ? ` Carried over: ${c.drillBank}.` : ''}
      </p>
      <div className="drill-grid">
        {SKILLS.map(({ key, label, blurb }) => {
          const d = drillKicks(c, key);
          return (
            <div key={key} className="card drill">
              <h3>{label}</h3>
              <p className="note">{d.intro}</p>
              <p className="note dim">{blurb}</p>
              <div className="btn-row">
                <button className="ghost small" disabled={!can} onClick={() => setC(applyDrill(c, key, d.kicks.map(() => Math.random() < 0.6)))}>
                  Sim
                </button>
                <button
                  className="primary small"
                  disabled={!can}
                  onClick={() =>
                    setOverlay({
                      kind: 'series',
                      title: `${label} drill`,
                      intro: d.intro,
                      kicks: d.kicks,
                      done: (m) => {
                        setC(applyDrill(c, key, m));
                        setOverlay(null);
                      },
                    })
                  }
                >
                  Kick
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Depth chart

function Depth({ c }: { c: Career }) {
  const me = { name: c.kicker.name, ovr: overall(c.skills), role: c.role };
  const rows = c.rival ? [me, { name: c.rival.name, ovr: c.rival.overall, role: c.role === 'starter' ? 'backup' : 'starter' }] : [me];
  rows.sort((a, b) => (a.role === 'starter' ? -1 : 1) - (b.role === 'starter' ? -1 : 1));
  return (
    <div className="depth">
      <div className="eyebrow">{c.team?.name ?? 'No team'} · Kickers</div>
      <h2 className="next-title">Depth chart</h2>
      {rows.map((r, i) => (
        <div key={r.name} className={`depth-row ${r.name === me.name ? 'me' : ''}`}>
          <div className="depth-pos">K{i + 1}</div>
          <div className="depth-name">
            {r.name}
            <span className="note"> {r.role === 'starter' ? 'Starter' : r.role === 'backup' ? 'Backup' : 'Unsigned'}</span>
          </div>
          <div className="depth-bar">
            <div style={{ width: `${r.ovr}%` }} />
          </div>
          <div className="depth-ovr">{r.ovr}</div>
        </div>
      ))}
      <p className="note">
        {c.pending?.kind === 'camp'
          ? `Camp competition coming: ${c.pending.rival.name}.`
          : c.role === 'backup'
            ? `You get your chance if ${c.rival?.name} slumps or gets hurt. Recent kicks: ${c.rivalForm.map((m) => (m ? '✓' : '✗')).join(' ') || 'none yet'}.`
            : c.rival
              ? `${c.rival.name} will push you in camp next season.`
              : 'No one is pushing you right now.'}
      </p>
      {c.nemesis && (
        <div className="nemesis card">
          <div className="eyebrow">Your rival</div>
          <div className="nemesis-name">{c.nemesis.name}</div>
          <p className="note">
            {c.nemesis.note === 'the senior you fought for the job' ? 'The senior you fought for the job in high school.' : `Your old high school rival. Now ${c.nemesis.note}.`}
          </p>
        </div>
      )}
      {c.contract && (
        <p className="note">
          Contract: {c.contract.years} year{c.contract.years === 1 ? '' : 's'} left at ${c.contract.salary.toFixed(2)}M.
        </p>
      )}
      {c.stage === 'nfl' && c.lastTen.length > 0 && (
        <p className="note">
          Last {c.lastTen.length} field goals: {c.lastTen.map((m) => (m ? '✓' : '✗')).join(' ')}. Below {Math.round(CONFIG.career.nfl.hotSeatPct * 100)}% brings in competition; below {Math.round(CONFIG.career.nfl.cutPct * 100)}% gets you cut.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Career stats

function Stats({ c, hideTotals = false }: { c: Career; hideTotals?: boolean }) {
  const lines = [...c.history, ...(c.inSeason && c.season ? [{ ...c.season, label: `${c.season.label} (now)` }] : [])];
  const fgs = c.log.filter((k) => !k.xp);
  const buckets = [
    [0, 29, 'Under 30'],
    [30, 39, '30-39'],
    [40, 49, '40-49'],
    [50, 99, '50+'],
  ] as const;
  const t = careerTotals({ ...c, history: lines });
  return (
    <div className="stats">
      <div className="line-grid wide" hidden={hideTotals}>
        <Stat k="Field goals" v={`${t.fgm}/${t.fga}`} />
        <Stat k="FG%" v={t.fga ? Math.round((t.fgm / t.fga) * 100) : '—'} />
        <Stat k="Extra points" v={`${t.xpm}/${t.xpa}`} />
        <Stat k="Points" v={t.points} />
        <Stat k="Longest" v={c.longest || '—'} />
      </div>
      <h2>Accuracy by distance</h2>
      <div className="buckets">
        {buckets.map(([lo, hi, l]) => {
          const b = fgs.filter((k) => k.d >= lo && k.d <= hi);
          const m = b.filter((k) => k.made).length;
          return (
            <div key={l} className="bucket">
              <div className="bucket-l">{l}</div>
              <div className="bucket-v">{b.length ? `${m}/${b.length}` : '—'}</div>
              {b.length > 0 && <div className="bucket-pct">{Math.round((m / b.length) * 100)}%</div>}
            </div>
          );
        })}
      </div>
      <h2>Season by season</h2>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Year</th>
              <th>Team</th>
              <th>Season</th>
              <th>Role</th>
              <th>W-L</th>
              <th>FG</th>
              <th>%</th>
              <th>Long</th>
              <th>XP</th>
              <th>Pts</th>
              <th>Honors</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.year}</td>
                <td>{l.teamShort}</td>
                <td>{l.label}</td>
                <td>{l.role === 'starter' ? 'K1' : l.role === 'backup' ? 'K2' : '—'}</td>
                <td>
                  {l.w}-{l.l}
                </td>
                <td>
                  {l.fgm}/{l.fga}
                </td>
                <td>{l.fga ? Math.round((l.fgm / l.fga) * 100) : '—'}</td>
                <td>{l.long || '—'}</td>
                <td>
                  {l.xpm}/{l.xpa}
                </td>
                <td>{l.points}</td>
                <td>{[...l.honors, l.postseason && /Champion/.test(l.postseason) ? l.postseason : ''].filter(Boolean).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RecordBookView c={c} />
      <h2>Trophy case</h2>
      {c.titles.length + c.honors.length + (c.recordsBroken?.length ?? 0) === 0 ? (
        <p className="note">Empty for now. All-state, All-American, Pro Bowls and titles land here.</p>
      ) : (
        <div className="trophies">
          {c.titles.map((h) => (
            <div key={h} className="trophy title">
              🏆 {h}
            </div>
          ))}
          {c.honors.map((h, i) => (
            <div key={h + i} className="trophy">
              {h}
            </div>
          ))}
          {(c.recordsBroken ?? []).map((h, i) => (
            <div key={h + i} className="trophy record">
              ★ {h}
            </div>
          ))}
        </div>
      )}
      <p className="note">Records to chase: the NFL's longest field goal (66 yards) and its career scoring record (2,673 points).</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Retirement

function Summary({ c, onMenu }: { c: Career; onMenu: () => void }) {
  const s = c.summary!;
  useEffect(() => {
    const first = c.history[0]?.year ?? c.year;
    addLegacy({ name: c.kicker.name, years: `${first}-${c.year}`, verdict: s.verdict, points: s.points, nflPoints: s.nflPoints, longest: s.longest, titles: s.titles.length, honors: s.honors.length });
  }, []);
  return (
    <div className="screen panel-screen" style={{ '--accent': accentFor(c.team) } as CSSProperties}>
      <div className="panel-wrap">
        <div className="eyebrow">Career summary · Retired at {c.age}</div>
        <h1 className="panel-title">{c.kicker.name}</h1>
        <div className="verdict">
          <div className="verdict-big">{s.verdict}</div>
          <p className="lede">{s.verdictNote}</p>
        </div>
        <div className="line-grid wide">
          <Stat k="Career points" v={s.points} />
          <Stat k="NFL points" v={s.nflPoints} />
          <Stat k="Field goals" v={`${s.fgm}/${s.fga}`} />
          <Stat k="Extra points" v={`${s.xpm}/${s.xpa}`} />
          <Stat k="Longest" v={s.longest} />
          <Stat k="NFL seasons" v={s.nflSeasons} />
        </div>
        {(s.titles.length > 0 || s.honors.length > 0) && (
          <div className="trophies">
            {s.titles.map((h) => (
              <div key={h} className="trophy title">
                🏆 {h}
              </div>
            ))}
            {s.honors.map((h, i) => (
              <div key={h + i} className="trophy">
                {h}
              </div>
            ))}
          </div>
        )}
        <Stats c={c} hideTotals />
        <div className="btn-row">
          <button className="primary" onClick={onMenu}>
            Back to menu
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule, standings, playoff race

function RaceLine({ c }: { c: Career }) {
  const r = playoffRace(c);
  if (!r) return null;
  return <div className={`race race-${r.state}`}>{r.text}</div>;
}

function Schedule({ c }: { c: Career }) {
  const st = c.standings;
  const rows = st ? sorted(st) : [];
  const lvl = c.level;
  const S = CONFIG.career.seasons;
  const cutRank = lvl === 'nfl' ? S.nfl.playoffSeeds : null;
  const lineWins = lvl === 'hs' ? S.hs.playoffWins : lvl === 'college' ? S.college.playoffWins : null;
  const post = c.schedule.filter((g) => g.playoff);
  if (!c.inSeason && !c.season) return <p className="note">No season in progress.</p>;
  return (
    <div className="schedule">
      <RaceLine c={c} />
      <div className="sched-grid">
        <section>
          <h2>{c.season?.year ?? c.year} schedule</h2>
          <div className="sched-list">
            {c.schedule.map((g, i) => {
              const r = g.result;
              const next = i === c.week && c.inSeason;
              const res = r ? (r.us > r.them ? 'W' : r.us < r.them ? 'L' : 'T') : null;
              return (
                <div key={i} className={`sched-row ${next ? 'next' : ''} ${g.playoff ? 'post' : ''}`}>
                  <span className="sr-wk">{g.label ? g.label : `Wk ${g.week}`}</span>
                  <span className="sr-opp">
                    <i style={{ background: g.opp.primary }} />
                    {g.home ? 'vs' : 'at'} {g.opp.name}
                  </span>
                  {r && g.opp.short !== '—' ? (
                    <span className={`sr-res ${res === 'W' ? 'good' : res === 'L' ? 'miss' : ''}`}>
                      {res} {r.us}-{r.them}
                      {r.ot ? ' OT' : ''}
                    </span>
                  ) : (
                    <span className="sr-res dim">{next ? 'Next' : `${CONFIG.weather[g.weather].label}`}</span>
                  )}
                  {r && r.kicks.length > 0 && (
                    <span className="sr-kicks">
                      {r.kicks.filter((k) => !k.xp && k.made).length}/{r.kicks.filter((k) => !k.xp).length} FG
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {post.length > 0 && (
            <>
              <h2>Postseason</h2>
              <div className="bracket">
                {post.map((g, i) => {
                  const r = g.result;
                  return (
                    <div key={i} className={`br-round ${r ? (r.us > r.them ? 'won' : 'lost') : 'live'}`}>
                      <div className="br-label">{g.label}</div>
                      <div className="br-opp">vs {g.opp.name}</div>
                      <div className="br-res">{r ? `${r.us > r.them ? 'Won' : 'Lost'} ${r.us}-${r.them}` : 'Up next'}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
        <section>
          <h2>{st?.title ?? 'Standings'}</h2>
          {rows.length === 0 ? (
            <p className="note">No standings while unsigned.</p>
          ) : (
            <div className="table-wrap">
              <table className="tbl standings">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Team</th>
                    <th>W</th>
                    <th>L</th>
                    <th>Pct</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const showLine = (cutRank !== null && i === cutRank) || (lineWins !== null && i > 0 && rows[i - 1].w >= lineWins && r.w < lineWins);
                    return (
                      <tr key={r.name} className={`${r.me ? 'me' : ''} ${showLine ? 'cut' : ''}`}>
                        <td>{i + 1}</td>
                        <td>
                          <i className="dot" style={{ background: r.primary }} />
                          {r.name}
                        </td>
                        <td>{r.w}</td>
                        <td>{r.l}</td>
                        <td>{r.w + r.l ? (r.w / (r.w + r.l)).toFixed(3).replace(/^0/, '') : '.000'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="note">
            {lvl === 'nfl'
              ? `Top ${S.nfl.playoffSeeds} in the conference make the playoffs; the 1 seed gets a bye. The line marks the cut.`
              : lvl === 'hs'
                ? `${S.hs.playoffWins} wins makes the state playoffs (up to 4 rounds).`
                : `${S.college.playoffWins} wins makes the playoff; ${S.college.bowlWins} wins gets a bowl game.`}
          </p>
        </section>
      </div>
    </div>
  );
}

function RecordBookView({ c }: { c: Career }) {
  const b = c.records;
  if (!b) return null;
  return (
    <>
      <h2>{b.title}</h2>
      <div className="records">
        {b.entries.map((e) => {
          const pct = Math.min(100, (e.mine / Math.max(1, e.value)) * 100);
          return (
            <div key={e.kind} className={`rec ${e.brokenYear ? 'broken' : ''}`}>
              <div className="rec-top">
                <span className="rec-label">{e.label}</span>
                <span className="rec-val">
                  {e.brokenYear ? `${e.mine} · record since ${e.brokenYear}` : `${e.mine} / ${e.value}`}
                </span>
              </div>
              <div className="rec-bar">
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="note rec-holder">
                {e.brokenYear ? `You broke the ${SCOPE_NAME[b.scope]} record of ${e.value}${b.scope === 'nfl' ? '' : ` (${e.holder})`}.` : `${SCOPE_NAME[b.scope] === 'NFL' ? 'NFL record' : `Held by ${e.holder}`}: ${e.value}`}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

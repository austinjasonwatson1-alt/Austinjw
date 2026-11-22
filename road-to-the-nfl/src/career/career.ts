// The career state machine. Every function takes a Career and returns a new one (no UI code).

import { CONFIG, type Weather } from '../config';
import { Rng } from '../sim/rng';
import { COLLEGES, FIRST, HS_COLORS, LAST, MASCOTS, NFL_TEAMS, TOWNS } from './data';
import { GameSim, type GameSetup } from './gamesim';
import { clampSkill, costToRaise, evenSkills, kickPoints, levelCost, overall, stageLevel } from './progression';
import type { Career, CareerSummary, Contract, KickerProfile, Offer, Rival, SchedGame, SeasonLine, SkillKey, Team } from './types';

const C = () => CONFIG.career;

function clone(c: Career): Career {
  return JSON.parse(JSON.stringify(c)) as Career;
}

function rngFor(c: Career, salt: string): Rng {
  let h = 2166136261;
  for (const ch of `${salt}|${c.year}|${c.week}|${c.seasonNo}|${c.stage}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return new Rng((c.seed ^ h) >>> 0);
}

function news(c: Career, text: string) {
  c.news.unshift(`${c.year} · ${text}`);
  c.news = c.news.slice(0, 40);
}

export function genName(rng: Rng): string {
  return `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
}

function genRival(rng: Rng, ovr: number): Rival {
  return { name: genName(rng), overall: Math.round(ovr + rng.normal() * 3) };
}

function hsTeam(rng: Rng, school: string): Team {
  const [primary, secondary] = rng.pick(HS_COLORS);
  const mascot = rng.pick(MASCOTS);
  return { name: `${school} ${mascot}`, short: hsShort(school), primary, secondary, strength: 50 };
}

function hsShort(name: string): string {
  return name.replace(/[^A-Za-z ]/g, '').split(' ')[0].slice(0, 4).toUpperCase() || 'HS';
}

function genHsOpp(rng: Rng, avoid: string): Team {
  const mine = avoid.split(' ')[0].toLowerCase();
  let town = rng.pick(TOWNS);
  for (let i = 0; i < 10 && (town.split(' ')[0].toLowerCase() === mine || hsShort(town) === hsShort(avoid)); i++) town = rng.pick(TOWNS);
  const [primary, secondary] = rng.pick(HS_COLORS);
  const short = hsShort(town);
  return { name: `${town} ${rng.pick(MASCOTS)}`, short, primary, secondary, strength: 50 };
}

function teamStrength(rng: Rng, mean: number, sd: number): number {
  return Math.max(15, Math.min(95, Math.round(mean + rng.normal() * sd)));
}

function weatherFor(rng: Rng, frac: number, level: string): { weather: Weather; tempF: number; windMph: number; windToDeg: number } {
  const r = rng.next();
  const late = frac > 0.6;
  let weather: Weather = 'clear';
  if (late && r < 0.08) weather = 'snow';
  else if (r < (late ? 0.2 : 0.12)) weather = 'rain';
  else if (late && r < 0.34) weather = 'cold';
  // Some NFL games are indoors
  const dome = level === 'nfl' && rng.next() < 0.28;
  if (dome) return { weather: 'clear', tempF: 72, windMph: 0, windToDeg: 0 };
  const [lo, hi] = CONFIG.weather[weather].tempF;
  const tempF = Math.round(rng.range(lo, hi) - (late && weather === 'clear' ? 12 : 0));
  const windMph = Math.round(Math.max(0, Math.pow(rng.next(), 1.5) * 22 + (weather === 'clear' ? 0 : 3)));
  return { weather, tempF, windMph, windToDeg: rng.pick([0, 45, 90, 135, 180, 225, 270, 315]) };
}

export function seasonLabel(c: Career): string {
  if (c.stage === 'hs') return c.seasonNo === 1 ? 'Junior' : 'Senior';
  if (c.stage === 'college') return ['Freshman', 'Sophomore', 'Junior', 'Senior'][c.seasonNo - 1] ?? `Year ${c.seasonNo}`;
  return c.seasonNo === 1 ? 'Rookie' : `Year ${c.seasonNo}`;
}

function blankLine(c: Career): SeasonLine {
  return {
    year: c.year,
    age: c.age,
    stage: stageLevel(c.stage) === 'hs' ? 'hs' : stageLevel(c.stage) === 'college' ? 'college' : 'nfl',
    label: seasonLabel(c),
    team: c.team?.name ?? 'Unsigned',
    teamShort: c.team?.short ?? '—',
    role: c.role,
    games: 0,
    w: 0,
    l: 0,
    fgm: 0,
    fga: 0,
    xpm: 0,
    xpa: 0,
    long: 0,
    points: 0,
    honors: [],
    postseason: '',
  };
}

// ---------------------------------------------------------------------------
// New career

export function newCareer(slot: number, kicker: KickerProfile, seed: number): Career {
  const c: Career = {
    v: 1,
    slot,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    seed,
    kicker,
    stage: 'hs',
    level: 'hs',
    year: C().startYear,
    age: C().startAge,
    seasonNo: 1,
    skills: { ...C().startSkills },
    points: 0,
    trust: C().trust.start.hs,
    team: null,
    role: 'backup',
    rival: null,
    rivalForm: [],
    schedule: [],
    week: 0,
    inSeason: false,
    drillDone: false,
    stars: null,
    recruitScore: null,
    contract: null,
    pending: null,
    season: null,
    history: [],
    log: [],
    lastTen: [],
    honors: [],
    titles: [],
    news: [],
    longest: 0,
    unsignedWeeks: 0,
    draftNote: null,
    settings: { autoXp: false },
    summary: null,
  };
  const rng = rngFor(c, 'new');
  c.team = hsTeam(rng, kicker.school);
  c.rival = genRival(rng, C().camp.rival.hsSenior);
  c.pending = { kind: 'camp', title: `${c.team.name} kicking camp`, rival: c.rival, why: `${c.rival.name}, a senior, kicked last year. Beat him for the job.` };
  news(c, `${kicker.name} joins the ${c.team.name} as a junior from ${kicker.hometown || 'town'}.`);
  return c;
}

// ---------------------------------------------------------------------------
// Seasons and schedules

function makeSchedule(c: Career, rng: Rng): SchedGame[] {
  const lvl = stageLevel(c.stage);
  const n = C().seasons[lvl].games;
  const out: SchedGame[] = [];
  const used = new Set<string>();
  for (let i = 0; i < n; i++) {
    let opp: Team;
    if (lvl === 'hs') opp = { ...genHsOpp(rng, c.team!.name), strength: teamStrength(rng, 50, 12) };
    else if (lvl === 'college') {
      const pool = COLLEGES.filter((t) => t.name !== c.team!.name && (t.tier === c.team!.tier || rng.next() < 0.25) && !used.has(t.name));
      const t = rng.pick(pool.length ? pool : COLLEGES.filter((x) => x.name !== c.team!.name));
      used.add(t.name);
      const mean = t.tier === 'major' ? 68 : t.tier === 'mid' ? 54 : 42;
      opp = { ...t, strength: teamStrength(rng, mean, 8) };
    } else {
      const pool = NFL_TEAMS.filter((t) => t.name !== c.team!.name && !used.has(t.name));
      const t = rng.pick(pool);
      used.add(t.name);
      opp = { ...t, strength: teamStrength(rng, 50, 10) };
    }
    out.push({ week: i + 1, opp, home: i % 2 === (rng.next() < 0.5 ? 0 : 1), playoff: false, ...weatherFor(rng, i / n, lvl) });
  }
  return out;
}

function startSeason(c: Career) {
  const rng = rngFor(c, 'season');
  const lvl = stageLevel(c.stage);
  c.level = lvl;
  if (c.team) {
    const mean = lvl === 'hs' ? 52 : lvl === 'college' ? (c.team.tier === 'major' ? 70 : c.team.tier === 'mid' ? 56 : 46) : 50;
    c.team.strength = teamStrength(rng, mean, lvl === 'nfl' ? 10 : 9);
  }
  c.schedule = c.role === 'unsigned' ? [] : makeSchedule(c, rng);
  c.week = 0;
  c.inSeason = true;
  c.drillDone = false;
  c.rivalForm = [];
  c.season = blankLine(c);
  c.pending = null;
}

export function currentGame(c: Career): SchedGame | null {
  return c.inSeason && c.role !== 'unsigned' ? c.schedule[c.week] ?? null : null;
}

export function gameSetup(c: Career, g: SchedGame): GameSetup {
  return {
    level: stageLevel(c.stage),
    us: c.team!,
    them: g.opp,
    home: g.home,
    playoff: g.playoff,
    weather: g.weather,
    windMph: g.windMph,
    windToDeg: g.windToDeg,
    kicker: c.skills,
    kickerName: c.kicker.name,
    trust: c.trust,
    role: c.role,
    rival: c.rival,
    autoXp: c.settings.autoXp,
    seed: (c.seed ^ (c.year * 977 + c.week * 131 + c.seasonNo * 7)) >>> 0,
  };
}

// ---------------------------------------------------------------------------
// After a game

export interface GameSummary {
  game: SchedGame;
  pointsEarned: number;
  trustBefore: number;
  trustAfter: number;
  notes: string[];
}

export function recordGame(c0: Career, sim: GameSim): { career: Career; summary: GameSummary } {
  const c = clone(c0);
  const g = c.schedule[c.week];
  const rng = rngFor(c, 'record');
  let us = sim.us;
  let them = sim.them;
  const notes: string[] = [];
  if (g.playoff && us === them) {
    if (rng.next() < 0.5) us += 3;
    else them += 3;
    notes.push('Decided by a field goal in a later overtime.');
  }
  const kicks = sim.myKicks;
  const P = C().points;
  let pts = kicks.reduce((a, k) => a + kickPoints(k), 0);
  const fgs = kicks.filter((k) => !k.xp);
  if (kicks.length >= 2 && kicks.every((k) => k.made)) {
    pts += P.perfectGame;
    notes.push(`Perfect day: ${kicks.length} for ${kicks.length}.`);
  }
  const won = us > them;
  const gwMade = fgs.some((k) => k.gw && k.made);
  if (gwMade && won) {
    pts += P.gameWinner;
    notes.push('Game-winning kick.');
  }
  const bestToday = fgs.filter((k) => k.made).reduce((m, k) => Math.max(m, k.d), 0);
  if (bestToday > c.longest) {
    if (c.longest > 0) {
      pts += P.careerLong;
      notes.push(`New career long: ${bestToday} yards.`);
    }
    c.longest = bestToday;
  }
  if (bestToday > 66 && c.stage === 'nfl') notes.push(`NFL RECORD: ${bestToday} yards, breaking the record of 66.`);

  const trustBefore = c.trust;
  c.trust = Math.round(sim.trust);
  pts *= P.levelMult[stageLevel(c.stage)];
  c.points += pts;

  // Season line
  const s = c.season!;
  s.games += 1;
  if (won) s.w += 1;
  else if (us < them) s.l += 1;
  for (const k of kicks) {
    if (k.xp) {
      s.xpa += 1;
      if (k.made) s.xpm += 1;
    } else {
      s.fga += 1;
      if (k.made) {
        s.fgm += 1;
        s.long = Math.max(s.long, k.d);
      }
      if (c.stage === 'nfl') c.lastTen = [...c.lastTen, k.made].slice(-10);
    }
    if (k.made) s.points += k.xp ? 1 : 3;
    c.log.push({ d: k.d, made: k.made, xp: k.xp, stage: s.stage });
  }
  if (c.role === 'backup') c.rivalForm = [...c.rivalForm, ...sim.rivalKicks.filter((k) => !k.xp).map((k) => k.made)].slice(-6);

  g.result = { us, them, kicks, pointsEarned: pts, trustBefore, trustAfter: c.trust, notes, ot: sim.ot };
  const resTxt = `${won ? 'Beat' : us < them ? 'Lost to' : 'Tied'} ${g.opp.name} ${us}-${them}`;
  const fgTxt = fgs.length ? ` · ${fgs.filter((k) => k.made).length}/${fgs.length} FG` : '';
  news(c, `${g.label ? g.label + ': ' : `Week ${g.week}: `}${resTxt}${fgTxt}.`);
  for (const n of notes) news(c, n);

  jobChecks(c, rng, notes);
  c.week += 1;
  c.drillDone = false;
  advanceSchedule(c, rng);
  return { career: c, summary: { game: g, pointsEarned: pts, trustBefore, trustAfter: c.trust, notes } };
}

function jobChecks(c: Career, rng: Rng, notes: string[]) {
  if (c.role === 'backup') {
    const misses = c.rivalForm.slice(-4).filter((m) => !m).length;
    const injured = rng.next() < 0.03;
    if (misses >= 2 || injured) {
      const why = injured ? `${c.rival?.name ?? 'The starter'} is hurt.` : `${c.rival?.name ?? 'The starter'} has been missing.`;
      c.role = 'starter';
      if (c.season) c.season.role = 'starter';
      c.trust = Math.max(c.trust, 45);
      notes.push(`${why} You're the starter now.`);
      news(c, `${why} ${c.kicker.name} takes over as the starter.`);
    }
    return;
  }
  if (c.role !== 'starter') return;
  if (c.stage === 'nfl') {
    const att = c.lastTen.length;
    const pct = att ? c.lastTen.filter(Boolean).length / att : 1;
    if ((att >= 8 && pct < C().nfl.cutPct) || c.trust < C().nfl.cutTrust) {
      notes.push(`Released by the ${c.team!.name}.`);
      news(c, `The ${c.team!.name} release ${c.kicker.name}.`);
      c.role = 'unsigned';
      c.contract = null;
      c.lastTen = [];
      c.unsignedWeeks = 0;
      return;
    }
    if (att >= 6 && pct < C().nfl.hotSeatPct && !c.rival) {
      c.rival = genRival(rng, C().camp.rival.udfaVet);
      notes.push(`The ${c.team!.name} work out other kickers. ${c.rival.name} will be in camp.`);
      news(c, `Hot seat: the ${c.team!.name} bring in ${c.rival.name} for a workout.`);
    }
  } else if (c.trust < 15) {
    c.role = 'backup';
    if (c.season) c.season.role = 'backup';
    c.rival = genRival(rng, overall(c.skills) + 2);
    notes.push(`Benched. ${c.rival.name} will kick for now.`);
    news(c, `${c.kicker.name} is benched in favor of ${c.rival.name}.`);
  }
}

const PLAYOFF_LABELS = {
  hs: ['State Round 1', 'State Quarterfinal', 'State Semifinal', 'State Championship'],
  college: ['CFP First Round', 'CFP Quarterfinal', 'CFP Semifinal', 'National Championship'],
  nfl: ['Wild Card', 'Divisional Round', 'Conference Championship', 'Super Bowl'],
};

function advanceSchedule(c: Career, rng: Rng) {
  if (c.role === 'unsigned') return;
  const lvl = stageLevel(c.stage);
  const S = C().seasons;
  const regular = S[lvl].games;
  if (c.week < c.schedule.length) return;
  const last = c.schedule[c.schedule.length - 1];
  const s = c.season!;
  const labels = PLAYOFF_LABELS[lvl];

  let nextLabel: string | null = null;
  if (c.week === regular) {
    // End of the regular season: do we play on?
    if (lvl === 'hs' && s.w >= S.hs.playoffWins) nextLabel = labels[0];
    if (lvl === 'college') {
      if (s.w >= S.college.playoffWins) nextLabel = s.w >= 12 ? labels[1] : labels[0];
      else if (s.w >= S.college.bowlWins) nextLabel = 'Bowl Game';
    }
    if (lvl === 'nfl' && s.w >= S.nfl.playoffWins) nextLabel = s.w >= S.nfl.byeWins ? labels[1] : labels[0];
    if (nextLabel && nextLabel !== labels[0] && nextLabel !== 'Bowl Game') s.postseason = 'First-round bye';
  } else if (last.playoff && last.result && last.result.us > last.result.them) {
    const i = labels.indexOf(last.label ?? '');
    if (i >= 0 && i < labels.length - 1) nextLabel = labels[i + 1];
    else if (i === labels.length - 1) {
      const title = lvl === 'hs' ? 'State Champion' : lvl === 'college' ? 'National Champion' : 'Super Bowl Champion';
      s.postseason = title;
      c.titles.push(`${c.year} ${title}`);
      c.points += C().points.awards.champion;
      news(c, `${c.team!.name} win the ${labels[labels.length - 1]}!`);
    } else if (last.label === 'Bowl Game') s.postseason = 'Won bowl game';
  } else if (last.playoff && last.result) {
    s.postseason = last.label === 'Bowl Game' ? 'Lost bowl game' : `Lost in the ${last.label}`;
  }

  if (nextLabel) {
    const opp = lvl === 'hs' ? genHsOpp(rng, c.team!.name) : lvl === 'college' ? { ...rng.pick(COLLEGES.filter((t) => t.name !== c.team!.name)) } : { ...rng.pick(NFL_TEAMS.filter((t) => t.name !== c.team!.name)) };
    const g: SchedGame = {
      week: c.schedule.length + 1,
      opp: { ...opp, strength: teamStrength(rng, lvl === 'college' && c.team!.tier !== 'major' ? 64 : 62, 7) },
      home: rng.next() < 0.5,
      label: nextLabel,
      playoff: true,
      ...weatherFor(rng, 1, lvl),
    };
    c.schedule.push(g);
    news(c, `${c.team!.name} advance to the ${nextLabel}.`);
    return;
  }
  if (!s.postseason && c.week === regular) s.postseason = 'No postseason';
  endSeason(c);
}

// ---------------------------------------------------------------------------
// Season end, honors, transitions

function seasonHonors(c: Career): string[] {
  const s = c.season!;
  const H = C().honors;
  const pct = s.fga ? s.fgm / s.fga : 0;
  const out: string[] = [];
  if (s.role === 'unsigned' || s.fga === 0) return out;
  if (s.stage === 'hs' && pct >= H.allState.pct && s.fgm >= H.allState.made && s.long >= H.allState.long) out.push('All-State');
  if (s.stage === 'college') {
    if (pct >= H.allConference.pct && s.fgm >= H.allConference.made) out.push(`All-${c.team?.conference ?? 'Conference'}`);
    if (pct >= H.allAmerican.pct && s.fgm >= H.allAmerican.made && s.long >= H.allAmerican.long) out.push('All-American');
    if (pct >= H.nationalAward.pct && s.fgm >= H.nationalAward.made && s.long >= H.nationalAward.long) out.push('National Kicker of the Year');
  }
  if (s.stage === 'nfl') {
    if (pct >= H.proBowl.pct && s.fgm >= H.proBowl.made) out.push('Pro Bowl');
    if (pct >= H.allPro.pct && s.fgm >= H.allPro.made && s.long >= H.allPro.long) out.push('First-team All-Pro');
  }
  return out;
}

function endSeason(c: Career) {
  const s = c.season!;
  c.inSeason = false;
  const honors = seasonHonors(c);
  const A = C().points.awards;
  for (const h of honors) {
    s.honors.push(h);
    c.honors.push(`${c.year} ${h}`);
    const bonus = h === 'All-State' ? A.allState : h.startsWith('All-') && h !== 'All-American' ? A.allConference : h === 'All-American' ? A.allAmerican : h === 'National Kicker of the Year' ? A.nationalAward : h === 'Pro Bowl' ? A.proBowl : A.allPro;
    c.points += bonus;
    news(c, `${c.kicker.name} named ${h}.`);
  }
  c.history.push(s);
  const notes: string[] = [];
  notes.push(`${s.w}-${s.l}${s.postseason ? ` · ${s.postseason}` : ''}`);
  if (s.fga) notes.push(`${s.fgm}/${s.fga} field goals (${Math.round((s.fgm / s.fga) * 100)}%), long ${s.long}`);
  c.pending = { kind: 'review', line: s, notes };
}

/** Called when the player leaves the season review. */
export function afterReview(c0: Career): Career {
  const c = clone(c0);
  c.age += 1;
  // Aging: Power slips late in a career.
  if (c.age >= C().agingStartAge) {
    const rng = rngFor(c, 'age');
    const loss = rng.int(C().agingPowerLoss[0], C().agingPowerLoss[1]);
    c.skills.power = clampSkill(c.skills.power - loss);
    news(c, `Age ${c.age}: Power slips by ${loss}.`);
    if (c.age >= C().agingTouchAge) {
      const a = rng.int(C().agingTouchLoss[0], C().agingTouchLoss[1]);
      const k = rng.int(C().agingTouchLoss[0], C().agingTouchLoss[1]);
      c.skills.accuracy = clampSkill(c.skills.accuracy - a);
      c.skills.consistency = clampSkill(c.skills.consistency - k);
      if (a + k > 0) news(c, `The touch fades a little: Accuracy -${a}, Consistency -${k}.`);
    }
  }
  if (c.stage === 'nfl' && c.contract) c.contract.years -= 1;
  c.pending = { kind: 'offseason', campDone: false };
  return c;
}

/** Called when the player finishes the offseason (camp, skills). Moves the career on. */
export function finishOffseason(c0: Career): Career {
  const c = clone(c0);
  const rng = rngFor(c, 'offseason');
  c.year += 1;

  if (c.stage === 'hs') {
    if (c.seasonNo === 1) {
      c.pending = { kind: 'showcase', purpose: 'recruiting' };
      return c;
    }
    c.pending = { kind: 'offers', title: 'College offers', offers: collegeOffers(c, rng) };
    return c;
  }
  if (c.stage === 'college') {
    if (c.seasonNo >= 3) {
      c.pending = { kind: 'declare', forced: c.seasonNo >= 4 };
      return c;
    }
    c.seasonNo += 1;
    return nextSeasonSameTeam(c, rng);
  }
  if (c.stage === 'nfl') {
    if (c.age >= C().retireAge) return retire(c, 'Retires at the end of a long career.');
    if (c.role === 'unsigned') {
      if (c.unsignedWeeks >= 17 * C().nfl.seasonsUnsignedToRetire + 10) return retire(c, 'No team calls. The career ends.');
      const offers = freeAgentOffers(c, rng);
      c.seasonNo += 1;
      if (offers.length) {
        c.pending = { kind: 'offers', title: 'Free-agent offers', offers };
        return c;
      }
      news(c, 'No offers this offseason. Stay ready for a call.');
      startSeason(c);
      c.season!.label = seasonLabel(c);
      return c;
    }
    c.seasonNo += 1;
    if (c.contract && c.contract.years <= 0) {
      const last = c.history[c.history.length - 1];
      const pct = last && last.fga ? last.fgm / last.fga : 0;
      if (pct >= 0.8 && c.age < 40) {
        const contract = { years: rng.int(C().nfl.contractYears.resign[0], C().nfl.contractYears.resign[1]), salary: +(1.2 + Math.max(0, overall(c.skills) - 70) * C().nfl.veteranSalaryPerOvr * 3).toFixed(2) };
        c.pending = {
          kind: 'offers',
          title: 'Contract offers',
          offers: [
            { id: 'resign', kind: 'freeAgent', team: c.team!, title: `Re-sign with the ${c.team!.name}`, note: `${contract.years} years, $${contract.salary.toFixed(2)}M a year. The job is yours.`, rivalOvr: null, contract },
            ...freeAgentOffers(c, rng),
          ],
        };
        return c;
      }
      news(c, `The ${c.team!.name} let ${c.kicker.name} walk.`);
      c.team = null;
      c.role = 'unsigned';
      c.contract = null;
      const offers = freeAgentOffers(c, rng);
      if (offers.length) {
        c.pending = { kind: 'offers', title: 'Free-agent offers', offers };
        return c;
      }
      startSeason(c);
      return c;
    }
    return nextSeasonSameTeam(c, rng);
  }
  return c;
}

function nextSeasonSameTeam(c: Career, rng: Rng): Career {
  if (c.role === 'backup' || (c.stage === 'nfl' && c.rival)) {
    const rival = c.rival ?? genRival(rng, overall(c.skills));
    c.rival = rival;
    c.pending = { kind: 'camp', title: `${c.team!.name} camp`, rival, why: c.role === 'backup' ? `Win the job from ${rival.name}.` : `${rival.name} is here to take your job.` };
    return c;
  }
  c.rival = null;
  startSeason(c);
  return c;
}

// ---------------------------------------------------------------------------
// Camp battles, showcases, offers, the draft, tryouts

export function campKicks(): number[] {
  return C().camp.kicks;
}

/** Rival's camp results for a given rival overall (seeded). */
export function rivalCampResults(c: Career, rival: Rival): boolean[] {
  const rng = rngFor(c, `camp-${rival.name}`);
  const s = evenSkills(rival.overall);
  return campKicks().map((d) => rng.next() < campProb(s, d));
}

function campProb(s: ReturnType<typeof evenSkills>, d: number): number {
  // Camp kicks are calm-day kicks.
  const range = 40 + (26 * (s.power - 40)) / 59;
  const acc = 0.9 + (0.09 * (s.accuracy - 40)) / 59;
  return Math.max(0.02, Math.min(0.99, acc / (1 + Math.exp((d - (range - 2)) / 3.5))));
}

export function resolveCamp(c0: Career, mine: boolean[], rivals: boolean[]): Career {
  const c = clone(c0);
  const p = c.pending;
  if (!p || p.kind !== 'camp') return c;
  const m = mine.filter(Boolean).length;
  const r = rivals.filter(Boolean).length;
  // A tie goes to whoever made the longer kicks: the coach remembers the leg.
  const reach = (res: boolean[]) => res.reduce((a, made, i) => a + (made ? campKicks()[i] ?? 0 : 0), 0);
  const win = m > r || (m === r && reach(mine) >= reach(rivals));
  const lvl = stageLevel(c.stage);
  if (win) {
    c.role = 'starter';
    c.trust = Math.max(c.trust, C().trust.start[lvl]);
    news(c, `${c.kicker.name} wins the kicking job (${m}-${r} in camp).`);
    c.rival = null;
  } else {
    news(c, `${p.rival.name} wins the camp battle ${r}-${m}.`);
    if (c.stage === 'nfl') {
      news(c, `The ${c.team!.name} release ${c.kicker.name}.`);
      c.role = 'unsigned';
      c.team = null;
      c.contract = null;
      c.rival = null;
    } else {
      c.role = 'backup';
      c.rival = p.rival;
    }
  }
  startSeason(c);
  return c;
}

export function applyShowcase(c0: Career, makes: boolean[]): Career {
  const c = clone(c0);
  const p = c.pending;
  if (!p || p.kind !== 'showcase') return c;
  const m = makes.filter(Boolean).length;
  if (p.purpose === 'recruiting') {
    const s = c.history.filter((h) => h.stage === 'hs');
    const fga = s.reduce((a, h) => a + h.fga, 0);
    const fgm = s.reduce((a, h) => a + h.fgm, 0);
    const long = s.reduce((a, h) => Math.max(a, h.long), 0);
    const score = (overall(c.skills) - 30) * 1.3 + (fga ? fgm / fga : 0.6) * 20 + Math.max(0, long - 30) * 0.8 + m * 4;
    c.recruitScore = Math.round(score);
    c.stars = Math.max(2, 1 + C().recruiting.starCuts.filter((cut) => score >= cut).length);
    news(c, `Summer showcase: ${m}/${makes.length}. Recruiting services rate ${c.kicker.name} a ${c.stars}-star kicker.`);
    c.seasonNo = 2;
    c.rival = null;
    c.role = 'starter';
    startSeason(c);
    // Offers start arriving during the senior year.
    news(c, `${c.stars! >= 4 ? 'Big programs are' : 'Colleges are'} watching ${c.kicker.name}'s senior year.`);
    return c;
  }
  // Draft showcase
  const coll = c.history.filter((h) => h.stage === 'college');
  const fga = coll.reduce((a, h) => a + h.fga, 0);
  const fgm = coll.reduce((a, h) => a + h.fgm, 0);
  const long = coll.reduce((a, h) => Math.max(a, h.long), 0);
  const honors = coll.reduce((a, h) => a + h.honors.length, 0);
  const stock = overall(c.skills) * 0.5 + (fga ? fgm / fga : 0.6) * 20 + Math.max(0, long - 40) * 0.6 + m * 2.5 + Math.min(4, honors) * 2;
  const rng = rngFor(c, 'draft');
  const D = C().draft;
  c.stage = 'draft';
  if (stock >= D.draftedScore) {
    const round = stock >= D.earlyScore ? 5 : rng.next() < 0.5 ? 6 : 7;
    const pick = rng.int(1, 32);
    const t = rng.pick(NFL_TEAMS);
    const team: Team = { ...t, strength: 50 };
    const contract: Contract = { years: C().nfl.contractYears.drafted, salary: +rng.range(C().nfl.rookieSalary[0], C().nfl.rookieSalary[1]).toFixed(2) };
    const offer: Offer = { id: 'draft', kind: 'drafted', team, title: `Drafted by the ${t.name}`, note: `Round ${round}, pick ${pick}. ${contract.years}-year rookie deal at $${contract.salary.toFixed(2)}M a year.`, rivalOvr: C().camp.rival.nflIncumbent, contract };
    c.draftNote = `Round ${round}, pick ${pick} (${t.short})`;
    c.pending = { kind: 'draftResult', text: `Showcase: ${m}/${makes.length}. With pick ${pick} of round ${round}, the ${t.name} select ${c.kicker.name}.`, drafted: true, offer };
    news(c, `${c.kicker.name} drafted by the ${t.name} in round ${round}.`);
  } else {
    c.draftNote = 'Undrafted';
    c.pending = { kind: 'draftResult', text: `Showcase: ${m}/${makes.length}. Seven rounds go by without a call. Teams want you in camp as an undrafted free agent.`, drafted: false, offer: null };
    news(c, `${c.kicker.name} goes undrafted.`);
  }
  return c;
}

export function afterDraftResult(c0: Career): Career {
  const c = clone(c0);
  const p = c.pending;
  if (!p || p.kind !== 'draftResult') return c;
  if (p.drafted && p.offer) return chooseOffer(c, p.offer);
  const rng = rngFor(c, 'udfa');
  const teams = [...NFL_TEAMS].sort(() => rng.next() - 0.5).slice(0, 3);
  c.pending = {
    kind: 'offers',
    title: 'Undrafted free-agent offers',
    offers: teams.map((t, i) => ({
      id: `udfa${i}`,
      kind: 'udfa' as const,
      team: { ...t, strength: 50 },
      title: `${t.name}`,
      note: i === 0 ? 'Incumbent is shaky. Best shot at the job.' : i === 1 ? 'Solid veteran in camp.' : 'Strong veteran; you are a camp leg.',
      rivalOvr: [70, 76, 82][i],
      contract: { years: C().nfl.contractYears.udfa, salary: C().nfl.udfaSalary },
    })),
  };
  return c;
}

function collegeOffers(c: Career, rng: Rng): Offer[] {
  const stars = c.stars ?? 2;
  const R = C().camp.rival;
  const pick = (tier: 'major' | 'mid' | 'small') => rng.pick(COLLEGES.filter((t) => t.tier === tier));
  const team = (t: (typeof COLLEGES)[number]): Team => ({ ...t, strength: 50 });
  const out: Offer[] = [];
  const small = pick('small');
  out.push({ id: 'small', kind: 'starter', team: team(small), title: small.name, note: `${small.conference}. The starting job is yours from day one. Less exposure.`, rivalOvr: null });
  if (stars >= 3) {
    const mid = pick('mid');
    out.push({ id: 'mid', kind: 'scholarship', team: team(mid), title: mid.name, note: `${mid.conference} scholarship. Compete with a returning kicker.`, rivalOvr: stars >= 4 ? R.midSchool - 6 : R.midSchool });
    const major = pick('major');
    out.push({ id: 'major', kind: stars >= 5 ? 'scholarship' : 'walkon', team: team(major), title: major.name, note: stars >= 5 ? `${major.conference} scholarship. Big stage, real competition.` : `${major.conference} preferred walk-on. Biggest stage, hardest fight.`, rivalOvr: stars >= 5 ? R.majorProgram - 6 : R.majorProgram });
  } else {
    const mid = pick('mid');
    out.push({ id: 'mid', kind: 'walkon', team: team(mid), title: mid.name, note: `${mid.conference} walk-on spot. Earn it in camp.`, rivalOvr: R.midSchool + 2 });
  }
  return out;
}

function freeAgentOffers(c: Career, rng: Rng): Offer[] {
  const ovr = overall(c.skills) - Math.max(0, c.age - 36) * 2; // teams shy away from old legs
  const n = ovr >= 80 ? 2 : ovr >= 72 ? (rng.next() < 0.6 ? 1 : 0) : rng.next() < 0.25 ? 1 : 0;
  const teams = [...NFL_TEAMS].filter((t) => t.name !== c.team?.name).sort(() => rng.next() - 0.5).slice(0, n);
  return teams.map((t, i) => ({
    id: `fa${i}`,
    kind: 'freeAgent' as const,
    team: { ...t, strength: 50 },
    title: t.name,
    note: 'One-year deal. Win the camp battle.',
    rivalOvr: Math.round(72 + rng.next() * 8),
    contract: { years: 1, salary: +(1 + Math.max(0, ovr - 70) * C().nfl.veteranSalaryPerOvr).toFixed(2) },
  }));
}

export function chooseOffer(c0: Career, offer: Offer): Career {
  const c = clone(c0);
  const rng = rngFor(c, `offer-${offer.id}`);
  const fromHs = c.stage === 'hs';
  if (fromHs) {
    c.stage = 'college';
    c.seasonNo = 1;
    news(c, `${c.kicker.name} commits to ${offer.team.name}.`);
  } else if (c.stage === 'draft' || offer.kind === 'drafted' || offer.kind === 'udfa') {
    c.stage = 'nfl';
    c.seasonNo = 1;
    news(c, `${c.kicker.name} signs with the ${offer.team.name}.`);
  } else news(c, `${c.kicker.name} signs with the ${offer.team.name}.`);
  const resign = offer.id === 'resign';
  c.team = { ...offer.team };
  c.level = stageLevel(c.stage);
  c.contract = offer.contract ?? null;
  c.lastTen = resign ? c.lastTen : [];
  if (!resign) c.trust = C().trust.start[c.level];
  if (offer.rivalOvr === null) {
    c.role = 'starter';
    c.rival = null;
    startSeason(c);
  } else {
    c.rival = genRival(rng, offer.rivalOvr);
    c.role = 'backup';
    c.pending = { kind: 'camp', title: `${offer.team.name} camp`, rival: c.rival, why: `${c.rival.name} is the kicker to beat.` };
  }
  return c;
}

export function declareForDraft(c0: Career, declare: boolean): Career {
  const c = clone(c0);
  if (declare) {
    news(c, `${c.kicker.name} declares for the NFL draft.`);
    c.pending = { kind: 'showcase', purpose: 'draft' };
    return c;
  }
  c.seasonNo += 1;
  news(c, `${c.kicker.name} returns to ${c.team!.name} for another season.`);
  return nextSeasonSameTeam(c, rngFor(c, 'stay'));
}

/** A week passes while unsigned. Maybe a team calls for a tryout. */
export function simUnsignedWeek(c0: Career): Career {
  const c = clone(c0);
  const rng = rngFor(c, 'unsigned');
  c.week += 1;
  c.unsignedWeeks += 1;
  if (c.week >= C().seasons.nfl.games) {
    c.season!.postseason = 'Unsigned';
    endSeason(c);
    return c;
  }
  const chance = C().nfl.tryoutChancePerWeek * (overall(c.skills) >= 72 ? 1.2 : 0.8);
  if (rng.next() < chance) {
    const t = rng.pick(NFL_TEAMS);
    c.pending = { kind: 'tryout', team: { ...t, strength: teamStrength(rng, 50, 10) }, contract: { years: 1, salary: C().nfl.udfaSalary } };
    news(c, `The ${t.name} call. Their kicker is hurt. Tryout on Tuesday.`);
  } else news(c, `Week ${c.week}: no calls. Keep kicking.`);
  return c;
}

export function tryoutKicks(): number[] {
  return [35, 42, 48, 52];
}

export function resolveTryout(c0: Career, makes: boolean[]): Career {
  const c = clone(c0);
  const p = c.pending;
  if (!p || p.kind !== 'tryout') return c;
  const m = makes.filter(Boolean).length;
  if (m >= 3) {
    c.team = p.team;
    c.contract = p.contract;
    c.role = 'starter';
    c.trust = 45;
    c.lastTen = [];
    c.unsignedWeeks = 0;
    c.pending = null;
    const rng = rngFor(c, 'signed');
    const remaining = Math.max(1, C().seasons.nfl.games - c.week);
    const sched = makeSchedule({ ...c, schedule: [] }, rng).slice(0, remaining);
    // Weeks before signing stay as placeholders so week numbers line up.
    const before: SchedGame[] = Array.from({ length: c.week }, (_, i) => ({
      ...sched[0],
      week: i + 1,
      opp: { ...sched[0].opp, name: 'Not on the roster', short: '—' },
      label: 'Not on the roster',
      result: { us: 0, them: 0, kicks: [], pointsEarned: 0, trustBefore: 0, trustAfter: 0, notes: [], ot: false },
    }));
    c.schedule = [...before, ...sched.map((g, i) => ({ ...g, week: c.week + i + 1 }))];
    c.season = { ...c.season!, team: c.team.name, teamShort: c.team.short, role: 'starter' };
    news(c, `${c.kicker.name} hits ${m}/${makes.length} and signs with the ${c.team.name}.`);
  } else {
    c.pending = null;
    news(c, `Tryout with the ${p.team.name}: ${m}/${makes.length}. They sign someone else.`);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Practice, camps and skills

export function spendPoint(c0: Career, key: SkillKey): Career {
  const c = clone(c0);
  const cost = levelCost(c.skills[key]);
  if (c.points < cost || c.skills[key] >= 99) return c0;
  c.points -= cost;
  c.skills[key] += 1;
  return c;
}

/** Weekly drill: points go into the chosen skill. */
export function applyDrill(c0: Career, key: SkillKey, makes: boolean[]): Career {
  const c = clone(c0);
  let bank = makes.filter(Boolean).length * C().points.drillPerMake + (c.drillBank ?? 0);
  const start = c.skills[key];
  while (bank >= levelCost(c.skills[key]) && c.skills[key] < 99) {
    bank -= levelCost(c.skills[key]);
    c.skills[key] += 1;
  }
  c.drillBank = bank; // carries toward the next drill
  c.drillDone = true;
  const gained = c.skills[key] - start;
  news(c, `Drill: ${makes.filter(Boolean).length}/${makes.length}. ${gained > 0 ? `+${gained} ${key === 'windControl' ? 'wind control' : key}` : 'No level gained'}${bank ? `, ${bank} toward the next level` : ''}.`);
  return c;
}

export function applyOffseasonCamp(c0: Career, makes: boolean[]): Career {
  const c = clone(c0);
  const m = makes.filter(Boolean).length;
  const pts = Math.round((C().points.campBase + m * C().points.campPerMake) * (c.stage === 'nfl' ? 0.7 : 1));
  c.points += pts;
  if (c.pending?.kind === 'offseason') c.pending = { kind: 'offseason', campDone: true };
  news(c, `Offseason camp: ${m}/${makes.length}. +${pts} skill points.`);
  return c;
}

export function toggleAutoXp(c0: Career): Career {
  const c = clone(c0);
  c.settings.autoXp = !c.settings.autoXp;
  return c;
}

// ---------------------------------------------------------------------------
// Retirement

export function careerTotals(c: Career) {
  const all = c.history;
  const sum = (f: (s: SeasonLine) => number) => all.reduce((a, s) => a + f(s), 0);
  const nfl = all.filter((s) => s.stage === 'nfl');
  return {
    fgm: sum((s) => s.fgm),
    fga: sum((s) => s.fga),
    xpm: sum((s) => s.xpm),
    xpa: sum((s) => s.xpa),
    points: sum((s) => s.points),
    nflPoints: nfl.reduce((a, s) => a + s.points, 0),
    nflSeasons: nfl.filter((s) => s.games > 0).length,
    nflFgm: nfl.reduce((a, s) => a + s.fgm, 0),
    nflFga: nfl.reduce((a, s) => a + s.fga, 0),
  };
}

export function hallOfFameVerdict(c: Career): { verdict: string; note: string } {
  const t = careerTotals(c);
  const H = C().hallOfFame;
  const bigHonors = c.honors.filter((h) => /Pro Bowl|All-Pro/.test(h)).length;
  const sb = c.titles.filter((h) => /Super Bowl/.test(h)).length;
  const score = t.nflPoints / H.points + bigHonors / H.honors + (c.longest >= H.longFg ? 0.3 : 0) + sb * 0.25;
  if (score >= 2.2) return { verdict: 'First-ballot Hall of Famer', note: 'A gold jacket on the first try. One of the best to ever do it.' };
  if (score >= 1.5) return { verdict: 'Hall of Famer', note: 'Enshrined in Canton after a short wait.' };
  if (score >= 1) return { verdict: 'Hall of Fame finalist', note: 'Close. The voters keep talking about you.' };
  if (t.nflSeasons >= 6) return { verdict: 'Respected veteran', note: 'A long, steady NFL career. Not Canton, but plenty of teams were glad to have you.' };
  if (t.nflSeasons >= 1) return { verdict: 'Made it to the NFL', note: 'Most kickers never get here. You did.' };
  return { verdict: 'The road ended early', note: 'The NFL never came, but the kicks were real.' };
}

export function retire(c0: Career, why = 'Hangs up the cleats.'): Career {
  const c = clone(c0);
  if (c.season && c.inSeason) {
    c.history.push(c.season);
    c.inSeason = false;
  }
  const t = careerTotals(c);
  const v = hallOfFameVerdict(c);
  const summary: CareerSummary = {
    points: t.points,
    fgm: t.fgm,
    fga: t.fga,
    xpm: t.xpm,
    xpa: t.xpa,
    longest: c.longest,
    nflPoints: t.nflPoints,
    nflSeasons: t.nflSeasons,
    honors: c.honors,
    titles: c.titles,
    verdict: v.verdict,
    verdictNote: v.note,
  };
  c.summary = summary;
  c.stage = 'retired';
  c.pending = { kind: 'retired' };
  news(c, `${c.kicker.name} retires. ${why}`);
  return c;
}

export function campCost(from: number, to: number) {
  return costToRaise(from, to);
}

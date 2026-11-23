// League standings and the playoff race. Other teams' results are simulated week by week.

import { CONFIG } from '../config';
import type { Rng } from '../sim/rng';
import { AFC, NFL_TEAMS } from './data';
import { stageLevel } from './progression';
import type { Career, Team } from './types';

export interface StandingRow {
  name: string;
  short: string;
  primary: string;
  strength: number;
  w: number;
  l: number;
  me: boolean;
}

export interface Standings {
  title: string;
  rows: StandingRow[];
}

const row = (t: Team, me = false): StandingRow => ({ name: t.name, short: t.short, primary: t.primary, strength: t.strength, w: 0, l: 0, me });

export function buildStandings(c: Career, rng: Rng): Standings | null {
  if (!c.team) return null;
  const lvl = stageLevel(c.stage);
  if (lvl === 'nfl') {
    const afc = AFC.has(c.team.short);
    const conf = NFL_TEAMS.filter((t) => AFC.has(t.short) === afc);
    const rows = conf.map((t) => {
      const sched = c.schedule.find((g) => g.opp.short === t.short);
      const strength = t.short === c.team!.short ? c.team!.strength : sched ? sched.opp.strength : Math.round(50 + rng.normal() * 10);
      return { ...row({ ...t, strength }, t.short === c.team!.short) };
    });
    return { title: afc ? 'AFC standings' : 'NFC standings', rows };
  }
  const seen = new Set<string>();
  const rows: StandingRow[] = [row(c.team, true)];
  for (const g of c.schedule) {
    if (g.playoff || seen.has(g.opp.name)) continue;
    seen.add(g.opp.name);
    rows.push(row(g.opp));
  }
  return { title: lvl === 'hs' ? 'Region standings' : 'Schedule standings', rows };
}

/** One week of results for everyone else. `oppName` lost/won against us per `weWon`. */
export function advanceStandings(st: Standings, rng: Rng, oppName: string | null, weWon: boolean | null) {
  for (const r of st.rows) {
    if (r.me) {
      if (weWon === true) r.w++;
      else if (weWon === false) r.l++;
      continue;
    }
    if (r.name === oppName) {
      if (weWon) r.l++;
      else if (weWon === false) r.w++;
      continue;
    }
    const p = 1 / (1 + Math.exp(-(r.strength - 50) / 11));
    if (rng.next() < p) r.w++;
    else r.l++;
  }
}

export function sorted(st: Standings): StandingRow[] {
  return [...st.rows].sort((a, b) => b.w - a.w || a.l - b.l || b.strength - a.strength);
}

/** NFL seed (1-based) of my team in the current standings. */
export function mySeed(st: Standings): number {
  return sorted(st).findIndex((r) => r.me) + 1;
}

export interface RaceStatus {
  text: string;
  state: 'clinched' | 'alive' | 'out' | 'done';
  line: number | null; // wins needed (HS/college) or seeds (NFL)
}

export function playoffRace(c: Career): RaceStatus | null {
  const s = c.season;
  if (!s || !c.team || c.role === 'unsigned') return null;
  const lvl = stageLevel(c.stage);
  const S = CONFIG.career.seasons;
  const total = S[lvl].games;
  const played = s.w + s.l;
  const left = Math.max(0, total - played);
  if (played >= total) {
    const p = s.postseason || (c.schedule.some((g) => g.playoff) ? 'Postseason' : '');
    return { text: p || 'Regular season over', state: 'done', line: null };
  }
  if (lvl === 'nfl') {
    const st = c.standings;
    if (!st) return null;
    const seed = mySeed(st);
    const rows = sorted(st);
    const cut = rows[S.nfl.playoffSeeds - 1];
    const firstOut = rows[S.nfl.playoffSeeds];
    const me = rows[seed - 1];
    if (seed <= S.nfl.playoffSeeds && firstOut && me.w > firstOut.w + left) return { text: `Clinched a playoff spot (${seed} seed)`, state: 'clinched', line: S.nfl.playoffSeeds };
    if (seed > S.nfl.playoffSeeds && cut && me.w + left < cut.w) return { text: 'Eliminated from playoff contention', state: 'out', line: S.nfl.playoffSeeds };
    return {
      text: seed <= S.nfl.playoffSeeds ? `In: ${seed} seed with ${left} to play${seed === 1 ? ' (bye)' : ''}` : `Out: ${seed}th, ${cut ? Math.max(1, cut.w - me.w) : 1} game${cut && cut.w - me.w > 1 ? 's' : ''} back of the 7 seed`,
      state: 'alive',
      line: S.nfl.playoffSeeds,
    };
  }
  const need = lvl === 'hs' ? S.hs.playoffWins : S.college.playoffWins;
  const bowl = lvl === 'college' ? S.college.bowlWins : null;
  if (s.w >= need) return { text: `Clinched: ${s.w} wins${lvl === 'college' ? ', in the playoff' : ', in the state playoffs'}`, state: 'clinched', line: need };
  if (s.w + left < need) {
    if (bowl !== null && s.w + left >= bowl) return { text: s.w >= bowl ? 'Bowl eligible. The playoff is out of reach.' : `Need ${bowl - s.w} more win${bowl - s.w > 1 ? 's' : ''} for a bowl game`, state: s.w >= bowl ? 'clinched' : 'alive', line: bowl };
    return { text: 'Eliminated from the postseason', state: 'out', line: need };
  }
  return { text: `Need ${need - s.w} more win${need - s.w > 1 ? 's' : ''} in ${left} game${left > 1 ? 's' : ''} for the ${lvl === 'hs' ? 'state playoffs' : 'playoff'}`, state: 'alive', line: need };
}

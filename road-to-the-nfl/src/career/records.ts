// The record book: school records in high school, program records in college, NFL records in the pros.
// Each record keeps the old mark and holder; yours is tracked alongside and called out when you pass it.

import { CONFIG } from '../config';
import type { Rng } from '../sim/rng';
import type { Career, KickLog } from './types';

export type RecordScope = 'school' | 'program' | 'conference' | 'fbs' | 'nfl';
export type RecordKind = 'longest' | 'gameFg' | 'seasonFg' | 'careerFg' | 'careerPts' | 'streak';

export interface RecordEntry {
  kind: RecordKind;
  label: string;
  value: number; // the mark to beat
  holder: string;
  mine: number;
  brokenYear: number | null;
}

export interface RecordBook {
  scope: RecordScope;
  name?: string; // used in callouts: "Big Ten", "college football"
  title: string; // "Lakeview High Lions records", "Toledo records", "NFL records"
  entries: RecordEntry[];
  streakNow: number;
}

const LABELS: Record<RecordKind, string> = {
  longest: 'Longest field goal',
  gameFg: 'Field goals in a game',
  seasonFg: 'Field goals in a season',
  careerFg: 'Career field goals',
  careerPts: 'Career points',
  streak: 'Consecutive field goals made',
};

export const SCOPE_NAME: Record<RecordScope, string> = { school: 'school', program: 'program', conference: 'conference', fbs: 'college football', nfl: 'NFL' };

/** Name used in callouts ("NEW BIG TEN RECORD"). */
export function bookName(b: RecordBook): string {
  return b.name ?? SCOPE_NAME[b.scope];
}

/** Higher scopes are bigger deals. */
export const PRESTIGE: Record<RecordScope, number> = { school: 1, program: 2, conference: 3, fbs: 4, nfl: 5 };

export function makeRecordBook(scope: RecordScope, teamName: string, tier: string | undefined, rng: Rng, holderName: () => string, conference?: string): RecordBook {
  let marks: Record<RecordKind, number>;
  if (scope === 'nfl') marks = { ...CONFIG.career.records.nfl };
  else if (scope === 'fbs') marks = { ...CONFIG.career.records.fbs, streak: 0 };
  else if (scope === 'conference') marks = { longest: rng.int(57, 61), gameFg: 6, seasonFg: rng.int(25, 28), careerFg: rng.int(76, 88), careerPts: rng.int(400, 460), streak: rng.int(24, 30) };
  else if (scope === 'school') marks = { longest: rng.int(44, 51), gameFg: rng.int(3, 4), seasonFg: rng.int(9, 13), careerFg: rng.int(18, 26), careerPts: rng.int(150, 220), streak: rng.int(10, 15) };
  else {
    const big = tier === 'major' ? 2 : tier === 'mid' ? 1 : 0;
    marks = { longest: rng.int(52, 56) + big, gameFg: 5, seasonFg: rng.int(21, 25) + big, careerFg: rng.int(58, 70) + big * 3, careerPts: rng.int(320, 400) + big * 20, streak: rng.int(18, 25) };
  }
  // No reliable FBS mark exists for consecutive makes, so that book leaves it out.
  const kinds: RecordKind[] = scope === 'fbs' ? ['longest', 'gameFg', 'seasonFg', 'careerFg', 'careerPts'] : ['longest', 'gameFg', 'seasonFg', 'careerFg', 'careerPts', 'streak'];
  const title = scope === 'nfl' ? 'NFL records' : scope === 'fbs' ? 'College football (FBS) records' : scope === 'conference' ? `${conference} records` : `${teamName} records`;
  const name = scope === 'conference' ? conference : undefined;
  return {
    scope,
    name,
    title,
    streakNow: 0,
    entries: kinds.map((kind) => ({
      kind,
      label: LABELS[kind] + (scope === 'fbs' && kind === 'careerPts' ? ' (kicking)' : ''),
      value: marks[kind],
      holder: scope === 'nfl' ? 'NFL record' : scope === 'fbs' ? 'FBS record' : holderName(),
      mine: 0,
      brokenYear: null,
    })),
  };
}

/** Best mark to beat for the longest field goal right now (the old record or your own, whichever is longer). */
export function longestToBeat(book: RecordBook | null | undefined): number | null {
  const e = book?.entries.find((x) => x.kind === 'longest');
  return e ? Math.max(e.value, e.mine) : null;
}

/** The books a game counts toward right now. */
export function activeBooks(c: Career): RecordBook[] {
  const books = c.records ? [c.records] : [];
  if (c.stage === 'college') books.push(...(c.collegeBooks ?? []));
  return books;
}

/** Longest-field-goal marks to beat, biggest stage first (for the in-kick callout). */
export function longTargets(c: Career): { value: number; scope: string }[] {
  return activeBooks(c)
    .sort((a, b) => PRESTIGE[b.scope] - PRESTIGE[a.scope])
    .map((b) => ({ value: longestToBeat(b) ?? 999, scope: bookName(b) }));
}

export interface RecordCall {
  text: string;
  scope: RecordScope;
}

/** Update every active book after a game. Returns callouts for records broken in this game. */
export function updateRecords(c: Career, kicks: KickLog[], seasonFgm: number): RecordCall[] {
  const calls: RecordCall[] = [];
  for (const book of activeBooks(c)) calls.push(...updateBook(c, book, kicks, seasonFgm));
  return calls.sort((a, b) => PRESTIGE[b.scope] - PRESTIGE[a.scope]);
}

function updateBook(c: Career, book: RecordBook, kicks: KickLog[], seasonFgm: number): RecordCall[] {
  const fgs = kicks.filter((k) => !k.xp);
  const made = fgs.filter((k) => k.made);
  const pts = kicks.reduce((a, k) => a + (k.made ? (k.xp ? 1 : 3) : 0), 0);
  let bestRun = book.streakNow;
  for (const k of fgs) {
    book.streakNow = k.made ? book.streakNow + 1 : 0;
    bestRun = Math.max(bestRun, book.streakNow);
  }
  const calls: RecordCall[] = [];
  for (const e of book.entries) {
    const before = e.mine;
    switch (e.kind) {
      case 'longest':
        e.mine = Math.max(e.mine, ...made.map((k) => k.d), 0);
        break;
      case 'gameFg':
        e.mine = Math.max(e.mine, made.length);
        break;
      case 'seasonFg':
        e.mine = Math.max(e.mine, seasonFgm);
        break;
      case 'careerFg':
        e.mine += made.length;
        break;
      case 'careerPts':
        e.mine += pts;
        break;
      case 'streak':
        e.mine = Math.max(e.mine, bestRun);
        break;
    }
    if (e.brokenYear === null && e.mine > e.value && before <= e.value) {
      e.brokenYear = c.year;
      const unit = e.kind === 'longest' ? ` (${e.mine} yards)` : ` (${e.mine})`;
      calls.push({ scope: book.scope, text: `NEW ${bookName(book).toUpperCase()} RECORD: ${e.label.toLowerCase()}${unit}, passing ${e.value}.` });
    }
  }
  return calls;
}

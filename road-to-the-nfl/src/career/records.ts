// The record book: school records in high school, program records in college, NFL records in the pros.
// Each record keeps the old mark and holder; yours is tracked alongside and called out when you pass it.

import { CONFIG } from '../config';
import type { Rng } from '../sim/rng';
import type { Career, KickLog } from './types';

export type RecordScope = 'school' | 'program' | 'nfl';
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

export const SCOPE_NAME: Record<RecordScope, string> = { school: 'school', program: 'program', nfl: 'NFL' };

export function makeRecordBook(scope: RecordScope, teamName: string, tier: string | undefined, rng: Rng, holderName: () => string): RecordBook {
  let marks: Record<RecordKind, number>;
  if (scope === 'nfl') marks = { ...CONFIG.career.records.nfl };
  else if (scope === 'school') marks = { longest: rng.int(44, 51), gameFg: rng.int(3, 4), seasonFg: rng.int(9, 13), careerFg: rng.int(18, 26), careerPts: rng.int(150, 220), streak: rng.int(10, 15) };
  else {
    const big = tier === 'major' ? 2 : tier === 'mid' ? 1 : 0;
    marks = { longest: rng.int(52, 56) + big, gameFg: 5, seasonFg: rng.int(21, 25) + big, careerFg: rng.int(58, 70) + big * 3, careerPts: rng.int(320, 400) + big * 20, streak: rng.int(18, 25) };
  }
  const kinds: RecordKind[] = ['longest', 'gameFg', 'seasonFg', 'careerFg', 'careerPts', 'streak'];
  return {
    scope,
    title: scope === 'nfl' ? 'NFL records' : `${teamName} records`,
    streakNow: 0,
    entries: kinds.map((kind) => ({ kind, label: LABELS[kind], value: marks[kind], holder: scope === 'nfl' ? 'NFL record' : holderName(), mine: 0, brokenYear: null })),
  };
}

/** Best mark to beat for the longest field goal right now (the old record or your own, whichever is longer). */
export function longestToBeat(book: RecordBook | null | undefined): number | null {
  const e = book?.entries.find((x) => x.kind === 'longest');
  return e ? Math.max(e.value, e.mine) : null;
}

/** Update the book after a game. Returns callouts for records broken in this game. */
export function updateRecords(c: Career, kicks: KickLog[], seasonFgm: number): string[] {
  const book = c.records;
  if (!book) return [];
  const fgs = kicks.filter((k) => !k.xp);
  const made = fgs.filter((k) => k.made);
  const pts = kicks.reduce((a, k) => a + (k.made ? (k.xp ? 1 : 3) : 0), 0);
  let bestRun = book.streakNow;
  for (const k of fgs) {
    book.streakNow = k.made ? book.streakNow + 1 : 0;
    bestRun = Math.max(bestRun, book.streakNow);
  }
  const calls: string[] = [];
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
      calls.push(`NEW ${SCOPE_NAME[book.scope].toUpperCase()} RECORD: ${e.label.toLowerCase()}${unit}, passing ${e.value}.`);
      c.records!.entries = book.entries;
    }
  }
  return calls;
}

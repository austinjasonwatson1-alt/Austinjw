import { CONFIG } from '../config';
import type { Player, Team } from '../data/types';

export const FIELD_POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RC', 'RF'] as const;
export type FieldPos = (typeof FIELD_POSITIONS)[number];

export interface Lineup {
  order: Player[]; // kicking order (10 to 12)
  field: Record<FieldPos, Player>; // starters in the field
}

/** Problems with a lineup, in plain words. Empty means it's legal. */
export function lineupProblems(order: Player[], field: Partial<Record<FieldPos, Player>>): string[] {
  const out: string[] = [];
  const R = CONFIG.rules;
  if (order.length < R.minKickers) out.push(`Needs at least ${R.minKickers} kickers (has ${order.length}).`);
  if (order.length > R.maxKickers) out.push(`No more than ${R.maxKickers} kickers (has ${order.length}).`);
  const run = guysInARow(order);
  if (run) out.push(`${run.join(', ')} make 3 guys in a row. A girl has to kick after every 2 guys.`);
  const missing = FIELD_POSITIONS.filter((p) => !field[p]);
  if (missing.length) out.push(`Nobody is playing ${missing.join(', ')}.`);
  const seen = new Map<Player, string>();
  for (const p of FIELD_POSITIONS) {
    const pl = field[p];
    if (!pl) continue;
    if (seen.has(pl)) out.push(`${pl.name} is listed at both ${seen.get(pl)} and ${p}.`);
    seen.set(pl, p);
    if (!order.includes(pl)) out.push(`${pl.name} is in the field but not kicking.`);
  }
  return out;
}

/** The first run of 3 guys in a row, counting the wrap from the last kicker to the first. */
export function guysInARow(order: Player[]): string[] | null {
  const n = order.length;
  if (n < 3) return null;
  for (let i = 0; i < n; i++) {
    const trio = [order[i], order[(i + 1) % n], order[(i + 2) % n]];
    if (trio.every((p) => p.kicksAs === 'guy')) return trio.map((p) => p.name);
  }
  return null;
}

const kickValue = (p: Player) => p.contact * 1.2 + p.power + p.speed * 0.8;

/** Kicking order that follows the co-ed rule: best kickers first, a girl after every 2 guys. */
export function autoOrder(players: Player[]): Player[] {
  const guys = players.filter((p) => p.kicksAs === 'guy').sort((a, b) => kickValue(b) - kickValue(a));
  const girls = players.filter((p) => p.kicksAs === 'girl').sort((a, b) => kickValue(b) - kickValue(a));
  const order: Player[] = [];
  let streak = 0;
  while (guys.length || girls.length) {
    // A girl after every two guys; leftover girls go at the end.
    if (girls.length && (streak >= 2 || !guys.length)) {
      order.push(girls.shift()!);
      streak = 0;
    } else if (guys.length) {
      order.push(guys.shift()!);
      streak++;
    }
  }
  // Fix a wrap-around run (last guys + first guys) by moving the last girl earlier.
  for (let tries = 0; tries < order.length && guysInARow(order); tries++) {
    const last = order.length - 1;
    const tail = order.slice().reverse().findIndex((p) => p.kicksAs === 'girl');
    if (tail <= 0) break;
    const gi = last - tail;
    const [g] = order.splice(gi, 1);
    order.push(g);
  }
  return order.slice(0, CONFIG.rules.maxKickers);
}

const posScore: Record<FieldPos, (p: Player) => number> = {
  P: (p) => p.arm * 0.6 + p.glove * 0.4,
  C: (p) => p.glove * 0.7 + p.arm * 0.3,
  '1B': (p) => p.glove * 0.8 + p.speed * 0.2,
  '2B': (p) => p.glove * 0.5 + p.speed * 0.3 + p.arm * 0.2,
  '3B': (p) => p.glove * 0.4 + p.arm * 0.5 + p.speed * 0.1,
  SS: (p) => p.glove * 0.4 + p.speed * 0.3 + p.arm * 0.3,
  LF: (p) => p.speed * 0.5 + p.glove * 0.3 + p.arm * 0.2,
  CF: (p) => p.speed * 0.6 + p.glove * 0.3 + p.arm * 0.1,
  RC: (p) => p.speed * 0.5 + p.glove * 0.3 + p.arm * 0.2,
  RF: (p) => p.speed * 0.4 + p.glove * 0.3 + p.arm * 0.3,
};
const FILL_ORDER: FieldPos[] = ['SS', 'P', 'CF', '2B', '3B', 'RC', '1B', 'LF', 'RF', 'C'];

/** Best player for each spot, most important spots first. */
export function autoField(players: Player[]): Record<FieldPos, Player> {
  const left = [...players];
  const field = {} as Record<FieldPos, Player>;
  for (const pos of FILL_ORDER) {
    left.sort((a, b) => posScore[pos](b) - posScore[pos](a));
    field[pos] = left.shift()!;
  }
  return field;
}

/** The team's usual lineup from the data file, if it's legal; otherwise an Auto Lineup. */
export function defaultLineup(team: Team): Lineup {
  const order = team.players.slice(0, CONFIG.rules.maxKickers);
  const field = {} as Record<FieldPos, Player>;
  for (const p of order) {
    const pos = p.position as FieldPos;
    if ((FIELD_POSITIONS as readonly string[]).includes(pos) && !field[pos]) field[pos] = p;
  }
  if (lineupProblems(order, field).length === 0) return { order, field };
  return autoLineup(team);
}

export function autoLineup(team: Team): Lineup {
  const order = autoOrder(team.players);
  return { order, field: autoField(order) };
}

/** Who plays each position this inning. Bench players swap in every other inning. */
export function fieldForInning(l: Lineup, inning: number): Record<FieldPos, Player> {
  const bench = l.order.filter((p) => !Object.values(l.field).includes(p));
  if (!bench.length || inning % 2 === 1) return { ...l.field };
  const f = { ...l.field };
  const used = new Set<FieldPos>();
  bench.forEach((b, j) => {
    // Swap with the starter at the bench player's usual position, else rotate through the outfield and corners.
    let pos = (FIELD_POSITIONS as readonly string[]).includes(b.position) ? (b.position as FieldPos) : null;
    if (!pos || used.has(pos) || pos === 'P') {
      const pool: FieldPos[] = ['RF', 'LF', '3B', 'RC', '1B', 'CF', '2B', 'C'];
      pos = pool[(Math.floor(inning / 2) + j) % pool.length];
      while (used.has(pos)) pos = pool[(pool.indexOf(pos) + 1) % pool.length];
    }
    used.add(pos);
    f[pos] = b;
  });
  return f;
}

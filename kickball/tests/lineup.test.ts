import { describe, expect, it } from 'vitest';
import teams from '../src/data/teams.json';
import type { Player, Team } from '../src/data/types';
import { autoLineup, defaultLineup, fieldForInning, FIELD_POSITIONS, guysInARow, lineupProblems } from '../src/core/lineup';

const all = teams.teams as Team[];
const P = (name: string, kicksAs: 'guy' | 'girl'): Player => ({ name, kicksAs, position: 'Bench', contact: 50, power: 50, speed: 50, arm: 50, glove: 50 });

describe('co-ed kicking order', () => {
  it('spots 3 guys in a row, including the wrap from last to first', () => {
    expect(guysInARow([P('a', 'guy'), P('b', 'guy'), P('c', 'guy'), P('d', 'girl')])).not.toBeNull();
    expect(guysInARow([P('a', 'guy'), P('x', 'girl'), P('b', 'guy'), P('c', 'guy')])).not.toBeNull(); // c, a wrap
    expect(guysInARow([P('a', 'guy'), P('b', 'guy'), P('x', 'girl'), P('c', 'guy'), P('d', 'guy'), P('y', 'girl')])).toBeNull();
  });
  it('blocks fewer than 10 kickers', () => {
    const nine = Array.from({ length: 9 }, (_, i) => P('p' + i, i % 3 === 2 ? 'girl' : 'guy'));
    expect(lineupProblems(nine, {}).join(' ')).toMatch(/at least 10/);
  });
  it('your real lineup from the data file is legal', () => {
    const mine = all.find((t) => t.isPlayer)!;
    const l = defaultLineup(mine);
    expect(lineupProblems(l.order, l.field)).toEqual([]);
    expect(l.order.map((p) => p.name).slice(0, 3)).toEqual(['Trevor', 'Austin', 'Abby']);
  });
  it('Auto Lineup is legal for every team', () => {
    for (const t of all) {
      const l = autoLineup(t);
      expect(lineupProblems(l.order, l.field), t.name).toEqual([]);
      expect(new Set(Object.values(l.field)).size).toBe(10);
    }
  });
  it('bench players rotate in on alternate innings and everyone has a spot', () => {
    const mine = all.find((t) => t.isPlayer)!;
    const l = defaultLineup(mine);
    const one = fieldForInning(l, 1);
    const two = fieldForInning(l, 2);
    expect(Object.values(one)).not.toContain(mine.players.find((p) => p.name === 'Emre'));
    expect(two.RF.name).toBe('Emre');
    expect(two['3B'].name).toBe('Chloe');
    for (const f of [one, two]) {
      expect(FIELD_POSITIONS.every((p) => f[p])).toBe(true);
      expect(new Set(Object.values(f)).size).toBe(10);
    }
  });
});

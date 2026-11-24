import { describe, expect, it } from 'vitest';
import { migrateCareer, newCareer } from '../src/career/career';
import { makeRecordBook, updateRecords } from '../src/career/records';
import { advanceStandings, playoffRace, sorted, type Standings } from '../src/career/standings';
import { Rng } from '../src/sim/rng';
import type { KickLog } from '../src/career/types';

const profile = { name: 'Austin Watson', hometown: 'Lakeview', school: 'Lakeview High', foot: 'R' as const, number: '3' };
const fg = (d: number, made = true): KickLog => ({ d, made, xp: false, pressure: 0, gw: false, q: 1, clock: '1:00', by: 'me' });

describe('record book', () => {
  it('NFL records use the real marks', () => {
    const b = makeRecordBook('nfl', '', undefined, new Rng(1), () => 'x');
    expect(b.entries.find((e) => e.kind === 'longest')!.value).toBe(66);
    expect(b.entries.find((e) => e.kind === 'careerPts')!.value).toBe(2673);
  });

  it('calls out a record once when you pass it', () => {
    const c = newCareer(1, profile, 3);
    const longest = c.records!.entries.find((e) => e.kind === 'longest')!;
    const calls1 = updateRecords(c, [fg(longest.value + 1)], 1);
    expect(calls1.some((x) => x.includes('longest field goal'))).toBe(true);
    expect(longest.brokenYear).toBe(c.year);
    const calls2 = updateRecords(c, [fg(longest.value + 3)], 2);
    expect(calls2.some((x) => x.includes('longest'))).toBe(false);
    expect(longest.mine).toBe(longest.value + 3);
  });

  it('tracks a made-in-a-row streak', () => {
    const c = newCareer(1, profile, 3);
    updateRecords(c, [fg(30), fg(31), fg(32, false), fg(33)], 3);
    expect(c.records!.entries.find((e) => e.kind === 'streak')!.mine).toBe(2);
    expect(c.records!.streakNow).toBe(1);
  });
});

describe('standings', () => {
  it('my row follows my results and the opponent gets the other side', () => {
    const st: Standings = {
      title: 't',
      rows: [
        { name: 'Me', short: 'ME', primary: '#000000', strength: 50, w: 0, l: 0, me: true },
        { name: 'Opp', short: 'OP', primary: '#000000', strength: 50, w: 0, l: 0, me: false },
        { name: 'Other', short: 'OT', primary: '#000000', strength: 50, w: 0, l: 0, me: false },
      ],
    };
    advanceStandings(st, new Rng(2), 'Opp', true);
    expect(st.rows[0].w).toBe(1);
    expect(st.rows[1].l).toBe(1);
    expect(st.rows[2].w + st.rows[2].l).toBe(1);
    expect(sorted(st)[0].w).toBe(1);
  });

  it('old saves get records and standings', () => {
    const c = newCareer(1, profile, 9) as ReturnType<typeof newCareer> & { records?: unknown; standings?: unknown };
    delete c.records;
    delete c.standings;
    const m = migrateCareer(c);
    expect(m.records?.scope).toBe('school');
    expect(m.standings).toBeNull();
    expect(playoffRace(m)).toBeNull();
  });
});

describe('save codes', () => {
  it('round-trip a career into another slot', async () => {
    const { exportCode, importCode } = await import('../src/career/save');
    const c = newCareer(2, { ...profile, name: 'Austin Watsón' }, 12);
    const code = exportCode(c);
    expect(code.startsWith('RTN1:')).toBe(true);
    const back = importCode(code, 3)!;
    expect(back.slot).toBe(3);
    expect(back.kicker.name).toBe('Austin Watsón');
    expect(back.skills).toEqual(c.skills);
    expect(importCode('nonsense', 1)).toBeNull();
    expect(importCode('RTN1:!!!', 1)).toBeNull();
  });
});

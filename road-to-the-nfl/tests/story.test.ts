import { describe, expect, it } from 'vitest';
import { newCareer } from '../src/career/career';
import { GameSim } from '../src/career/gamesim';
import { evenSkills } from '../src/career/progression';
import { applyDifficulty, applyPress, easeSlump, effectiveSkills, pressFor, startSlump, trackKicks } from '../src/career/story';
import type { KickLog, Team } from '../src/career/types';
import { resolveKick } from '../src/kick/physics';
import { Rng } from '../src/sim/rng';

const profile = { name: 'Austin Watson', hometown: 'Lakeview', school: 'Lakeview High', foot: 'R' as const, number: '3' };
const fg = (d: number, made = true, extra: Partial<KickLog> = {}): KickLog => ({ d, made, xp: false, pressure: 0, gw: false, q: 4, clock: '0:02', by: 'me', ...extra });
const team = (s: number): Team => ({ name: 'T', short: 'T', primary: '#123456', secondary: '#ffffff', strength: s });
const still = () => {
  const r = new Rng(1);
  r.normal = () => 0;
  r.next = () => 0.5;
  return r;
};

describe('trajectory', () => {
  const k = evenSkills(70);
  const kick = (t: 'normal' | 'high' | 'low', windMph: number, windToDeg: number) =>
    resolveKick({ level: 'nfl', distanceYd: 45, hash: 'M', windMph, windToDeg }, { aimXFt: 0, power: 1, accuracy: 0, trajectory: t }, k, still());
  it('low kicks drift less in a crosswind; high kicks drift more', () => {
    const n = Math.abs(kick('normal', 15, 90).crossXFt!);
    expect(Math.abs(kick('low', 15, 90).crossXFt!)).toBeLessThan(n);
    expect(Math.abs(kick('high', 15, 90).crossXFt!)).toBeGreaterThan(n);
  });
  it('normal carries farthest on a calm day', () => {
    const n = kick('normal', 0, 0).carryYd;
    expect(kick('high', 0, 0).carryYd).toBeLessThan(n);
    expect(kick('low', 0, 0).carryYd).toBeLessThan(n);
  });
});

describe('traits', () => {
  it('unlock from what you do and change the ratings', () => {
    const c = newCareer(1, profile, 1);
    const before = effectiveSkills(c).power;
    const fresh = trackKicks(c, [fg(56)], 0, 'clear');
    expect(fresh.map((t) => t.id)).toContain('bigLeg');
    expect(effectiveSkills(c).power).toBe(before + 3);
    expect(trackKicks(c, [fg(57)], 0, 'clear')).toHaveLength(0);
  });
  it('count clutch, windy and bad-weather makes', () => {
    const c = newCareer(1, profile, 1);
    trackKicks(c, [fg(30, true, { gw: true, pressure: 0.9 }), fg(40, false)], 15, 'snow');
    expect(c.counters!.clutchMade).toBe(1);
    expect(c.counters!.windMade).toBe(1);
    expect(c.counters!.badWeatherMade).toBe(1);
    expect(c.counters!.streak).toBe(0);
  });
});

describe('slumps and press conferences', () => {
  it('a slump lowers composure, fades, and a clutch make ends it', () => {
    const c = newCareer(1, profile, 1);
    const calm = effectiveSkills(c).composure;
    startSlump(c, 'Missed with the game on the line');
    expect(effectiveSkills(c).composure).toBeLessThan(calm);
    expect(easeSlump(c, false)).toBe('eased');
    expect(easeSlump(c, true)).toBe('ended');
    expect(c.slump).toBeNull();
  });
  it('answers move trust and the slump', () => {
    const c = newCareer(1, profile, 1);
    startSlump(c, 'x');
    const pc = pressFor('gwMissed', c.kicker.name, 'from 48');
    const owned = applyPress(c, pc, 0);
    const blamed = applyPress(c, pc, 1);
    expect(owned.trust).toBeGreaterThan(blamed.trust);
    expect((owned.slump?.level ?? 0) < (blamed.slump?.level ?? 0)).toBe(true);
  });
});

describe('the coach asks', () => {
  it('asks on kicks just past his range, and vouching moves trust', () => {
    let asks = 0;
    let vouchedKicks = 0;
    for (let i = 0; i < 120; i++) {
      const g = new GameSim({ level: 'nfl', us: team(50), them: team(50), home: true, playoff: false, weather: 'clear', windMph: 0, windToDeg: 0, kicker: evenSkills(75), kickerName: 'Me', trust: 30, role: 'starter', rival: null, autoXp: true, seed: i + 1 });
      let step = g.next();
      while (!step.done) {
        if (step.ask) {
          asks++;
          step = g.answerAsk(true);
        } else if (step.kick) step = g.answer(true);
        else step = g.next();
      }
      vouchedKicks += g.myKicks.filter((k) => k.vouched).length;
    }
    expect(asks).toBeGreaterThan(10);
    expect(vouchedKicks).toBe(asks);
  });
});

describe('difficulty', () => {
  it('easy widens the sweet spot ratings, hard narrows them', () => {
    const k = evenSkills(60);
    expect(applyDifficulty(k, 'easy').accuracy).toBeGreaterThan(60);
    expect(applyDifficulty(k, 'hard').accuracy).toBeLessThan(60);
    expect(applyDifficulty(k, 'normal')).toEqual(k);
  });
});

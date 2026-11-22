import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import {
  maxRangeYd,
  powerSpeedFrac,
  rate,
  resolveKick,
  sweetSpotHalf,
  type KickInputs,
  type KickSetup,
  type KickerRatings,
} from '../src/kick/physics';
import { Rng } from '../src/sim/rng';

const k: KickerRatings = { power: 70, accuracy: 70, composure: 70, windControl: 70, consistency: 70 };
const pure: KickInputs = { aimXFt: 0, power: 1, accuracy: 0 };
const calm = (d: number, extra: Partial<KickSetup> = {}): KickSetup => ({ level: 'nfl', distanceYd: d, hash: 'M', windMph: 0, windToDeg: 0, ...extra });

/** RNG with no gusts, no drift and no blocks, so results are exact. */
function still(): Rng {
  const r = new Rng(1);
  r.normal = () => 0;
  r.next = () => 0.5;
  return r;
}

describe('level rules', () => {
  it('match the brief', () => {
    expect(CONFIG.levels.hs.hashWidthFt).toBeCloseTo(53.333, 2);
    expect(CONFIG.levels.hs.uprightWidthFt).toBeCloseTo(23.333, 2);
    expect(CONFIG.levels.college.hashWidthFt).toBe(40);
    expect(CONFIG.levels.college.uprightWidthFt).toBe(18.5);
    expect(CONFIG.levels.nfl.hashWidthFt).toBe(18.5);
    expect(CONFIG.levels.nfl.xpDistanceYd).toBe(33);
  });
});

describe('ratings', () => {
  it('interpolate between rating 40 and 99', () => {
    expect(rate(40, { r40: 10, r99: 20 })).toBe(10);
    expect(rate(99, { r40: 10, r99: 20 })).toBe(20);
    expect(maxRangeYd({ ...k, power: 40 })).toBeCloseTo(40);
  });

  it('overdrive shrinks the sweet spot and adds speed', () => {
    expect(sweetSpotHalf(k, CONFIG.meters.powerMax)).toBeLessThan(sweetSpotHalf(k, 1));
    expect(powerSpeedFrac(CONFIG.meters.powerMax)).toBeGreaterThan(1);
    expect(powerSpeedFrac(0.5)).toBeLessThan(1);
  });
});

describe('a pure strike', () => {
  it('is good from the middle at every level on a calm day', () => {
    for (const level of ['hs', 'college', 'nfl'] as const) {
      const r = resolveKick(calm(35, { level }), pure, k, still());
      expect(r.outcome).toBe('GOOD');
      expect(r.made).toBe(true);
    }
  });

  it('carries exactly to the kicker range', () => {
    const range = maxRangeYd(k);
    expect(resolveKick(calm(Math.floor(range) - 1), pure, k, still()).made).toBe(true);
    const long = resolveKick(calm(Math.ceil(range) + 2), pure, k, still());
    expect(long.outcome).toBe('SHORT');
    expect(long.carryYd).toBeCloseTo(range, 0);
  });

  it('is good from the hash when aimed at the middle', () => {
    for (const level of ['hs', 'college', 'nfl'] as const) {
      expect(resolveKick(calm(25, { level, hash: 'L' }), pure, k, still()).made).toBe(true);
      expect(resolveKick(calm(25, { level, hash: 'R' }), pure, k, still()).made).toBe(true);
    }
  });
});

describe('power', () => {
  it('too little power leaves a long kick short', () => {
    expect(resolveKick(calm(45), { ...pure, power: 0.6 }, k, still()).outcome).toBe('SHORT');
  });

  it('overdrive adds distance', () => {
    const top = resolveKick(calm(30), pure, k, still()).carryYd;
    const over = resolveKick(calm(30), { ...pure, power: CONFIG.meters.powerMax }, k, still()).carryYd;
    expect(over).toBeGreaterThan(top + 2);
  });
});

describe('wind', () => {
  it('a headwind costs distance and a tailwind adds it', () => {
    const base = resolveKick(calm(30), pure, k, still()).carryYd;
    const head = resolveKick(calm(30, { windMph: 15, windToDeg: 180 }), pure, k, still()).carryYd;
    const tail = resolveKick(calm(30, { windMph: 15, windToDeg: 0 }), pure, k, still()).carryYd;
    expect(head).toBeLessThan(base - 2);
    expect(tail).toBeGreaterThan(base + 2);
  });

  it('a crosswind pushes the ball, and aiming into it brings it back', () => {
    const setup = calm(50, { windMph: 30, windToDeg: 90 });
    const straight = resolveKick(setup, pure, k, still());
    expect(straight.crossXFt).toBeGreaterThan(CONFIG.levels.nfl.uprightWidthFt / 2);
    expect(straight.made).toBe(false);
    const aimed = resolveKick(setup, { ...pure, aimXFt: -(straight.crossXFt ?? 0) }, k, still());
    expect(aimed.made).toBe(true);
    expect(Math.abs(aimed.crossXFt ?? 99)).toBeLessThan(2);
  });

  it('better wind control means less drift', () => {
    const setup = calm(45, { windMph: 20, windToDeg: 270 });
    const weak = resolveKick(setup, pure, { ...k, windControl: 40 }, still());
    const strong = resolveKick(setup, pure, { ...k, windControl: 99 }, still());
    expect(Math.abs(strong.crossXFt!)).toBeLessThan(Math.abs(weak.crossXFt!));
  });
});

describe('accuracy meter', () => {
  it('stopping left of centre misses left, right misses right', () => {
    expect(resolveKick(calm(45), { ...pure, accuracy: -0.5 }, k, still()).outcome).toBe('WIDE_LEFT');
    expect(resolveKick(calm(45), { ...pure, accuracy: 0.5 }, k, still()).outcome).toBe('WIDE_RIGHT');
  });

  it('a small miss survives a chip shot but not a long kick', () => {
    const e = sweetSpotHalf(k, 1) + 0.15;
    expect(resolveKick(calm(22), { ...pure, accuracy: e }, k, still()).made).toBe(true);
    expect(resolveKick(calm(50), { ...pure, accuracy: e }, k, still()).made).toBe(false);
  });

  it('anywhere in the sweet spot is good from 40', () => {
    const s = sweetSpotHalf(k, 1);
    for (const e of [-s, -s / 2, 0, s / 2, s]) expect(resolveKick(calm(40), { ...pure, accuracy: e }, k, still()).made).toBe(true);
  });
});

describe('results', () => {
  it('are deterministic for a seed', () => {
    const a = resolveKick(calm(44, { windMph: 12, windToDeg: 135 }), { aimXFt: -3, power: 0.97, accuracy: 0.05 }, k, new Rng(99));
    const b = resolveKick(calm(44, { windMph: 12, windToDeg: 135 }), { aimXFt: -3, power: 0.97, accuracy: 0.05 }, k, new Rng(99));
    expect(a).toEqual(b);
  });

  it('produce a playable path with the decision inside it', () => {
    const r = resolveKick(calm(40), pure, k, still());
    expect(r.path.length).toBeGreaterThan(60);
    expect(r.decideIndex).toBeGreaterThan(0);
    expect(r.decideIndex).toBeLessThan(r.path.length);
    expect(r.path[r.decideIndex].y).toBeGreaterThan(110);
  });

  it('a ball at the upright hits it', () => {
    const half = CONFIG.levels.nfl.uprightWidthFt / 2;
    const r = resolveKick(calm(30), { ...pure, aimXFt: half }, k, still());
    expect(['GOOD_UPRIGHT', 'UPRIGHT_NO']).toContain(r.outcome);
  });

  it('blocks are rare', () => {
    const rng = new Rng(5);
    let blocked = 0;
    for (let i = 0; i < 2000; i++) if (resolveKick(calm(40), pure, k, rng).outcome === 'BLOCKED') blocked++;
    expect(blocked / 2000).toBeLessThan(0.02);
  });
});

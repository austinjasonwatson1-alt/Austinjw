import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config';
import { applyPitch, freshCount } from '../src/core/count';
import { cleanWindow, contactQuality, kickTypeFor, resolveKick, timingDrift, whiffWindow } from '../src/core/kick';
import { simulateFlight } from '../src/core/flight';
import type { Pitch } from '../src/core/pitch';
import { generatePitch, pitchPosition } from '../src/core/pitch';
import { seededRng } from '../src/core/rng';

const strike: Pitch = {
  type: 'fast', speed: 42, targetX: 0, curve: 0, bounceHeight: 0, bounces: 0, isStrike: true,
  timeToPlate: CONFIG.field.pitchingDistance / 42,
};
const kicker = { contact: 60, power: 70 };
const centerAim = CONFIG.kick.defaultAimIndex;

describe('count', () => {
  it('walks on four balls', () => {
    let c = freshCount();
    let r = 'continue';
    for (let i = 0; i < 4; i++) ({ count: c, result: r } = applyPitch(c, 'ball') as any);
    expect(r).toBe('walk');
  });
  it('strikes out on three strikes, whiffs or taken', () => {
    let c = freshCount();
    c = applyPitch(c, 'whiff').count;
    c = applyPitch(c, 'calledStrike').count;
    expect(applyPitch(c, 'whiff').result).toBe('strikeout');
  });
  it('fouls are counted apart from strikes and four is an out', () => {
    let c = freshCount();
    for (let i = 0; i < 3; i++) c = applyPitch(c, 'foul').count;
    expect(c.strikes).toBe(0);
    expect(applyPitch(c, 'foul').result).toBe('foulout');
  });
});

describe('kick timing', () => {
  it('higher Contact widens the window', () => {
    expect(cleanWindow(95, strike, false)).toBeGreaterThan(cleanWindow(20, strike, false));
  });
  it('bunts have a wider window', () => {
    expect(cleanWindow(50, strike, true)).toBeGreaterThan(cleanWindow(50, strike, false));
  });
  it('early pulls left, late pushes right', () => {
    expect(timingDrift(-40, 50)).toBeLessThan(0);
    expect(timingDrift(40, 50)).toBeGreaterThan(0);
  });
  it('quality is 1 at perfect timing and drops off', () => {
    const clean = cleanWindow(60, strike, false);
    const whiff = whiffWindow(60, strike, false);
    expect(contactQuality(0, clean, whiff)).toBe(1);
    expect(contactQuality(clean + 30, clean, whiff)).toBeLessThan(contactQuality(clean - 10, clean, whiff));
  });
  it('way early or late is a whiff', () => {
    const w = whiffWindow(60, strike, false);
    const rng = seededRng(1);
    const base = { pitch: strike, holdMs: 100, aimIndex: centerAim, bunt: false, kicker };
    expect(resolveKick({ ...base, deltaMs: -w - 1 }, rng).kind).toBe('whiff');
    expect(resolveKick({ ...base, deltaMs: w + 1 }, rng).kind).toBe('whiff');
  });
  it('cannot reach a pitch far off the plate', () => {
    const wide = { ...strike, targetX: CONFIG.pitch.reach + 1, isStrike: false };
    const out = resolveKick({ pitch: wide, deltaMs: 0, holdMs: 100, aimIndex: centerAim, bunt: false, kicker }, seededRng(2));
    expect(out).toMatchObject({ kind: 'whiff', reason: 'reach' });
  });
  it('a perfect kick aimed center is fair', () => {
    const out = resolveKick({ pitch: strike, deltaMs: 0, holdMs: 100, aimIndex: centerAim, bunt: false, kicker }, seededRng(3));
    expect(out.kind).toBe('contact');
    if (out.kind === 'contact') expect(simulateFlight(out.sprayDeg, out.launchDeg, out.exitSpeed).fair).toBe(true);
  });
  it('a badly early pull-aimed kick goes foul left', () => {
    const w = whiffWindow(60, strike, false);
    const out = resolveKick({ pitch: strike, deltaMs: -(w - 5), holdMs: 100, aimIndex: 0, bunt: false, kicker }, seededRng(4));
    expect(out.kind).toBe('contact');
    if (out.kind === 'contact') expect(out.sprayDeg).toBeLessThan(-CONFIG.field.foulLineDeg);
  });
});

describe('kick types', () => {
  it('tap is a liner, hold is power, bunt stance is a bunt', () => {
    expect(kickTypeFor(80, false)).toBe('liner');
    expect(kickTypeFor(CONFIG.kick.powerHoldThreshold + 1, false)).toBe('power');
    expect(kickTypeFor(800, true)).toBe('bunt');
  });
  it('power kicks fly higher and farther in the air than liners; bunts stay short', () => {
    const rng = seededRng(5);
    const base = { pitch: strike, deltaMs: 0, aimIndex: centerAim, bunt: false, kicker };
    const fly = (o: ReturnType<typeof resolveKick>) => {
      if (o.kind !== 'contact') throw new Error('expected contact');
      return simulateFlight(o.sprayDeg, o.launchDeg, o.exitSpeed);
    };
    const power = fly(resolveKick({ ...base, holdMs: CONFIG.kick.powerFullCharge }, rng));
    const liner = fly(resolveKick({ ...base, holdMs: 50 }, rng));
    const bunt = fly(resolveKick({ ...base, holdMs: 50, bunt: true }, rng));
    expect(power.landing.distance).toBeGreaterThan(liner.landing.distance);
    expect(power.maxHeight).toBeGreaterThan(liner.maxHeight);
    expect(bunt.rest.distance).toBeLessThan(45);
  });
  it('more Power kicks farther', () => {
    const base = { pitch: strike, deltaMs: 0, aimIndex: centerAim, bunt: false, holdMs: CONFIG.kick.powerFullCharge };
    const weak = resolveKick({ ...base, kicker: { contact: 60, power: 20 } }, seededRng(6));
    const strong = resolveKick({ ...base, kicker: { contact: 60, power: 90 } }, seededRng(6));
    if (weak.kind !== 'contact' || strong.kind !== 'contact') throw new Error('expected contact');
    expect(strong.exitSpeed).toBeGreaterThan(weak.exitSpeed);
  });
});

describe('pitches', () => {
  it('cross the plate at timeToPlate', () => {
    const p = generatePitch(seededRng(7));
    const at = pitchPosition(p, p.timeToPlate);
    expect(at.y).toBeCloseTo(0, 5);
    expect(at.x).toBeCloseTo(p.targetX, 5);
  });
  it('strike pitches land on the plate, misses land off it', () => {
    const rng = seededRng(8);
    for (let i = 0; i < 200; i++) {
      const p = generatePitch(rng);
      if (p.isStrike) expect(Math.abs(p.targetX)).toBeLessThanOrEqual(CONFIG.pitch.plateHalfWidth);
      else expect(Math.abs(p.targetX)).toBeGreaterThan(CONFIG.pitch.plateHalfWidth);
    }
  });
});

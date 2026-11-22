// Skills, costs, ratings-driven odds and coach trust. Pure functions.

import { CONFIG, type LevelKey, type Weather } from '../config';
import { rate, weatherRangeYd, type KickerRatings } from '../kick/physics';
import type { KickLog, SkillKey } from './types';

export const SKILLS: { key: SkillKey; label: string; blurb: string }[] = [
  { key: 'power', label: 'Power', blurb: 'Maximum range, and how much distance wind and cold take away' },
  { key: 'accuracy', label: 'Accuracy', blurb: 'The size of the sweet spot on the accuracy meter' },
  { key: 'composure', label: 'Composure', blurb: 'How much pressure and icing speed up and shake the meters' },
  { key: 'windControl', label: 'Wind control', blurb: 'How far the wind moves the ball' },
  { key: 'consistency', label: 'Consistency', blurb: 'Random drift on a well-struck kick' },
];

/** Cost of raising a skill one level from `rating`. */
export function levelCost(rating: number): number {
  for (const t of CONFIG.career.skillCost) if (rating < t.below) return t.cost;
  return Infinity;
}

/** Total points to go from `from` to `to`. */
export function costToRaise(from: number, to: number): number {
  let c = 0;
  for (let r = from; r < to; r++) c += levelCost(r);
  return c;
}

export function overall(s: KickerRatings): number {
  return Math.round((s.power + s.accuracy + s.composure + s.windControl + s.consistency) / 5);
}

export function evenSkills(ovr: number): KickerRatings {
  return { power: ovr, accuracy: ovr, composure: ovr, windControl: ovr, consistency: ovr };
}

/** What the next level of a skill changes, in words. */
export function nextLevelEffect(key: SkillKey, s: KickerRatings): string {
  const r = s[key];
  const R = CONFIG.ratings;
  const fmt = (n: number, d = 1) => n.toFixed(d);
  switch (key) {
    case 'power':
      return `Range ${fmt(rate(r, R.maxRangeYd))} → ${fmt(rate(r + 1, R.maxRangeYd))} yds`;
    case 'accuracy':
      return `Sweet spot ${fmt(rate(r, R.sweetSpotHalf) * 200)}% → ${fmt(rate(r + 1, R.sweetSpotHalf) * 200)}% of the bar`;
    case 'composure':
      return `Pressure felt ${Math.round(rate(r, CONFIG.pressure.composureFactor) * 100)}% → ${Math.round(rate(r + 1, CONFIG.pressure.composureFactor) * 100)}%`;
    case 'windControl':
      return `Wind push ${Math.round(rate(r, R.windEffect) * 100)}% → ${Math.round(rate(r + 1, R.windEffect) * 100)}%`;
    case 'consistency':
      return `Drift ±${fmt(rate(r, R.driftSigmaDeg), 2)}° → ±${fmt(rate(r + 1, R.driftSigmaDeg), 2)}°`;
  }
}

/** Probability a kicker makes a kick when it is simulated rather than played. */
export function autoMakeProb(s: KickerRatings, distanceYd: number, weather: Weather, windMph: number, pressure: number): number {
  const range = weatherRangeYd(s, weather) - windMph * 0.12 * rate(s.windControl, CONFIG.ratings.windEffect);
  const cf = rate(s.composure, CONFIG.pressure.composureFactor);
  const acc = 0.9 + (0.09 * (s.accuracy - 40)) / 59 - windMph * 0.002 - pressure * cf * 0.06 - (1 - CONFIG.weather[weather].sweet) * 0.15;
  const logistic = 1 / (1 + Math.exp((distanceYd - (range - 2)) / 3.5));
  return Math.max(0.01, Math.min(0.995, acc * logistic));
}

/** How far the coach will send the kicker out from, given trust (0..100). */
export function coachRangeYd(s: KickerRatings, weather: Weather, windMph: number, trust: number): number {
  const T = CONFIG.career.trust.rangeFrac;
  const range = weatherRangeYd(s, weather) - windMph * 0.1;
  return range * (T.low + ((T.high - T.low) * Math.max(0, Math.min(100, trust))) / 100);
}

export function trustDelta(k: KickLog): number {
  const T = CONFIG.career.trust;
  const mult = 1 + (T.pressureMult - 1) * Math.min(1, k.pressure);
  if (k.xp) return k.made ? 0.5 : T.xpMiss * mult;
  if (k.made) return (T.makeBase + Math.max(0, k.d - 40) * T.makePerYdOver40) * mult;
  return (T.missBase + (k.d < 35 ? T.missShortExtra : 0) + Math.max(0, k.d - 45) * 0.3) * mult;
}

export function kickPoints(k: KickLog): number {
  const P = CONFIG.career.points;
  if (k.xp || !k.made) return 0;
  let p = P.fgMade;
  if (k.d >= 50) p += P.fg50;
  else if (k.d >= 40) p += P.fg40;
  if (k.pressure >= 0.6) p += P.pressureBonus;
  return p;
}

export function stageLevel(stage: string): LevelKey {
  return stage === 'hs' ? 'hs' : stage === 'college' ? 'college' : 'nfl';
}

export function clampSkill(n: number): number {
  return Math.max(1, Math.min(99, Math.round(n)));
}

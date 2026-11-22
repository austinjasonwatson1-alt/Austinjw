import { CONFIG, type PitchType } from '../config';
import type { Player } from '../data/types';
import type { Pitch } from './pitch';
import { clamp, lerp, pickWeighted, type Rng } from './rng';

const A = CONFIG.ai;

export type AiKick = { swing: false } | { swing: true; deltaMs: number; holdMs: number; aimIndex: number; bunt: boolean };

function gauss(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(rng() + 1e-9)) * Math.cos(2 * Math.PI * rng());
}

/** What a computer kicker does with a pitch. */
export function aiKick(pitch: Pitch, kicker: Player, rng: Rng): AiKick {
  const swingChance = pitch.isStrike ? A.swingAtStrike : Math.abs(pitch.targetX) <= CONFIG.pitch.reach ? A.swingAtBall : 0.02;
  if (rng() > swingChance) return { swing: false };
  const sd = lerp(A.timingSdWorst, A.timingSdBest, clamp(kicker.contact, 1, 100) / 100) * (CONFIG.pitch.types[pitch.type].timingMult < 1 ? A.trickyPitchSdMult : 1);
  const bunt = rng() < A.buntChance;
  const power = !bunt && rng() < lerp(0.2, 0.7, kicker.power / 100);
  return {
    swing: true,
    deltaMs: gauss(rng) * sd,
    holdMs: power ? CONFIG.kick.powerFullCharge : 90,
    aimIndex: pickWeighted(rng, [0, 1, 2, 3, 4].map((i) => ({ item: i, weight: [1, 2, 3, 2, 1][i] }))),
    bunt,
  };
}

/** What a computer pitcher throws. */
export function aiPitchChoice(rng: Rng): { type: PitchType; aim: number } {
  const types = Object.keys(CONFIG.pitch.types) as PitchType[];
  return { type: types[Math.floor(rng() * types.length)], aim: CONFIG.pitch.locations[Math.floor(rng() * 3)].x };
}

/** How far off target a pitcher's roll lands (ft, standard deviation). */
export function pitchScatter(pitcherArm: number): number {
  return lerp(CONFIG.pitch.scatterWorst, CONFIG.pitch.scatterBest, clamp(pitcherArm, 1, 100) / 100);
}

export { gauss };

import { CONFIG, PitchType } from '../config';
import { Rng, pickWeighted, randRange } from './rng';

export interface Pitch {
  type: PitchType;
  speed: number; // ft/s along the ground
  targetX: number; // left/right offset from the middle of the plate when it arrives (ft)
  curve: number; // peak sideways bend in ft (signed)
  bounceHeight: number;
  bounces: number;
  isStrike: boolean;
  timeToPlate: number; // seconds from release to crossing the plate
}

export interface Vec3 {
  x: number; // feet, positive = right field side
  y: number; // feet, positive = toward center field
  z: number; // feet, height
}

export function generatePitch(rng: Rng, forcedType?: PitchType): Pitch {
  const types = CONFIG.pitch.types;
  const type =
    forcedType ??
    pickWeighted(
      rng,
      (Object.keys(types) as PitchType[]).map((t) => ({ item: t, weight: types[t].weight })),
    );
  const spec = types[type];
  const isStrike = rng() < CONFIG.pitch.strikeChance;
  const half = CONFIG.pitch.plateHalfWidth;
  const targetX = isStrike
    ? randRange(rng, -half * 0.9, half * 0.9)
    : (rng() < 0.5 ? -1 : 1) * randRange(rng, CONFIG.pitch.missMin, CONFIG.pitch.missMax);
  const curve = spec.curve * (rng() < 0.5 ? -1 : 1);
  return {
    type,
    speed: spec.speed,
    targetX,
    curve,
    bounceHeight: spec.bounceHeight,
    bounces: spec.bounces,
    isStrike,
    timeToPlate: CONFIG.field.pitchingDistance / spec.speed,
  };
}

/** Where the rolled pitch is `t` seconds after release. Keeps going past the plate. */
export function pitchPosition(p: Pitch, t: number): Vec3 {
  const s = t / p.timeToPlate; // 0 at release, 1 at the plate
  const y = CONFIG.field.pitchingDistance * (1 - s);
  const bend = s <= 1 ? Math.sin(Math.PI * s) * p.curve : 0;
  const x = p.targetX * s + bend;
  let z = 0;
  if (p.bounces > 0 && s < 1.3) {
    const decay = 1 - 0.35 * Math.min(s, 1);
    z = p.bounceHeight * decay * Math.abs(Math.sin(Math.PI * p.bounces * s));
  }
  return { x, y, z };
}

// Kick physics: turns a setup, the player's three inputs and the kicker's ratings
// into a full ball path and a result. No UI code here.
//
// World coordinates, in feet: x is across the field (+ is right, from the kicker's view),
// y is downfield from the holder's spot, z is up. The goalposts stand at y = distance * 3.

import { CONFIG, type LevelKey, type RatingSpec } from '../config';
import { Rng } from '../sim/rng';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Hash = 'L' | 'M' | 'R';

export interface KickSetup {
  level: LevelKey;
  distanceYd: number;
  hash: Hash;
  windMph: number;
  /** Direction the wind blows TOWARD, relative to the field: 0 = at the kicker's back, 90 = left to right, 180 = in the face, 270 = right to left. */
  windToDeg: number;
}

export interface KickerRatings {
  power: number;
  accuracy: number;
  composure: number;
  windControl: number;
  consistency: number;
}

export interface KickInputs {
  /** Where the aim marker sits on the goal line plane, feet from the centre of the uprights. */
  aimXFt: number;
  /** Power meter stop: 0..powerMax, where 1 is the top. */
  power: number;
  /** Accuracy meter stop: -1 (left edge) .. +1 (right edge); 0 is dead centre. */
  accuracy: number;
}

export type Outcome =
  | 'GOOD'
  | 'GOOD_UPRIGHT'
  | 'GOOD_CROSSBAR'
  | 'WIDE_LEFT'
  | 'WIDE_RIGHT'
  | 'SHORT'
  | 'UPRIGHT_NO'
  | 'CROSSBAR_NO'
  | 'BLOCKED';

export interface KickResult {
  outcome: Outcome;
  made: boolean;
  /** Ball positions sampled at 60 Hz, from contact until it comes to rest. */
  path: Vec3[];
  /** Index into path at which the result is decided (ball reaches the posts, lands, or is blocked). */
  decideIndex: number;
  /** Where the ball crossed the goal plane, if it got there in the air. */
  crossXFt: number | null;
  crossZFt: number | null;
  /** How far the kick would have been good from: where it came down through crossbar height, in yards from the spot. */
  carryYd: number;
  /** For wide kicks, feet outside the upright. */
  missByFt: number;
  /** For short kicks, yards short. */
  shortByYd: number;
  inSweetSpot: boolean;
  /** Signed meter units beyond the sweet spot (negative = left). 0 when inside. */
  strikeMiss: number;
  windActualMph: number;
}

export const MPH_TO_FTS = 5280 / 3600;
const SAMPLE_EVERY = Math.round(1 / 60 / CONFIG.physics.dtS); // 240 Hz sim → 60 Hz path

export function rate(rating: number, spec: RatingSpec): number {
  const r = Math.max(1, Math.min(99, rating));
  return spec.r40 + ((spec.r99 - spec.r40) * (r - 40)) / 59;
}

export const goalPlaneY = (distanceYd: number) => distanceYd * 3;

export function kickSpotX(level: LevelKey, hash: Hash): number {
  const half = CONFIG.levels[level].hashWidthFt / 2;
  return hash === 'L' ? -half : hash === 'R' ? half : 0;
}

export function windVectorFtS(mph: number, toDeg: number): { x: number; y: number } {
  const a = (toDeg * Math.PI) / 180;
  return { x: Math.sin(a) * mph * MPH_TO_FTS, y: Math.cos(a) * mph * MPH_TO_FTS };
}

export const maxRangeYd = (k: KickerRatings) => rate(k.power, CONFIG.ratings.maxRangeYd);

export function sweetSpotHalf(k: KickerRatings, power: number): number {
  const m = CONFIG.meters;
  const base = Math.max(0.02, rate(k.accuracy, CONFIG.ratings.sweetSpotHalf));
  const over = Math.max(0, Math.min(1, (power - 1) / (m.powerMax - 1)));
  return base * (1 - m.overdriveSweetSpotShrink * over);
}

export function powerSpeedFrac(power: number): number {
  const m = CONFIG.meters;
  const p = Math.max(0, Math.min(m.powerMax, power));
  if (p <= 1) return m.powerMinSpeedFrac + (1 - m.powerMinSpeedFrac) * p;
  return 1 + (p - 1) * m.overdriveSpeedGain;
}

// ---------------------------------------------------------------------------
// Integrator

interface State {
  t: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

interface FlightOpts {
  windX: number;
  windY: number;
  hookAccel: number; // + curves right
  v0: number; // for scaling the hook with speed
  bounce: boolean; // keep going through ground bounces
  stopAtY?: number; // stop as soon as the ball reaches this y
  maxT: number;
}

interface FlightRun {
  samples: State[]; // at dtS
  firstGroundIndex: number; // index of the first sample at/below ground, or -1
}

function integrate(start: State, o: FlightOpts): FlightRun {
  const P = CONFIG.physics;
  const dt = P.dtS;
  const out: State[] = [start];
  let s = { ...start };
  let bounces = 0;
  let firstGroundIndex = -1;
  let resting = false;

  while (s.t < o.maxT) {
    if (resting) {
      s = { ...s, t: s.t + dt };
      out.push(s);
      if (s.t - out[firstGroundIndex].t > 1.2) break;
      continue;
    }
    const rx = s.vx - o.windX;
    const ry = s.vy - o.windY;
    const rz = s.vz;
    const rs = Math.hypot(rx, ry, rz);
    let ax = -P.dragK * rs * rx;
    let ay = -P.dragK * rs * ry;
    const az = -P.gravityFtS2 - P.dragK * rs * rz;
    if (o.hookAccel !== 0) {
      const h = Math.hypot(s.vx, s.vy) || 1;
      const sp = Math.hypot(s.vx, s.vy, s.vz) / o.v0;
      ax += o.hookAccel * sp * (s.vy / h);
      ay += o.hookAccel * sp * (-s.vx / h);
    }
    const vx = s.vx + ax * dt;
    const vy = s.vy + ay * dt;
    const vz = s.vz + az * dt;
    s = { t: s.t + dt, x: s.x + vx * dt, y: s.y + vy * dt, z: s.z + vz * dt, vx, vy, vz };

    if (s.z <= 0 && s.vz < 0) {
      if (firstGroundIndex < 0) firstGroundIndex = out.length;
      if (!o.bounce) {
        out.push({ ...s, z: 0 });
        break;
      }
      bounces++;
      const fr = P.groundFriction;
      s = { ...s, z: 0, vz: -s.vz * P.groundRestitution, vx: s.vx * fr, vy: s.vy * fr };
      o = { ...o, hookAccel: 0 };
      if (bounces > P.maxGroundBounces || Math.hypot(s.vx, s.vy, s.vz) < 4) {
        s = { ...s, vx: 0, vy: 0, vz: 0 };
        resting = true;
      }
    }
    out.push(s);
    if (o.stopAtY !== undefined && s.y >= o.stopAtY) break;
  }
  return { samples: out, firstGroundIndex };
}

function launchState(x0: number, dirRad: number, v0: number): State {
  const e = (CONFIG.physics.launchAngleDeg * Math.PI) / 180;
  const h = v0 * Math.cos(e);
  return { t: 0, x: x0, y: 0, z: 0, vx: h * Math.sin(dirRad), vy: h * Math.cos(dirRad), vz: v0 * Math.sin(e) };
}

/** Height (ft) at which a straight, calm, full-speed kick passes y = planeY; very negative if it lands first. */
function heightAtPlane(v0: number, planeY: number): number {
  const run = integrate(launchState(0, 0, v0), {
    windX: 0,
    windY: 0,
    hookAccel: 0,
    v0,
    bounce: false,
    stopAtY: planeY,
    maxT: CONFIG.physics.maxFlightS,
  });
  const n = run.samples.length;
  const last = run.samples[n - 1];
  if (last.y < planeY) return -1000 + last.y;
  const prev = run.samples[n - 2];
  const f = (planeY - prev.y) / (last.y - prev.y);
  return prev.z + (last.z - prev.z) * f;
}

const speedCache = new Map<number, number>();

/** Launch speed (ft/s) at which a calm, dead-straight kick just clears the crossbar from rangeYd. */
export function launchSpeedForRange(rangeYd: number): number {
  const key = Math.round(rangeYd * 100);
  const hit = speedCache.get(key);
  if (hit !== undefined) return hit;
  let lo = 20;
  let hi = 300;
  const plane = rangeYd * 3;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (heightAtPlane(mid, plane) > CONFIG.field.crossbarHeightFt) hi = mid;
    else lo = mid;
  }
  const v = (lo + hi) / 2;
  speedCache.set(key, v);
  return v;
}

function interpAt(a: State, b: State, f: number): State {
  const l = (p: number, q: number) => p + (q - p) * f;
  return { t: l(a.t, b.t), x: l(a.x, b.x), y: l(a.y, b.y), z: l(a.z, b.z), vx: l(a.vx, b.vx), vy: l(a.vy, b.vy), vz: l(a.vz, b.vz) };
}

function toPath(samples: State[]): Vec3[] {
  const path: Vec3[] = [];
  for (let i = 0; i < samples.length; i += SAMPLE_EVERY) {
    const s = samples[i];
    path.push({ x: s.x, y: s.y, z: s.z });
  }
  const last = samples[samples.length - 1];
  path.push({ x: last.x, y: last.y, z: last.z });
  return path;
}

// ---------------------------------------------------------------------------
// Resolving a kick

export function resolveKick(setup: KickSetup, input: KickInputs, kicker: KickerRatings, rng: Rng): KickResult {
  const P = CONFIG.physics;
  const S = CONFIG.strike;
  const level = CONFIG.levels[setup.level];
  const crossbar = CONFIG.field.crossbarHeightFt;
  const planeY = goalPlaneY(setup.distanceYd);
  const half = level.uprightWidthFt / 2;
  const cr = P.ballContactRadiusFt;
  const x0 = kickSpotX(setup.level, setup.hash);

  // Wind: the displayed number is close, not exact.
  const windActualMph = Math.max(0, setup.windMph * (1 + CONFIG.wind.gustSigma * rng.normal()));
  const windDir = setup.windToDeg + CONFIG.wind.dirJitterDeg * rng.normal();
  const windPush = CONFIG.wind.effectScale * rate(kicker.windControl, CONFIG.ratings.windEffect);
  const w = windVectorFtS(windActualMph * windPush, windDir);

  // Strike quality from the accuracy meter.
  const s = sweetSpotHalf(kicker, input.power);
  const e = Math.max(-1, Math.min(1, input.accuracy));
  const inSweetSpot = Math.abs(e) <= s;
  const beyond = inSweetSpot ? 0 : Math.sign(e) * (Math.abs(e) - s);
  let errDeg = inSweetSpot ? (e / s) * S.insideMaxErrDeg : Math.sign(e) * S.insideMaxErrDeg + beyond * S.outsideErrDegPerUnit;
  errDeg += rng.normal() * rate(kicker.consistency, CONFIG.ratings.driftSigmaDeg);
  const hookAccel = beyond * S.hookAccelPerUnit;

  const v0 = launchSpeedForRange(maxRangeYd(kicker)) * powerSpeedFrac(input.power);
  const aimDir = Math.atan2(input.aimXFt - x0, planeY);
  const dir = aimDir + (errDeg * Math.PI) / 180;

  const blockChance = CONFIG.block.baseChance + Math.max(0, setup.distanceYd - 40) * CONFIG.block.perYardOver40;
  const blocked = rng.next() < blockChance;

  const common = { windActualMph, inSweetSpot, strikeMiss: beyond };

  if (blocked) {
    const blockY = CONFIG.field.snapDepthYd * 3 - 6;
    const up = integrate(launchState(x0, dir, v0), { windX: w.x, windY: w.y, hookAccel: 0, v0, bounce: false, stopAtY: blockY, maxT: 1 });
    const at = up.samples[up.samples.length - 1];
    const deflect: State = { ...at, vx: rng.range(-14, 14), vy: -rng.range(6, 16), vz: rng.range(4, 14) };
    const down = integrate(deflect, { windX: 0, windY: 0, hookAccel: 0, v0, bounce: true, maxT: at.t + 4 });
    const samples = up.samples.concat(down.samples.slice(1));
    return {
      ...common,
      outcome: 'BLOCKED',
      made: false,
      path: toPath(samples),
      decideIndex: Math.floor((up.samples.length - 1) / SAMPLE_EVERY),
      crossXFt: null,
      crossZFt: null,
      carryYd: 0,
      missByFt: 0,
      shortByYd: setup.distanceYd,
    };
  }

  const flight = integrate(launchState(x0, dir, v0), {
    windX: w.x,
    windY: w.y,
    hookAccel,
    v0,
    bounce: true,
    maxT: P.maxFlightS,
  });
  const smp = flight.samples;
  const airEnd = flight.firstGroundIndex < 0 ? smp.length - 1 : flight.firstGroundIndex;

  // Carry: where the ball comes back down through crossbar height.
  let carryYd = 0;
  for (let i = 1; i <= airEnd; i++) {
    if (smp[i - 1].z >= crossbar && smp[i].z < crossbar && smp[i].vz < 0) {
      const f = (smp[i - 1].z - crossbar) / (smp[i - 1].z - smp[i].z);
      carryYd = (smp[i - 1].y + (smp[i].y - smp[i - 1].y) * f) / 3;
      break;
    }
  }
  if (carryYd === 0 && smp[airEnd].z >= crossbar) carryYd = smp[airEnd].y / 3;

  // Crossing of the goal plane while airborne.
  let crossI = -1;
  for (let i = 1; i <= airEnd; i++) {
    if (smp[i].y >= planeY) {
      crossI = i;
      break;
    }
  }

  const base = { ...common, carryYd };

  if (crossI < 0) {
    return {
      ...base,
      outcome: 'SHORT',
      made: false,
      path: toPath(smp),
      decideIndex: Math.floor(airEnd / SAMPLE_EVERY),
      crossXFt: null,
      crossZFt: null,
      missByFt: 0,
      shortByYd: Math.max(0.5, setup.distanceYd - carryYd),
    };
  }

  const a = smp[crossI - 1];
  const b = smp[crossI];
  const at = interpAt(a, b, (planeY - a.y) / (b.y - a.y));
  const ax = Math.abs(at.x);
  const decideIndex = Math.floor(crossI / SAMPLE_EVERY);

  let outcome: Outcome;
  let contact: 'upright' | 'crossbar' | null = null;
  if (at.z < crossbar - cr) {
    outcome = ax > half + 3 ? (at.x < 0 ? 'WIDE_LEFT' : 'WIDE_RIGHT') : 'SHORT';
  } else if (Math.abs(ax - half) <= cr) {
    contact = 'upright';
    const pIn = Math.max(0, Math.min(1, 0.5 + (0.5 * (half - ax)) / cr));
    outcome = rng.next() < pIn ? 'GOOD_UPRIGHT' : 'UPRIGHT_NO';
  } else if (Math.abs(at.z - crossbar) <= cr && ax < half) {
    contact = 'crossbar';
    const pOver = Math.max(0, Math.min(1, 0.5 + (0.5 * (at.z - crossbar)) / cr));
    outcome = rng.next() < pOver ? 'GOOD_CROSSBAR' : 'CROSSBAR_NO';
  } else if (ax < half) {
    outcome = 'GOOD';
  } else {
    outcome = at.x < 0 ? 'WIDE_LEFT' : 'WIDE_RIGHT';
  }

  let samples = smp;
  if (contact) {
    const side = Math.sign(at.x) || 1;
    const vy = Math.abs(at.vy);
    let v: Pick<State, 'vx' | 'vy' | 'vz'>;
    if (outcome === 'GOOD_UPRIGHT') v = { vx: -side * vy * 0.25, vy: vy * 0.35, vz: at.vz * 0.5 };
    else if (outcome === 'UPRIGHT_NO') v = { vx: side * vy * 0.3, vy: -vy * 0.3, vz: at.vz * 0.5 };
    else if (outcome === 'GOOD_CROSSBAR') v = { vx: at.vx * 0.5, vy: vy * 0.35, vz: Math.abs(at.vz) * 0.4 + 4 };
    else v = { vx: at.vx * 0.5, vy: -vy * 0.35, vz: Math.abs(at.vz) * 0.5 + 3 };
    const after = integrate({ ...at, ...v }, { windX: w.x, windY: w.y, hookAccel: 0, v0, bounce: true, maxT: at.t + 4 });
    samples = smp.slice(0, crossI).concat(after.samples);
  }

  const made = outcome === 'GOOD' || outcome === 'GOOD_UPRIGHT' || outcome === 'GOOD_CROSSBAR';
  return {
    ...base,
    outcome,
    made,
    path: toPath(samples),
    decideIndex,
    crossXFt: at.x,
    crossZFt: at.z,
    missByFt: outcome === 'WIDE_LEFT' || outcome === 'WIDE_RIGHT' ? Math.max(0.1, ax - half) : 0,
    shortByYd: outcome === 'SHORT' ? Math.max(0.5, setup.distanceYd - carryYd) : 0,
  };
}

export function describeWind(mph: number, toDeg: number): string {
  if (mph < 1) return 'Calm';
  const a = (toDeg * Math.PI) / 180;
  const along = Math.cos(a);
  const cross = Math.sin(a);
  const parts: string[] = [];
  if (along < -0.38) parts.push('In your face');
  if (along > 0.38) parts.push('At your back');
  if (cross > 0.38) parts.push('left to right');
  if (cross < -0.38) parts.push('right to left');
  const txt = parts.join(', ');
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

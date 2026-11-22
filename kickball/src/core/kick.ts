import { CONFIG } from '../config';
import type { Player } from '../data/types';
import type { Pitch } from './pitch';
import { Rng, clamp, lerp } from './rng';

export type KickType = 'power' | 'liner' | 'bunt';

export interface KickInput {
  pitch: Pitch;
  deltaMs: number; // release time minus plate-crossing time (negative = early)
  holdMs: number; // how long Space was held before release
  aimIndex: number;
  bunt: boolean;
  kicker: Pick<Player, 'contact' | 'power'>;
}

export type KickOutcome =
  | { kind: 'whiff'; reason: 'early' | 'late' | 'reach'; deltaMs: number }
  | {
      kind: 'contact';
      type: KickType;
      sprayDeg: number;
      launchDeg: number;
      exitSpeed: number;
      quality: number;
      deltaMs: number;
      clean: boolean;
    };

const K = CONFIG.kick;

export function kickTypeFor(holdMs: number, bunt: boolean): KickType {
  if (bunt) return 'bunt';
  return holdMs >= K.powerHoldThreshold ? 'power' : 'liner';
}

/** Half-width (ms) of the clean timing window. */
export function cleanWindow(contact: number, pitch: Pitch, bunt: boolean): number {
  const base = lerp(K.cleanWindowMin, K.cleanWindowMax, clamp(contact, 1, 100) / 100);
  const pitchMult = CONFIG.pitch.types[pitch.type].timingMult;
  return base * pitchMult * (bunt ? K.bunt.windowMult : 1);
}

/** Half-width (ms) beyond which the kicker misses entirely. */
export function whiffWindow(contact: number, pitch: Pitch, bunt: boolean): number {
  return cleanWindow(contact, pitch, bunt) + K.whiffBeyondClean * (bunt ? K.bunt.windowMult : 1);
}

/** Direction drift from timing. Early (negative delta) pulls left. */
export function timingDrift(deltaMs: number, clean: number): number {
  const a = Math.abs(deltaMs);
  const mag = a <= clean ? (K.cleanDriftDeg * a) / clean : K.cleanDriftDeg + (a - clean) * K.mishitDriftDegPerMs;
  return Math.sign(deltaMs) * mag;
}

/** 1 = perfect contact, falls off toward the edge of the swing. */
export function contactQuality(deltaMs: number, clean: number, whiff: number): number {
  const a = Math.abs(deltaMs);
  const perfect = clean * K.qualityPerfectFrac;
  if (a <= perfect) return 1;
  if (a <= clean) return lerp(1, K.qualityAtCleanEdge, (a - perfect) / (clean - perfect));
  return lerp(K.qualityAtCleanEdge, K.qualityAtWhiff, clamp((a - clean) / (whiff - clean), 0, 1));
}

export function resolveKick(input: KickInput, rng: Rng): KickOutcome {
  const { pitch, deltaMs, holdMs, aimIndex, bunt, kicker } = input;
  const clean = cleanWindow(kicker.contact, pitch, bunt);
  const whiff = whiffWindow(kicker.contact, pitch, bunt);

  if (Math.abs(pitch.targetX) > CONFIG.pitch.reach) return { kind: 'whiff', reason: 'reach', deltaMs };
  if (deltaMs < -whiff) return { kind: 'whiff', reason: 'early', deltaMs };
  if (deltaMs > whiff) return { kind: 'whiff', reason: 'late', deltaMs };

  const type = kickTypeFor(holdMs, bunt);
  let quality = contactQuality(deltaMs, clean, whiff);
  if (Math.abs(pitch.targetX) > CONFIG.pitch.plateHalfWidth) quality *= CONFIG.pitch.offPlatePenalty;

  const jitter = (rng() * 2 - 1) * K.sprayJitterDeg;
  const aim = K.aimZones[clamp(aimIndex, 0, K.aimZones.length - 1)].deg;
  let sprayDeg: number;
  if (type === 'bunt') {
    const aimed = (aim / 30) * K.bunt.maxSprayDeg;
    sprayDeg = aimed + timingDrift(deltaMs, clean) + jitter;
  } else {
    sprayDeg = aim + timingDrift(deltaMs, clean) + jitter;
  }

  const powerFrac = clamp(kicker.power, 1, 100) / 100;
  let exitSpeed: number;
  let launchDeg: number;
  const mishit = (1 - quality) / (1 - K.qualityAtWhiff); // 0 = perfect, 1 = barely touched it
  if (type === 'power') {
    const chargeT = clamp((holdMs - K.powerHoldThreshold) / (K.powerFullCharge - K.powerHoldThreshold), 0, 1);
    const charge = lerp(K.powerChargeMinFrac, 1, chargeT);
    exitSpeed = lerp(K.power.speedMin, K.power.speedMax, powerFrac) * quality * charge;
    launchDeg = K.power.launchDeg + (rng() * 2 - 1) * K.power.launchJitterDeg + mishit * K.power.mishitLaunchRise;
  } else if (type === 'liner') {
    exitSpeed = lerp(K.liner.speedMin, K.liner.speedMax, powerFrac) * quality;
    launchDeg = K.liner.launchDeg + (rng() * 2 - 1) * K.liner.launchJitterDeg - mishit * K.liner.mishitLaunchDrop;
  } else {
    exitSpeed = lerp(K.bunt.speedMin, K.bunt.speedMax, powerFrac) * quality;
    launchDeg = K.bunt.launchDeg + (rng() * 2 - 1) * K.bunt.launchJitterDeg;
  }

  return {
    kind: 'contact',
    type,
    sprayDeg,
    launchDeg: Math.max(0, launchDeg),
    exitSpeed,
    quality,
    deltaMs,
    clean: Math.abs(deltaMs) <= clean,
  };
}

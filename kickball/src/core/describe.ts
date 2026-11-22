import type { Flight } from './flight';
import type { KickOutcome } from './kick';

function outfieldDirection(deg: number): string {
  if (deg < -38) return 'down the left-field line';
  if (deg < -22) return 'to left';
  if (deg < -8) return 'to left-center';
  if (deg <= 8) return 'to center';
  if (deg <= 22) return 'to right-center';
  if (deg <= 38) return 'to right';
  return 'down the right-field line';
}

function infieldDirection(deg: number): string {
  if (deg < -30) return 'to third';
  if (deg < -10) return 'to short';
  if (deg <= 10) return 'up the middle';
  if (deg <= 30) return 'to second';
  return 'to first';
}

/** One line of result text for a ball that was kicked. */
export function describeKick(k: Extract<KickOutcome, { kind: 'contact' }>, f: Flight): string {
  const ft = Math.round(f.landing.distance);
  if (!f.fair) {
    const side = k.sprayDeg < 0 ? 'left' : 'right';
    const how = k.sprayDeg < 0 ? 'Pulled' : 'Pushed';
    if (k.type === 'bunt') return `Bunt rolls foul on the ${side} side.`;
    if (f.maxHeight > 25) return `${how} a high one foul to the ${side}.`;
    return `${how} foul to the ${side}.`;
  }
  if (f.overFence) return `Kicked over the fence ${outfieldDirection(k.sprayDeg)}! Home run, ${ft} ft.`;
  if (k.type === 'bunt') return `Bunt ${infieldDirection(k.sprayDeg)}, dies ${Math.round(f.rest.distance)} ft out.`;
  if (f.maxHeight > 30 && f.landing.distance < 110) return `Pop-up ${infieldDirection(k.sprayDeg)}, ${ft} ft.`;
  if (f.maxHeight < 2.5) return `Grounder ${infieldDirection(k.sprayDeg)}, rolls to ${Math.round(f.rest.distance)} ft.`;
  if (k.type === 'liner') {
    const where = f.landing.distance < 90 ? infieldDirection(k.sprayDeg) : outfieldDirection(k.sprayDeg);
    return `Liner ${where}, ${ft} ft.`;
  }
  const deep = f.landing.distance >= 165 ? 'Deep fly' : 'Fly ball';
  return `${deep} ${outfieldDirection(k.sprayDeg)}, ${ft} ft.`;
}

export function describeWhiff(reason: 'early' | 'late' | 'reach'): string {
  if (reason === 'reach') return "Swung at one way out of reach. Strike.";
  if (reason === 'early') return 'Way out in front. Swing and a miss.';
  return 'Way late. Swing and a miss.';
}

export function timingLabel(deltaMs: number): string {
  const ms = Math.round(Math.abs(deltaMs));
  if (ms < 5) return 'right on time';
  return `${ms} ms ${deltaMs < 0 ? 'early' : 'late'}`;
}

/** Short phrase for where a fair or foul ball went, for the start of a play's result line. */
export function kickPhrase(k: Extract<KickOutcome, { kind: 'contact' }>, f: Flight): string {
  if (!f.fair) return k.sprayDeg < 0 ? 'Popped up foul on the left side' : 'Popped up foul on the right side';
  if (f.overFence) return `Kicked over the fence ${outfieldDirection(k.sprayDeg)}`;
  if (k.type === 'bunt') return `Bunt ${infieldDirection(k.sprayDeg)}`;
  if (f.maxHeight > 30 && f.landing.distance < 110) return `Pop-up ${infieldDirection(k.sprayDeg)}`;
  if (f.maxHeight < 2.5) return `Grounder ${infieldDirection(k.sprayDeg)}`;
  if (k.type === 'liner') {
    return `Liner ${f.landing.distance < 90 ? infieldDirection(k.sprayDeg) : outfieldDirection(k.sprayDeg)}`;
  }
  return `${f.landing.distance >= 165 ? 'Deep fly' : 'Fly ball'} ${outfieldDirection(k.sprayDeg)}`;
}

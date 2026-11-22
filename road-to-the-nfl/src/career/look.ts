// Turns team colors into kits and a readable accent color.

import type { Kit } from '../kick/figures';
import type { Team } from './types';

function lum(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function lighten(hex: string, amt: number): string {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const f = (v: number) => Math.round(v + (255 - v) * amt);
  return `#${c.map((v) => f(v).toString(16).padStart(2, '0')).join('')}`;
}

/** A bright accent from the team's colors that reads on the dark broadcast panels. */
export function accentFor(team: Team | null): string {
  if (!team) return '#f5b82e';
  const a = team.secondary;
  const b = team.primary;
  const best = lum(a) > lum(b) ? a : b;
  if (lum(best) < 0.28) return lighten(best, 0.45);
  return best;
}

export function kitFor(team: Team | null, fallback: Kit): Kit {
  if (!team) return fallback;
  const darkPrimary = lum(team.primary) < lum(team.secondary);
  const jersey = darkPrimary ? team.primary : team.secondary;
  const trim = darkPrimary ? team.secondary : team.primary;
  return { jersey, trim, pants: '#cfcabb', socks: jersey, helmet: jersey };
}

export function oppKitFor(team: Team): Kit {
  // Road whites against the home team.
  return { jersey: '#ececf0', trim: team.primary, pants: '#d8d8d8', socks: team.primary, helmet: team.primary };
}

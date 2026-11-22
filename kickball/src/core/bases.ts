import { CONFIG } from '../config';

/** Distance from home to first along each axis (bases sit on a diamond). */
export const BASE_OFFSET = CONFIG.field.baseDistance / Math.SQRT2;

/** Base index: 0 = home (start), 1 = first, 2 = second, 3 = third, 4 = home (scored). */
export function baseXY(i: number): { x: number; y: number } {
  switch (((i % 4) + 4) % 4) {
    case 1:
      return { x: BASE_OFFSET, y: BASE_OFFSET };
    case 2:
      return { x: 0, y: 2 * BASE_OFFSET };
    case 3:
      return { x: -BASE_OFFSET, y: BASE_OFFSET };
    default:
      return { x: 0, y: 0 };
  }
}

/** Point along the base path. p runs from 0 (home) to 4 (home again). */
export function pathXY(p: number): { x: number; y: number } {
  const lo = Math.floor(Math.max(0, Math.min(4, p)));
  const hi = Math.min(4, lo + 1);
  const f = Math.max(0, Math.min(4, p)) - lo;
  const a = baseXY(lo);
  const b = baseXY(hi);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

export const BASE_NAMES = ['home', 'first', 'second', 'third', 'home'];
export const BASE_SHORT = ['home', '1st', '2nd', '3rd', 'home'];

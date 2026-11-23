// Three career slots in browser storage. Every read and write is guarded: storage can be
// blocked (private windows, embedded previews) and the game must still run.

import { migrateCareer } from './career';
import type { Career } from './types';

const KEY = (slot: number) => `rtn.career.${slot}`;
export const SLOTS = [1, 2, 3];

export function loadCareer(slot: number): Career | null {
  try {
    const raw = localStorage.getItem(KEY(slot));
    if (!raw) return null;
    const c = JSON.parse(raw) as Career;
    return c && c.v === 1 ? migrateCareer(c) : null;
  } catch {
    return null;
  }
}

export function saveCareer(c: Career): boolean {
  try {
    localStorage.setItem(KEY(c.slot), JSON.stringify({ ...c, updatedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function deleteCareer(slot: number) {
  try {
    localStorage.removeItem(KEY(slot));
  } catch {
    /* nothing to do */
  }
}

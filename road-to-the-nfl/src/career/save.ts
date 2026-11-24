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

// Save codes: move a career between browsers (for example from the hosted page to an offline copy).
const PREFIX = 'RTN1:';

export function exportCode(c: Career): string {
  const json = JSON.stringify(c);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return PREFIX + btoa(bin);
}

export function importCode(code: string, slot: number): Career | null {
  try {
    const raw = code.trim();
    if (!raw.startsWith(PREFIX)) return null;
    const bin = atob(raw.slice(PREFIX.length).replace(/\s+/g, ''));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const c = JSON.parse(new TextDecoder().decode(bytes)) as Career;
    if (!c || c.v !== 1 || !c.kicker || !c.skills) return null;
    return migrateCareer({ ...c, slot });
  } catch {
    return null;
  }
}

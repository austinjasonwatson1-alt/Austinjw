import { proposeFixes, type ProposedFix } from '../readiness/hygiene';
import type { TrackerSnapshot } from '../tracker/types';

export interface FixWriter {
  apply(fix: ProposedFix): Promise<void>;
}

export interface FixResult {
  id: string;
  ok: boolean;
  text: string;
  error?: string;
}

export const MAX_FIXES_PER_APPLY = 50;

/**
 * Applies the subset of server-computed proposals a person confirmed. Proposals are recomputed
 * from fresh tracker data on the server, and only requested ids that are still proposed are
 * applied, so a stale or tampered request can't write anything the rules wouldn't. One at a
 * time; one failure doesn't stop the rest.
 */
export async function applyConfirmed<T extends { id: string }>(
  proposals: T[],
  requestedIds: string[],
  apply: (p: T) => Promise<void>,
  label: (p: T) => string,
): Promise<{ results: FixResult[]; skipped: string[] }> {
  const wanted = new Set(requestedIds.slice(0, MAX_FIXES_PER_APPLY));
  const todo = proposals.filter((p) => wanted.has(p.id));
  const skipped = [...wanted].filter((id) => !todo.some((p) => p.id === id));
  const results: FixResult[] = [];
  for (const p of todo) {
    try {
      await apply(p);
      results.push({ id: p.id, ok: true, text: label(p) });
    } catch (e) {
      results.push({ id: p.id, ok: false, text: label(p), error: e instanceof Error ? e.message : 'failed' });
    }
  }
  return { results, skipped };
}

/** Hygiene fixes: the confirmed subset of `proposeFixes` for this snapshot. */
export function applyConfirmedFixes(
  snap: TrackerSnapshot,
  requestedIds: string[],
  writer: FixWriter,
): Promise<{ results: FixResult[]; skipped: string[] }> {
  return applyConfirmed(proposeFixes(snap).fixes, requestedIds, (f: ProposedFix) => writer.apply(f), (f) => f.text);
}

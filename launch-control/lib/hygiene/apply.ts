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
 * Applies the fixes a person confirmed. The server recomputes proposals from fresh tracker
 * data and only applies requested ids that are still proposed, so a stale or tampered
 * request can't write anything the rules wouldn't. Writes run one at a time; one failure
 * doesn't stop the rest.
 */
export async function applyConfirmedFixes(
  snap: TrackerSnapshot,
  requestedIds: string[],
  writer: FixWriter,
): Promise<{ results: FixResult[]; skipped: string[] }> {
  const wanted = new Set(requestedIds.slice(0, MAX_FIXES_PER_APPLY));
  const { fixes } = proposeFixes(snap);
  const todo = fixes.filter((f) => wanted.has(f.id));
  const skipped = [...wanted].filter((id) => !todo.some((f) => f.id === id));
  const results: FixResult[] = [];
  for (const f of todo) {
    try {
      await writer.apply(f);
      results.push({ id: f.id, ok: true, text: f.text });
    } catch (e) {
      results.push({ id: f.id, ok: false, text: f.text, error: e instanceof Error ? e.message : 'failed' });
    }
  }
  return { results, skipped };
}

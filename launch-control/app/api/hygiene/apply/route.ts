import type { NextRequest } from 'next/server';
import { isIsoDate } from '@/lib/dates';
import { applyConfirmedFixes, MAX_FIXES_PER_APPLY } from '@/lib/hygiene/apply';
import { getSource } from '@/lib/tracker';
import { linearFixWriter } from '@/lib/tracker/linear-write';
import { APPLY_RUNS_PER_HOUR, guard } from '@/lib/server/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/hygiene/apply  { asOf, fixIds: string[] }  →  { results, skipped }
 * Linear mode only. Applies the confirmed subset of the fixes the server itself proposes.
 */
export async function POST(req: NextRequest) {
  // Writes to Linear from a public URL: passcode (when set) and a per-IP limit.
  const blocked = guard(req, 'apply', APPLY_RUNS_PER_HOUR);
  if (blocked) return blocked;
  const source = getSource('linear');
  const apiKey = process.env.LINEAR_API_KEY;
  if (!source || !apiKey) return Response.json({ error: 'linear_not_configured' }, { status: 409 });

  let body: { asOf?: unknown; fixIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  const ids = Array.isArray(body.fixIds) ? body.fixIds.filter((x): x is string => typeof x === 'string' && x.length < 80) : [];
  if (!ids.length || ids.length > MAX_FIXES_PER_APPLY) return Response.json({ error: 'bad_request' }, { status: 400 });
  const asOf = isIsoDate(body.asOf) ? body.asOf : new Date().toISOString().slice(0, 10);

  let snap;
  try {
    snap = await source.load(asOf);
  } catch {
    return Response.json({ error: 'linear_unavailable' }, { status: 502 });
  }
  const out = await applyConfirmedFixes(snap, ids, linearFixWriter(apiKey));
  const failed = out.results.filter((r) => !r.ok).length;
  console.log(`[hygiene] applied ${out.results.length - failed}, failed ${failed}, skipped ${out.skipped.length}`);
  return Response.json(out);
}

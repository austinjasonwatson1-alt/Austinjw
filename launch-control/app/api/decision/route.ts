import type { NextRequest } from 'next/server';
import { isIsoDate } from '@/lib/dates';
import { decisionUpdate, type Decision } from '@/lib/readiness/decision';
import { APPLY_RUNS_PER_HOUR, guard } from '@/lib/server/guard';
import { getSource } from '@/lib/tracker';
import { postDecisionToLinear } from '@/lib/tracker/linear-write';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DECISIONS: Decision[] = ['go', 'conditions', 'nogo'];

/**
 * POST /api/decision  { launchId, asOf, decision, note?, execUpdate? }  →  { ok, url, health }
 * Linear mode only. Records a person's go/no-go call as a project update with a health flag.
 * The readiness numbers in the update are recomputed here from fresh Linear data; only the
 * decision, the note and the exec update text come from the browser (bounded, posted as text).
 */
export async function POST(req: NextRequest) {
  const blocked = guard(req, 'decision', APPLY_RUNS_PER_HOUR);
  if (blocked) return blocked;
  const source = getSource('linear');
  const apiKey = process.env.LINEAR_API_KEY;
  if (!source || !apiKey) return Response.json({ error: 'linear_not_configured' }, { status: 409 });

  let body: { launchId?: unknown; asOf?: unknown; decision?: unknown; note?: unknown; execUpdate?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  const decision = DECISIONS.find((d) => d === body.decision);
  if (!decision || typeof body.launchId !== 'string') return Response.json({ error: 'bad_request' }, { status: 400 });
  const asOf = isIsoDate(body.asOf) ? body.asOf : new Date().toISOString().slice(0, 10);

  let snap;
  try {
    snap = await source.load(asOf);
  } catch {
    return Response.json({ error: 'linear_unavailable' }, { status: 502 });
  }
  const launch = snap.launches.find((l) => l.id === body.launchId);
  if (!launch) return Response.json({ error: 'unknown_launch' }, { status: 404 });

  const update = decisionUpdate(launch, snap, decision, {
    note: typeof body.note === 'string' ? body.note : undefined,
    execUpdate: typeof body.execUpdate === 'string' ? body.execUpdate : undefined,
  });
  try {
    const { url } = await postDecisionToLinear(apiKey, launch.id, update);
    console.log(`[decision] posted ${decision} (${update.health})`);
    return Response.json({ ok: true, url, health: update.health });
  } catch (e) {
    console.error(`[decision] failed: ${e instanceof Error ? e.message : 'error'}`);
    return Response.json({ error: 'linear_write_failed' }, { status: 502 });
  }
}

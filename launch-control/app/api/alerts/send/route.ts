import type { NextRequest } from 'next/server';
import { isIsoDate } from '@/lib/dates';
import { applyConfirmed, MAX_FIXES_PER_APPLY } from '@/lib/hygiene/apply';
import { proposeAlerts } from '@/lib/readiness/alerts';
import { APPLY_RUNS_PER_HOUR, guard } from '@/lib/server/guard';
import { getSource } from '@/lib/tracker';
import { linearAlertWriter } from '@/lib/tracker/linear-write';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/alerts/send  { launchId, asOf, alertIds: string[] }  →  { results, skipped }
 * Linear mode only. Recomputes the launch's risk alerts from fresh Linear data and posts the
 * confirmed ones as comments on their tickets.
 */
export async function POST(req: NextRequest) {
  const blocked = guard(req, 'alerts', APPLY_RUNS_PER_HOUR);
  if (blocked) return blocked;
  const source = getSource('linear');
  const apiKey = process.env.LINEAR_API_KEY;
  if (!source || !apiKey) return Response.json({ error: 'linear_not_configured' }, { status: 409 });

  let body: { launchId?: unknown; asOf?: unknown; alertIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  const ids = Array.isArray(body.alertIds) ? body.alertIds.filter((x): x is string => typeof x === 'string' && x.length < 80) : [];
  if (!ids.length || ids.length > MAX_FIXES_PER_APPLY || typeof body.launchId !== 'string') {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const asOf = isIsoDate(body.asOf) ? body.asOf : new Date().toISOString().slice(0, 10);

  let snap;
  try {
    snap = await source.load(asOf);
  } catch {
    return Response.json({ error: 'linear_unavailable' }, { status: 502 });
  }
  const launch = snap.launches.find((l) => l.id === body.launchId);
  if (!launch) return Response.json({ error: 'unknown_launch' }, { status: 404 });

  const writer = linearAlertWriter(apiKey);
  const out = await applyConfirmed(proposeAlerts(snap, launch).alerts, ids, (a) => writer.apply(a), (a) => a.logText);
  const failed = out.results.filter((r) => !r.ok).length;
  console.log(`[alerts] sent ${out.results.length - failed}, not sent ${failed}, skipped ${out.skipped.length}`);
  return Response.json(out);
}

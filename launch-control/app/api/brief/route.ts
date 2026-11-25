import type { NextRequest } from 'next/server';
import { DEADLINE_MS, MODEL, runAgentLoop, toAgentError } from '@/lib/agent/run';
import { getSource } from '@/lib/tracker';
import type { TrackerSnapshot } from '@/lib/tracker/types';
import { parseSnapshot } from '@/lib/tracker/validate';
import { isIsoDate } from '@/lib/dates';
import { AGENT_RUNS_PER_HOUR, guard, passcodeRequired } from '@/lib/server/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY_BYTES = 512_000;

/** GET /api/brief → whether the agent can run (the key itself never leaves the server). */
export function GET() {
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY), passcodeRequired: passcodeRequired(), model: MODEL });
}

/**
 * POST /api/brief  { launchId, snapshot }  →  text/event-stream
 * Events: tool {label} · text {text} (full text so far this turn) · done {text, ms, toolCalls} · error {code, message}
 */
export async function POST(req: NextRequest) {
  // Only Claude runs cost money; with no key the browser uses the rules engine and never calls this.
  const blocked = guard(req, 'brief', AGENT_RUNS_PER_HOUR);
  if (blocked) return blocked;
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: 'too_large' }, { status: 413 });
  let body: { launchId?: unknown; snapshot?: unknown; source?: unknown; asOf?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }
  // Linear mode: the server reads Linear itself, so the agent sees the tracker, not the browser.
  // Demo mode: the browser's edited in-memory snapshot, strictly validated.
  let snap: TrackerSnapshot | null = null;
  if (body.source === 'linear') {
    const src = getSource('linear');
    const asOf = isIsoDate(body.asOf) ? body.asOf : new Date().toISOString().slice(0, 10);
    if (!src) return Response.json({ error: 'linear_not_configured' }, { status: 409 });
    try {
      snap = await src.load(asOf);
    } catch {
      return Response.json({ error: 'linear_unavailable' }, { status: 502 });
    }
  } else {
    snap = parseSnapshot(body.snapshot);
  }
  const launch = snap?.launches.find((l) => l.id === body.launchId);
  if (!snap || !launch) return Response.json({ error: 'bad_request' }, { status: 400 });
  const data = snap;

  const enc = new TextEncoder();
  const deadline = AbortSignal.any([req.signal, AbortSignal.timeout(DEADLINE_MS)]);

  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const send = (event: string, data: unknown) => {
        try {
          ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* client went away */
        }
      };
      try {
        const run = await runAgentLoop(data, launch, {
          signal: deadline,
          onTool: (label) => send('tool', { label }),
          onText: (text) => send('text', { text }),
        });
        send('done', { text: run.text, ms: run.ms, toolCalls: run.toolCalls });
      } catch (e) {
        const err = toAgentError(e, deadline);
        console.error(`[brief] ${launch.id} failed: ${err.code}`); // code only: never log keys or payloads
        send('error', { code: err.code, message: err.message });
      } finally {
        try {
          ctl.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

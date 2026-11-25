import { unstable_cache } from 'next/cache';
import type { NextRequest } from 'next/server';
import { DEADLINE_MS, runAgentLoop, toAgentError } from '@/lib/agent/run';
import { daysBetween, isIsoDate } from '@/lib/dates';
import { demoSnapshot } from '@/lib/tracker/demo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/brief/sample?launch=L1&today=YYYY-MM-DD
 * A real agent brief for the untouched demo data, so a visitor without the passcode still sees
 * Claude's work. Generated once per launch per day and cached (shared across instances on
 * Vercel), so the cost is bounded: at most 5 launches × 3 dates a day, about a cent each.
 * Live runs, edited data and Linear data still go through POST /api/brief and its passcode.
 */
let generatedThisHour = { start: 0, n: 0 };
const MAX_GENERATIONS_PER_HOUR = 20; // per instance backstop if the cache is cold or evicted

const saved = unstable_cache(
  async (launchId: string, asOf: string) => {
    const now = Date.now();
    if (now - generatedThisHour.start > 3_600_000) generatedThisHour = { start: now, n: 0 };
    if (generatedThisHour.n++ >= MAX_GENERATIONS_PER_HOUR) throw new Error('sample_budget');
    const snap = demoSnapshot(asOf);
    const launch = snap.launches.find((l) => l.id === launchId);
    if (!launch) throw new Error('unknown_launch');
    const trace: string[] = [];
    const run = await runAgentLoop(snap, launch, { signal: AbortSignal.timeout(DEADLINE_MS), onTool: (t) => trace.push(t) });
    return { text: run.text, ms: run.ms, toolCalls: run.toolCalls, trace, asOf };
  },
  ['sample-brief-v2'],
  { revalidate: 86_400 },
);

const codeOf = (e: unknown) => toAgentError(e, new AbortController().signal).code;

export async function GET(req: NextRequest) {
  // Failures answer 200 with available:false: a missing sample is normal, not an error in the visitor's console.
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ available: false, reason: 'no_key' });
  const q = req.nextUrl.searchParams;
  const launch = q.get('launch') ?? '';
  const serverToday = new Date().toISOString().slice(0, 10);
  const asked = q.get('today');
  const asOf = isIsoDate(asked) && Math.abs(daysBetween(serverToday, asked)) <= 1 ? asked : serverToday;
  if (!/^L[1-5]$/.test(launch)) return Response.json({ error: 'bad_request' }, { status: 400 });
  try {
    return Response.json(await saved(launch, asOf));
  } catch (e) {
    const reason = e instanceof Error && e.message === 'sample_budget' ? 'budget' : codeOf(e);
    console.error(`[sample] ${launch} failed: ${reason}`); // code only
    return Response.json({ available: false, reason });
  }
}

import Anthropic from '@anthropic-ai/sdk';
import type { NextRequest } from 'next/server';
import { agentPrompt } from '@/lib/agent/prompt';
import { runTool, ToolInputError, TOOL_DEFS } from '@/lib/agent/tools';
import { getSource } from '@/lib/tracker';
import type { TrackerSnapshot } from '@/lib/tracker/types';
import { parseSnapshot } from '@/lib/tracker/validate';
import { isIsoDate } from '@/lib/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MODEL = 'claude-sonnet-5-5';
const MAX_TOOL_TURNS = 6;
const DEADLINE_MS = 45_000; // PRD §6: Claude error/timeout (45 s) → rules brief
const MAX_BODY_BYTES = 512_000;

const TOOLS: Anthropic.Beta.BetaTool[] = TOOL_DEFS.map((t) => ({ ...t, eager_input_streaming: true }));

/** GET /api/brief → whether the agent can run (the key itself never leaves the server). */
export function GET() {
  return Response.json({ available: Boolean(process.env.ANTHROPIC_API_KEY), model: MODEL });
}

class AgentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function errorCode(e: unknown, deadline: AbortSignal): AgentError {
  if (e instanceof AgentError) return e;
  if (deadline.aborted) return new AgentError('timeout', 'Claude took longer than 45 seconds.');
  if (e instanceof Anthropic.AuthenticationError) return new AgentError('auth', 'The Claude API key was rejected.');
  if (e instanceof Anthropic.RateLimitError) return new AgentError('rate_limited', 'Claude is rate limited right now.');
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AgentError('timeout', 'Claude timed out.');
  if (e instanceof Anthropic.APIConnectionError) return new AgentError('network', 'Could not reach Claude.');
  if (e instanceof Anthropic.APIError) return new AgentError(`api_${e.status ?? 'error'}`, 'Claude returned an error.');
  return new AgentError('error', 'The agent failed.');
}

/**
 * POST /api/brief  { launchId, snapshot }  →  text/event-stream
 * Events: tool {label} · text {text} (full text so far this turn) · done {text, ms, toolTurns} · error {code, message}
 */
export async function POST(req: NextRequest) {
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
  const started = Date.now();
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
        if (!process.env.ANTHROPIC_API_KEY) throw new AgentError('no_key', 'No Claude API key is configured.');
        const client = new Anthropic({ timeout: DEADLINE_MS, maxRetries: 1 });
        const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: agentPrompt(launch, data.asOf) }];
        let toolTurns = 0;
        let parseRetries = 0;

        for (;;) {
          const turn = client.beta.messages.stream(
            {
              model: MODEL,
              max_tokens: 8000,
              output_config: { effort: 'medium' },
              betas: ['server-side-fallback-2026-07-01'],
              fallbacks: 'default',
              tools: TOOLS,
              // After the tool-turn cap, Claude must write the brief from what it has.
              tool_choice: { type: toolTurns < MAX_TOOL_TURNS ? 'auto' : 'none' },
              messages,
            },
            { signal: deadline },
          );
          let text = '';
          turn.on('text', (delta) => {
            text += delta;
            send('text', { text });
          });

          let msg: Anthropic.Beta.BetaMessage;
          try {
            msg = await turn.finalMessage();
            parseRetries = 0;
          } catch (e) {
            // An unparseable streamed tool input (or dropped stream) is retried once; API errors are not.
            if (e instanceof Anthropic.APIError || deadline.aborted || parseRetries++ >= 1) throw e;
            continue;
          }

          if (msg.stop_reason === 'refusal') throw new AgentError('refusal', 'Claude declined this request.');
          if (msg.stop_reason === 'pause_turn') {
            messages.push({ role: 'assistant', content: msg.content });
            continue;
          }
          const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
          if (!uses.length) {
            const final = msg.content
              .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('')
              .trim();
            if (!final) throw new AgentError('empty', 'Claude returned no brief.');
            send('done', { text: final, ms: Date.now() - started, toolTurns });
            break;
          }
          if (msg.stop_reason === 'max_tokens') throw new AgentError('truncated', 'Claude ran out of tokens.');

          messages.push({ role: 'assistant', content: msg.content });
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = uses.map((u) => {
            try {
              const r = runTool(data, u.name, u.input);
              send('tool', { label: r.trace });
              return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(r.result) };
            } catch (e) {
              const message = e instanceof ToolInputError ? e.message : 'Tool failed';
              send('tool', { label: `${u.name} · error: ${message}` });
              return { type: 'tool_result', tool_use_id: u.id, content: message, is_error: true };
            }
          });
          messages.push({ role: 'user', content: results });
          toolTurns++;
        }
      } catch (e) {
        const err = errorCode(e, deadline);
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

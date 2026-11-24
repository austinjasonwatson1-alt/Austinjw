import Anthropic from '@anthropic-ai/sdk';
import type { Launch, TrackerSnapshot } from '../tracker/types';
import { agentPrompt } from './prompt';
import { runTool, ToolInputError, TOOL_DEFS } from './tools';

export const MODEL = 'claude-sonnet-5-5';
export const MAX_TOOL_TURNS = 6;
export const DEADLINE_MS = 45_000; // PRD §6: Claude error/timeout (45 s) → rules brief
/** Claude Sonnet 5.5 list prices, USD per million tokens (for the eval's cost estimate). */
export const PRICE_PER_MTOK = { input: 2, output: 10, cacheRead: 0.1 };

const TOOLS: Anthropic.Beta.BetaTool[] = TOOL_DEFS.map((t) => ({ ...t, eager_input_streaming: true }));

export class AgentError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function toAgentError(e: unknown, deadline: AbortSignal): AgentError {
  if (e instanceof AgentError) return e;
  if (deadline.aborted) return new AgentError('timeout', 'Claude took longer than 45 seconds.');
  if (e instanceof Anthropic.AuthenticationError) return new AgentError('auth', 'The Claude API key was rejected.');
  if (e instanceof Anthropic.RateLimitError) return new AgentError('rate_limited', 'Claude is rate limited right now.');
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AgentError('timeout', 'Claude timed out.');
  if (e instanceof Anthropic.APIConnectionError) return new AgentError('network', 'Could not reach Claude.');
  if (e instanceof Anthropic.APIError) return new AgentError(`api_${e.status ?? 'error'}`, 'Claude returned an error.');
  return new AgentError('error', 'The agent failed.');
}

export interface AgentRun {
  text: string;
  ms: number;
  toolCalls: number;
  toolTurns: number;
  usage: { input: number; output: number; cacheRead: number };
}

/**
 * The readiness agent: Claude with three read-only tools over one snapshot, at most
 * MAX_TOOL_TURNS tool turns, then it must write. Used by /api/brief and scripts/eval-agent.ts.
 */
export async function runAgentLoop(
  snap: TrackerSnapshot,
  launch: Launch,
  opts: { signal: AbortSignal; onTool?: (label: string) => void; onText?: (textSoFar: string) => void },
): Promise<AgentRun> {
  const started = Date.now();
  if (!process.env.ANTHROPIC_API_KEY) throw new AgentError('no_key', 'No Claude API key is configured.');
  const client = new Anthropic({ timeout: DEADLINE_MS, maxRetries: 1 });
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: agentPrompt(launch, snap.asOf) }];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let toolTurns = 0;
  let toolCalls = 0;
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
      { signal: opts.signal },
    );
    let text = '';
    turn.on('text', (delta) => {
      text += delta;
      opts.onText?.(text);
    });

    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await turn.finalMessage();
      parseRetries = 0;
    } catch (e) {
      // An unparseable streamed tool input (or dropped stream) is retried once; API errors are not.
      if (e instanceof Anthropic.APIError || opts.signal.aborted || parseRetries++ >= 1) throw e;
      continue;
    }
    usage.input += msg.usage.input_tokens ?? 0;
    usage.output += msg.usage.output_tokens ?? 0;
    usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;

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
      return { text: final, ms: Date.now() - started, toolCalls, toolTurns, usage };
    }
    if (msg.stop_reason === 'max_tokens') throw new AgentError('truncated', 'Claude ran out of tokens.');

    messages.push({ role: 'assistant', content: msg.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = uses.map((u) => {
      toolCalls++;
      try {
        const r = runTool(snap, u.name, u.input);
        opts.onTool?.(r.trace);
        return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(r.result) };
      } catch (e) {
        const message = e instanceof ToolInputError ? e.message : 'Tool failed';
        opts.onTool?.(`${u.name} · error: ${message}`);
        return { type: 'tool_result', tool_use_id: u.id, content: message, is_error: true };
      }
    });
    messages.push({ role: 'user', content: results });
    toolTurns++;
  }
}

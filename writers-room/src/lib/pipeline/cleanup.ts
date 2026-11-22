import Anthropic from "@anthropic-ai/sdk";
import { basicCleanup } from "./basic-cleanup";
import { checkCleanup } from "./guard";
import { FILLERS } from "./words";

export const CLEANUP_MODEL = "claude-opus-5-5";

export type CleanupMethod = "ai" | "basic";
export type CleanedNote = {
  text: string;
  method: CleanupMethod;
  /** Why the AI version was not used, if it wasn't. */
  rejected?: string;
};

const SYSTEM = `You tidy up voice-note transcripts for a novelist. The words are the author's and must stay exactly theirs.

You may ONLY:
- remove these hesitation sounds: ${[...FILLERS].join(", ")}
- remove a word the speaker accidentally said twice in a row ("the the" -> "the")
- change punctuation and capitalization (add commas, periods, question marks; capitalize sentence starts and names)

You must NEVER add a word, remove any other word, change a word (including spelling out or converting numbers), reorder words, or fix grammar. If in doubt, leave it as it is. Return one cleaned note per input note, in the same order.`;

const SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "integer" }, text: { type: "string" } },
        required: ["index", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
} as const;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client ??= new Anthropic();
  return client;
}

/** Ask Claude for punctuation-and-filler cleanup of each note. Returns null if unavailable. */
async function aiCleanup(segments: string[]): Promise<(string | null)[] | null> {
  const c = getClient();
  if (!c || segments.length === 0) return null;
  const response = await c.beta.messages.create({
    model: CLEANUP_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify({ notes: segments.map((text, index) => ({ index, text })) }),
      },
    ],
  });
  if (response.stop_reason !== "end_turn") return null;
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") return null;
  const parsed = JSON.parse(text.text) as { notes: { index: number; text: string }[] };
  const out: (string | null)[] = segments.map(() => null);
  for (const n of parsed.notes) if (n.index >= 0 && n.index < out.length) out[n.index] = n.text;
  return out;
}

/**
 * Clean each note. Every AI result is checked word-for-word against the
 * transcript; anything that adds, changes or reorders a word is thrown away
 * and replaced by the code-only cleanup, which can only remove fillers.
 */
export async function cleanNotes(segments: string[]): Promise<CleanedNote[]> {
  let ai: (string | null)[] | null = null;
  let aiError: string | undefined;
  try {
    ai = await aiCleanup(segments);
  } catch (e) {
    aiError = e instanceof Error ? e.message : String(e);
    console.error("AI cleanup failed, using basic cleanup:", aiError);
  }
  return segments.map((raw, i) => {
    const candidate = ai?.[i];
    if (candidate != null) {
      const check = checkCleanup(raw, candidate);
      if (check.ok) return { text: candidate.trim(), method: "ai" };
      return { text: basicCleanup(raw), method: "basic", rejected: check.reason };
    }
    return {
      text: basicCleanup(raw),
      method: "basic",
      rejected: ai ? "missing from AI response" : aiError ? "AI unavailable" : undefined,
    };
  });
}

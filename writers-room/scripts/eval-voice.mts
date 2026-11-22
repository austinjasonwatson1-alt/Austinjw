/**
 * Voice test (SPEC.md "Testing the AI" #3): cleaned transcripts keep the
 * author's wording, with no added sentences.
 *
 *   npm run eval:voice
 *
 * Runs every fixture through the real pipeline (split -> AI cleanup -> word
 * check). With ANTHROPIC_API_KEY set it measures the AI cleanup; without it,
 * only the code-only cleanup runs. Writes a dated report to evals/results/.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { cleanNotes, CLEANUP_MODEL } from "../src/lib/pipeline/cleanup";
import { checkCleanup } from "../src/lib/pipeline/guard";
import { splitTranscript } from "../src/lib/pipeline/split";

type Case = { id: string; transcript: string; expect: { label: string | null }[] };
const { cases } = JSON.parse(readFileSync("evals/fixtures/voice.json", "utf8")) as { cases: Case[] };

const usingAI = Boolean(process.env.ANTHROPIC_API_KEY);
const rows: Record<string, unknown>[] = [];
let notes = 0, aiAccepted = 0, aiRejected = 0, finalPass = 0, splitOk = 0, fillersRemoved = 0;

for (const c of cases) {
  const segs = splitTranscript(c.transcript);
  const labelsOk =
    segs.length === c.expect.length && segs.every((s, i) => s.spokenSpace === c.expect[i].label);
  if (labelsOk) splitOk++;
  const cleaned = await cleanNotes(segs.map((s) => s.content));
  segs.forEach((s, i) => {
    notes++;
    const out = cleaned[i];
    const check = checkCleanup(s.content, out.text);
    if (check.ok) {
      finalPass++;
      fillersRemoved += check.removed.length;
    }
    if (out.method === "ai") aiAccepted++;
    else if (out.rejected && out.rejected !== "AI unavailable") aiRejected++;
    rows.push({ case: c.id, said: s.content, kept: out.text, method: out.method, passes_check: check.ok, ai_rejected_because: out.rejected ?? null });
  });
  console.log(`${labelsOk ? "✓" : "✗"} ${c.id}: ${segs.length} note(s)`);
}

const date = new Date().toISOString().slice(0, 10);
const summary = {
  date,
  cleanup: usingAI ? `AI (${CLEANUP_MODEL}) with word-for-word check, code-only fallback` : "code-only (no ANTHROPIC_API_KEY set)",
  fixtures: cases.length,
  notes,
  split_and_labels_correct: `${splitOk}/${cases.length}`,
  final_notes_passing_word_check: `${finalPass}/${notes}`,
  ai_versions_accepted: usingAI ? `${aiAccepted}/${notes}` : "n/a",
  ai_versions_rejected_by_check: usingAI ? aiRejected : "n/a",
  filler_words_removed: fillersRemoved,
};
console.log(summary);

mkdirSync("evals/results", { recursive: true });
const base = `evals/results/voice-${date}${usingAI ? "" : "-code-only"}`;
writeFileSync(`${base}.json`, JSON.stringify({ summary, rows }, null, 2));
const md = [
  `# Voice test: ${date}`,
  "",
  "Do cleaned transcripts keep the author's exact wording? Every kept note is checked word for word against what was said: only hesitation sounds and stutters may be removed, and punctuation may change.",
  "",
  ...Object.entries(summary).map(([k, v]) => `- **${k.replace(/_/g, " ")}:** ${v}`),
  "",
  "| Case | What was said | What was kept | Cleanup | Passes check |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.case} | ${r.said} | ${r.kept} | ${r.method}${r.ai_rejected_because && r.ai_rejected_because !== "AI unavailable" ? ` (AI version rejected: ${r.ai_rejected_because})` : ""} | ${r.passes_check ? "yes" : "**no**"} |`),
  "",
].join("\n");
writeFileSync(`${base}.md`, md);
console.log(`Report written to ${base}.md`);
if (finalPass !== notes) process.exit(1);

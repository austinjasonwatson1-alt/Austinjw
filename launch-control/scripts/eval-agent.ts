/**
 * Evaluates the readiness agent against the data it reads, with the same loop the app runs.
 *
 *   npm run eval -- --runs 3        # 2 scenarios × 5 launches × 3 runs (~$0.40 of Claude usage)
 *
 * Scenarios: "fresh" is the demo data as loaded (only L1 at risk); "a week later" changes five
 * tickets so four launches are at risk for different reasons (blocked, overdue, due after
 * go/no-go) and L1's blocker clears.
 *
 * Per brief: does the call match the rules engine? Are any cited issue ids invented? Does it
 * cite every at-risk ticket? Is the 4-section format intact? Plus latency and cost.
 * Writes docs/EVAL.md.
 */
import { writeFileSync } from 'node:fs';
import { DEADLINE_MS, MODEL, PRICE_PER_MTOK, runAgentLoop, toAgentError } from '../lib/agent/run';
import { verifyBrief } from '../lib/agent/verify';
import { addDays, localToday } from '../lib/dates';
import { demoSnapshot } from '../lib/tracker/demo';
import type { Issue, TrackerSnapshot } from '../lib/tracker/types';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* rely on the shell environment */
}

const argv = process.argv.slice(2);
const num = (flag: string, d: number) => (argv.includes(flag) ? Number(argv[argv.indexOf(flag) + 1]) || d : d);
const RUNS = num('--runs', 3);
const CONCURRENCY = num('--concurrency', 3);
const HEADINGS = ['Recommendation', 'Blocking risks', 'Before go/no-go', 'Exec update'];

/** Five realistic changes; each moves a gate into or out of risk for a different reason. */
function weekLater(s: TrackerSnapshot): TrackerSnapshot {
  const change: Record<string, (i: Issue) => Partial<Issue>> = {
    'LCH-126': () => ({ status: 'in_progress' }), // L1 load test unblocked
    'LCH-205': () => ({ status: 'blocked' }), // L2 CI/CD ingestion blocked
    'LCH-308': () => ({ due: addDays(s.asOf, -1) }), // L3 contract tests overdue
    'LCH-403': () => ({ status: 'in_progress', due: addDays(s.asOf, -1) }), // L4 regression reopened, overdue
    'LCH-503': () => ({ due: addDays(s.asOf, 29) }), // L5 visual snapshots due after go/no-go
  };
  return { ...s, issues: s.issues.map((i) => (change[i.id] ? { ...i, ...change[i.id](i) } : i)) };
}

interface Row {
  scenario: string;
  launch: string;
  run: number;
  ok: boolean;
  error?: string;
  ms?: number;
  toolCalls?: number;
  cost?: number;
  call?: string | null;
  rulesCall?: string;
  agrees?: boolean;
  cited?: number;
  unknown?: string[];
  riskIds?: string[];
  missed?: string[];
  format?: boolean;
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

async function main() {
  const asOf = localToday();
  const fresh = demoSnapshot(asOf);
  const scenarios: [string, TrackerSnapshot][] = [
    ['fresh', fresh],
    ['a week later', weekLater(fresh)],
  ];
  const jobs = scenarios.flatMap(([scenario, snap]) =>
    snap.launches.flatMap((l) => Array.from({ length: RUNS }, (_, i) => ({ scenario, snap, l, run: i + 1 }))),
  );
  console.log(`Eval: ${MODEL}, ${jobs.length} briefs (${scenarios.length} scenarios × ${fresh.launches.length} launches × ${RUNS}), demo data as of ${asOf}\n`);

  const rows: Row[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { scenario, snap, l, run } = jobs[next++];
      const signal = AbortSignal.timeout(DEADLINE_MS);
      try {
        const r = await runAgentLoop(snap, l, { signal });
        const v = verifyBrief(r.text, snap, l);
        const heads = [...r.text.matchAll(/^##\s*(.+)$/gm)].map((m) => m[1].trim());
        const cost =
          (r.usage.input * PRICE_PER_MTOK.input + r.usage.output * PRICE_PER_MTOK.output + r.usage.cacheRead * PRICE_PER_MTOK.cacheRead) / 1e6;
        const row: Row = {
          scenario,
          launch: l.name,
          run,
          ok: true,
          ms: r.ms,
          toolCalls: r.toolCalls,
          cost,
          call: v.call,
          rulesCall: v.rulesCall,
          agrees: v.agrees,
          cited: v.cited.length,
          unknown: v.unknown,
          riskIds: v.riskIds,
          missed: v.missedRisks,
          format: JSON.stringify(heads) === JSON.stringify(HEADINGS),
        };
        rows.push(row);
        console.log(
          `${row.agrees ? '✓' : '✗'} [${scenario}] ${l.name} #${run}: ${v.call} (rules ${v.rulesCall}) · ${v.cited.length} ids, ${v.unknown.length} invented, missed ${v.missedRisks.length}/${v.riskIds.length} risks · ${(r.ms / 1000).toFixed(1)} s · $${cost.toFixed(3)}${row.format ? '' : ' · FORMAT'}`,
        );
      } catch (e) {
        const err = toAgentError(e, signal);
        rows.push({ scenario, launch: l.name, run, ok: false, error: err.code });
        console.log(`✗ [${scenario}] ${l.name} #${run}: failed (${err.code})`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const ok = rows.filter((r) => r.ok);
  const riskTotal = ok.reduce((a, r) => a + r.riskIds!.length, 0);
  const riskMissed = ok.reduce((a, r) => a + r.missed!.length, 0);
  const invented = ok.reduce((a, r) => a + r.unknown!.length, 0);
  const citedTotal = ok.reduce((a, r) => a + r.cited!, 0);
  const agreed = ok.filter((r) => r.agrees).length;
  const ms = ok.map((r) => r.ms!);
  const cost = ok.reduce((a, r) => a + r.cost!, 0);
  const summary: [string, string][] = [
    ['Briefs completed', `${ok.length}/${rows.length}`],
    ['Briefs whose go/no-go call passed the readiness-rules check', `${agreed}/${ok.length} (${pct(agreed, ok.length)})`],
    ['Invented issue ids', `${invented} of ${citedTotal} cited`],
    ['At-risk tickets cited (recall)', `${riskTotal - riskMissed}/${riskTotal} (${pct(riskTotal - riskMissed, riskTotal)})`],
    ['Exact 4-section format', `${ok.filter((r) => r.format).length}/${ok.length}`],
    ['Latency p50 / p95', `${(quantile(ms, 0.5) / 1000).toFixed(1)} s / ${(quantile(ms, 0.95) / 1000).toFixed(1)} s (target < 30 s)`],
    ['Cost per brief (avg)', `$${(cost / Math.max(1, ok.length)).toFixed(3)} (total $${cost.toFixed(2)})`],
  ];
  console.log('\n' + summary.map(([k, v]) => `${k}: ${v}`).join('\n'));

  const order = fresh.launches.map((l) => l.name);
  const sc = scenarios.map(([n]) => n);
  const perBrief = rows
    .sort((a, b) => sc.indexOf(a.scenario) - sc.indexOf(b.scenario) || order.indexOf(a.launch) - order.indexOf(b.launch) || a.run - b.run)
    .map((r) =>
      r.ok
        ? `| ${r.scenario} | ${r.launch} | ${r.run} | ${r.call ?? '?'} (${r.rulesCall}) ${r.agrees ? '✓' : '✗'} | ${r.cited} / ${r.unknown!.length ? r.unknown!.join(', ') : '0'} | ${r.missed!.length ? r.missed!.join(', ') : 'none'} | ${r.format ? '✓' : '✗'} | ${(r.ms! / 1000).toFixed(1)} s | $${r.cost!.toFixed(3)} |`
        : `| ${r.scenario} | ${r.launch} | ${r.run} | failed: ${r.error} | | | | | |`,
    )
    .join('\n');

  const md = `# Readiness agent eval

Run ${new Date().toISOString().slice(0, 10)} with \`npm run eval -- --runs ${RUNS}\` · model \`${MODEL}\` (effort medium) · demo data as of ${asOf} · same loop, tools and prompt as the app (\`lib/agent/run.ts\`).

**Scenarios.** *fresh*: the demo data as loaded (one launch at risk). *a week later*: five tickets change (L1's blocker clears; L2 gets a blocked ticket, L3 an overdue one, L4 a reopened overdue regression, L5 a ticket due after go/no-go), so four launches are at risk for different reasons.

**How it's scored.** Each brief is checked against the data the agent read (\`lib/agent/verify.ts\`, the same check the app shows under every AI brief):
- *Same call*: the brief's GO / GO WITH CONDITIONS / NO-GO matches the rules engine's call for the same data.
- *Invented ids*: issue ids the brief cites that don't exist in the tracker.
- *Recall*: of the tickets behind at-risk gates (blocked, overdue, due after go/no-go), how many the brief cites. Gates with no ticket have nothing to cite and aren't counted.
- *Format*: exactly the four headings, in order.

## Summary

| Metric | Result |
| --- | --- |
${summary.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

## Per brief

| Scenario | Launch | Run | Call (rules) | Ids cited / invented | At-risk tickets missed | Format | Time | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${perBrief}

Cost uses list prices ($${PRICE_PER_MTOK.input} / $${PRICE_PER_MTOK.output} per million input / output tokens). Latency is wall-clock from the first request to the final brief, run ${CONCURRENCY} at a time.
`;
  writeFileSync('docs/EVAL.md', md);
  console.log('\nWrote docs/EVAL.md');
  if (ok.length < rows.length) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

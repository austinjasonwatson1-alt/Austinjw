/**
 * Loads live Linear data through the real adapter and compares readiness with the demo data.
 *   npm run check:linear
 * Exit code 1 if any launch's gate states differ (use before a demo).
 */
import { localToday } from '../lib/dates';
import { boardSummary, hygieneChecks, launchInfo } from '../lib/readiness';
import { demoSnapshot } from '../lib/tracker/demo';
import { linearSource } from '../lib/tracker/linear';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* rely on the shell environment */
}

async function main() {
  const asOf = localToday();
  const t0 = Date.now();
  const live = await linearSource.load(asOf);
  const ms = Date.now() - t0;
  const demo = demoSnapshot(asOf);
  console.log(`Linear: ${live.launches.length} launches, ${live.issues.length} issues, loaded in ${ms} ms\n`);
  let diffs = 0;
  for (const d of demo.launches) {
    const l = live.launches.find((x) => x.name === d.name);
    if (!l) {
      console.log(`✗ ${d.name}: missing in Linear`);
      diffs++;
      continue;
    }
    const a = launchInfo(d, demo.issues, asOf);
    const b = launchInfo(l, live.issues, asOf);
    const sig = (x: typeof a) => x.gates.map((g) => `${g.gate.key}:${g.state}`).join(' ');
    const same = sig(a) === sig(b) && a.launch.launchDate === b.launch.launchDate;
    if (!same) diffs++;
    console.log(`${same ? '✓' : '✗'} ${d.name}: ${b.risk} at risk, ${b.ready}/${b.n} ready, ${b.daysOut} days out${same ? '' : `\n    demo: ${sig(a)}\n    live: ${sig(b)}`}`);
  }
  console.log(`\nHeadline: ${boardSummary(live).headline}`);
  console.log(`Hygiene: ${hygieneChecks(live.issues, asOf).map((c) => `${c.name} ${c.items.length}`).join(' · ')}`);
  if (diffs) {
    console.log(`\n${diffs} launch(es) differ from the demo.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

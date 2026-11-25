/**
 * Creates the "Launch Control v1" project in Linear with one issue per PRD milestone (§7)
 * and per build launch gate (§8), so the build dogfoods its own gates.
 *
 *   npm run seed:build                 # dry run: prints the plan, writes nothing (no key needed)
 *   npm run seed:build -- --yes        # writes to Linear (needs LINEAR_API_KEY, LINEAR_TEAM_KEY)
 *
 * Idempotent: an existing project or issue with the same name/title is skipped, never edited.
 * If gate labels (group "Gate": eng, qa, docs, comms…) already exist, gate issues get them.
 *
 *   npm run seed:build -- --dogfood --yes
 *       # puts the build on Launch Control's own calendar: Tier 3 launch on the interview day
 *       # (Nov 30, so go/no-go = Nov 28, the PRD's demo-ready date), with you as lead and as
 *       # assignee of its tickets. Idempotent.
 */
import { LinearClient } from '@linear/sdk';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* no .env.local: rely on the shell environment */
}

const PROJECT = {
  name: 'Launch Control v1',
  description: 'Launch readiness board + AI go/no-go brief. Demo-ready Nov 28, frozen Nov 29 noon.',
  startDate: '2026-11-23',
  targetDate: '2026-11-28',
};

interface Planned {
  title: string;
  due: string;
  description: string;
  gate?: string;
}

const MILESTONES: Planned[] = [
  { title: 'M0 Setup', due: '2026-11-23', description: 'Done when: repo on GitHub, skeleton live on Vercel, build project + tickets created in Linear.' },
  { title: 'M1 UI parity on demo data', due: '2026-11-24', description: 'Done when: all prototype screens work in Next.js from the `demo` adapter; logic unit-tested.' },
  { title: 'M2 Readiness agent', due: '2026-11-24', description: 'Done when: `/api/brief` streams a real brief with tool trace; fallback works.' },
  { title: 'M3 Linear live', due: '2026-11-25', description: 'Done when: seed script run; toggle switches sources; scoring matches demo.' },
  { title: 'M4 Hygiene in Linear', due: '2026-11-28', description: 'Done when: proposed fixes + confirm-to-apply writes to Linear.' },
  { title: 'M5 Demo hardening', due: '2026-11-28', description: 'Done when: passcode, rate limit, error states, README with screenshot, rehearsal on prod URL.' },
  { title: 'Code freeze', due: '2026-11-29', description: 'No changes after Sun Nov 29, 12:00.' },
];

const GATES: Planned[] = [
  { title: 'Gate: Engineering complete', gate: 'eng', due: '2026-11-25', description: 'M0–M3 merged and deployed.' },
  { title: 'Gate: QA', gate: 'qa', due: '2026-11-28', description: 'Full demo script run 3× on the production URL with no errors, on the interview laptop.' },
  { title: 'Gate: Fallbacks verified', gate: 'qa', due: '2026-11-28', description: 'Linear key removed → demo banner; Claude key removed → rules brief.' },
  { title: 'Gate: Docs', gate: 'docs', due: '2026-11-28', description: 'README explains the problem, how it works, how to run locally.' },
  { title: 'Gate: Comms', gate: 'comms', due: '2026-11-29', description: '2-minute talk track rehearsed.' },
];

const PLAN = [...MILESTONES, ...GATES];

const DOGFOOD = { targetDate: '2026-11-30', description: 'Interview demo', tier: 'Tier 3' };

async function dogfood(linear: LinearClient, write: boolean) {
  const project = (await linear.projects({ filter: { name: { eq: PROJECT.name } } })).nodes[0];
  if (!project) throw new Error(`Run seed:build first: no project "${PROJECT.name}"`);
  const me = await linear.viewer;
  const tier = (await linear.projectLabels({ filter: { name: { eq: DOGFOOD.tier } } })).nodes[0];
  if (!tier) throw new Error(`No "${DOGFOOD.tier}" project label: run seed:linear first`);
  const labels = (await project.labels()).nodes.map((l) => l.id);
  const issues = (await project.issues({ first: 100 })).nodes;
  const unassigned = [];
  for (const i of issues) if (!(await i.assignee)) unassigned.push(i);
  const lead = await project.lead;
  console.log(`Dogfood "${project.name}": ${DOGFOOD.tier}, launches ${DOGFOOD.targetDate} (was ${project.targetDate}), lead ${me.name} (was ${lead?.name ?? 'none'}), assign ${unassigned.length} unassigned issue(s) to ${me.name}.`);
  if (!write) return console.log('Dry run: re-run with --dogfood --yes.');
  await linear.updateProject(project.id, {
    targetDate: DOGFOOD.targetDate,
    description: DOGFOOD.description,
    leadId: me.id,
    labelIds: [...new Set([...labels, tier.id])],
  });
  for (const i of unassigned) await linear.updateIssue(i.id, { assigneeId: me.id });
  console.log('Done.');
}

async function main() {
  const write = process.argv.includes('--yes');
  if (process.argv.includes('--dogfood')) {
    if (!process.env.LINEAR_API_KEY) throw new Error('LINEAR_API_KEY is not set');
    return dogfood(new LinearClient({ apiKey: process.env.LINEAR_API_KEY }), write);
  }
  const apiKey = process.env.LINEAR_API_KEY;
  const teamKey = process.env.LINEAR_TEAM_KEY || 'LCH';

  console.log(`Project "${PROJECT.name}" (target ${PROJECT.targetDate}) in team ${teamKey}, ${PLAN.length} issues:`);
  for (const p of PLAN) console.log(`  - ${p.title}  (due ${p.due}${p.gate ? `, label ${p.gate}` : ''})`);

  if (!apiKey) {
    console.log('\nDry run: LINEAR_API_KEY is not set, so nothing was read or written.');
    return;
  }
  const linear = new LinearClient({ apiKey });
  const team = (await linear.teams({ filter: { key: { eq: teamKey } } })).nodes[0];
  if (!team) throw new Error(`No Linear team with key ${teamKey}`);

  const existingProject = (await linear.projects({ filter: { name: { eq: PROJECT.name } } })).nodes[0];
  const existingTitles = new Set(
    existingProject ? (await existingProject.issues({ first: 100 })).nodes.map((i) => i.title) : [],
  );
  const gateLabels = new Map(
    (await linear.issueLabels({ filter: { parent: { name: { eq: 'Gate' } } }, first: 50 })).nodes.map((l) => [l.name, l.id]),
  );
  const todo = PLAN.filter((p) => !existingTitles.has(p.title));

  console.log(`\nTeam ${team.key} (${team.name}). Project ${existingProject ? 'exists, skipping' : 'will be created'}.`);
  console.log(`${todo.length} issue(s) to create, ${PLAN.length - todo.length} already exist.`);
  console.log(gateLabels.size ? `Gate labels found: ${[...gateLabels.keys()].join(', ')}` : 'No "Gate" label group found; gate issues get no label.');
  if (!write) {
    console.log('\nDry run: re-run with --yes to write these to Linear.');
    return;
  }

  let project: typeof existingProject | undefined = existingProject;
  if (!project) {
    const res = await linear.createProject({ ...PROJECT, teamIds: [team.id] });
    project = await res.project;
    if (!project) throw new Error('Linear did not return the created project');
    console.log(`Created project ${project.name}`);
  }
  for (const p of todo) {
    const labelId = p.gate ? gateLabels.get(p.gate) : undefined;
    const res = await linear.createIssue({
      teamId: team.id,
      projectId: project.id,
      title: p.title,
      description: p.description,
      dueDate: p.due,
      ...(labelId ? { labelIds: [labelId] } : {}),
    });
    const issue = await res.issue;
    console.log(`Created ${issue?.identifier ?? '?'} ${p.title}`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

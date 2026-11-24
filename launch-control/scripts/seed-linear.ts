/**
 * Seeds a Linear team with the demo org so live mode looks like the demo (PRD §4.8):
 * workflow states, Gate/Function/blocked labels, Tier project labels, 5 launch projects, 41 issues.
 *
 *   npm run seed:linear              # dry run: reads Linear, prints what it would create
 *   npm run seed:linear -- --yes     # writes (needs LINEAR_API_KEY, LINEAR_TEAM_KEY)
 *   npm run seed:linear -- --restore --yes
 *       # before a rehearsal: re-dates the 5 launch projects relative to today and puts each
 *       # seeded issue's owner line, due date and status back to the seed values (undoes hygiene
 *       # fixes and status changes). Run it on the morning of a demo. Nothing else is touched.
 *
 * Idempotent: anything with the same name/title already in the team is skipped, never edited.
 * Dates are placed relative to the day you run it, like the demo.
 */
import { LinearClient } from '@linear/sdk';
import { addDays, isIsoDate, localToday } from '../lib/dates';
import { DEMO_TEAM_LEADS, demoSnapshot } from '../lib/tracker/demo';
import {
  BLOCKED_LABEL,
  FUNCTION_GROUP,
  functionLabel,
  GATE_GROUP,
  GATE_KEYS,
  leadLine,
  ownerLine,
  projectDescription,
  STATE_FOR_STATUS,
  TEAMS,
  TIER_LABEL,
} from '../lib/tracker/linear-schema';
import type { Tier } from '../lib/tracker/types';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* rely on the shell environment */
}

const write = process.argv.includes('--yes');
const restore = process.argv.includes('--restore');
/** --as-of YYYY-MM-DD: place dates relative to another day (e.g. the morning of a demo). */
const asOfArg = process.argv.includes('--as-of') ? process.argv[process.argv.indexOf('--as-of') + 1] : undefined;
const apiKey = process.env.LINEAR_API_KEY;
const teamKey = process.env.LINEAR_TEAM_KEY || 'LCH';

interface Existing {
  team: { id: string; key: string; name: string };
  states: { id: string; name: string; type: string }[];
  labels: { id: string; name: string; parent: { name: string } | null }[];
  projectLabels: { id: string; name: string }[];
  projects: { id: string; name: string; targetDate?: string | null; description?: string | null }[];
  issueTitles: Set<string>;
  issues: { id: string; title: string; description: string | null; dueDate: string | null; state: { name: string } }[];
}

async function read(linear: LinearClient): Promise<Existing> {
  const gql = async <T>(query: string, vars: Record<string, unknown> = {}): Promise<T> => {
    const res: { data?: T } = await linear.client.rawRequest<T, Record<string, unknown>>(query, vars);
    if (!res.data) throw new Error('Empty response from Linear');
    return res.data;
  };
  const vars = { key: teamKey };
  const [t, l, p, i] = await Promise.all([
    gql<{ teams: { nodes: (Existing['team'] & { states: { nodes: Existing['states'] } })[] }; projectLabels: { nodes: Existing['projectLabels'] } }>(
      `query($key: String!) { teams(first: 1, filter: { key: { eq: $key } }) { nodes { id key name states(first: 30) { nodes { id name type } } } }
        projectLabels(first: 50) { nodes { id name } } }`,
      vars,
    ),
    gql<{ issueLabels: { nodes: Existing['labels'] } }>(
      `query($key: String!) { issueLabels(first: 100, filter: { team: { key: { eq: $key } } }) { nodes { id name parent { name } } } }`,
      vars,
    ),
    gql<{ projects: { nodes: Existing['projects'] } }>(
      `query($key: String!) { projects(first: 50, filter: { accessibleTeams: { some: { key: { eq: $key } } } }) { nodes { id name targetDate description } } }`,
      vars,
    ),
    gql<{ issues: { nodes: Existing['issues'] } }>(
      `query($key: String!) { issues(first: 250, filter: { team: { key: { eq: $key } } }) { nodes { id title description dueDate state { name } } } }`,
      vars,
    ),
  ]);
  const team = t.teams.nodes[0];
  if (!team) throw new Error(`No Linear team with key ${teamKey}`);
  return {
    team: { id: team.id, key: team.key, name: team.name },
    states: team.states.nodes,
    labels: l.issueLabels.nodes,
    projectLabels: t.projectLabels.nodes,
    projects: p.projects.nodes,
    issueTitles: new Set(i.issues.nodes.map((x) => x.title)),
    issues: i.issues.nodes,
  };
}

async function main() {
  if (asOfArg && !isIsoDate(asOfArg)) throw new Error('--as-of needs YYYY-MM-DD');
  const asOf = asOfArg ?? localToday();
  const demo = demoSnapshot(asOf);
  const tiers: Tier[] = [1, 2, 3];
  console.log(`Seed plan for team ${teamKey} (dates relative to ${asOf}):`);
  console.log(`  states: ${Object.values(STATE_FOR_STATUS).map((s) => s.name).join(', ')}`);
  console.log(`  labels: ${GATE_GROUP} (${GATE_KEYS.join(', ')}), ${FUNCTION_GROUP} (${TEAMS.map(functionLabel).join(', ')}), ${BLOCKED_LABEL}`);
  console.log(`  project labels: ${tiers.map(TIER_LABEL).join(', ')}`);
  console.log(`  projects: ${demo.launches.map((l) => `${l.name} (${l.launchDate})`).join('; ')}`);
  console.log(`  issues: ${demo.issues.length}`);
  if (!apiKey) return console.log('\nDry run: LINEAR_API_KEY is not set, so nothing was read or written.');

  const linear = new LinearClient({ apiKey });
  const ex = await read(linear);
  if (restore) return restoreSeeded(linear, ex, demo);
  const missing = {
    states: Object.values(STATE_FOR_STATUS).filter((s) => !ex.states.some((x) => x.name.toLowerCase() === s.name.toLowerCase())),
    projectLabels: tiers.map(TIER_LABEL).filter((n) => !ex.projectLabels.some((x) => x.name === n)),
    projects: demo.launches.filter((l) => !ex.projects.some((p) => p.name === l.name)),
    issues: demo.issues.filter((i) => !ex.issueTitles.has(i.title)),
  };
  console.log(`\nTeam ${ex.team.key}: to create ${missing.states.length} states, ${missing.projectLabels.length} project labels, ${missing.projects.length} projects, ${missing.issues.length} issues (labels checked as they're created).`);
  if (!write) return console.log('Dry run: re-run with --yes to write these to Linear.');

  // 1. Workflow states
  for (const s of missing.states) {
    const r = await linear.createWorkflowState({ teamId: ex.team.id, name: s.name, type: s.type, color: s.color });
    const st = await r.workflowState;
    if (st) ex.states.push({ id: st.id, name: st.name, type: s.type });
    console.log(`+ state ${s.name}`);
  }
  const stateId = (status: keyof typeof STATE_FOR_STATUS) => {
    const want = STATE_FOR_STATUS[status];
    return (ex.states.find((s) => s.name.toLowerCase() === want.name.toLowerCase()) ?? ex.states.find((s) => s.type === want.type))!.id;
  };

  // 2. Issue labels (team-scoped): groups, children, blocked
  const labelId = async (name: string, group?: string, description?: string, isGroup = false): Promise<string> => {
    const found = ex.labels.find((l) => l.name.toLowerCase() === name.toLowerCase() && (l.parent?.name ?? null) === (group ?? null));
    if (found) return found.id;
    const parentId = group ? await labelId(group, undefined, undefined, true) : undefined;
    const r = await linear.createIssueLabel({ teamId: ex.team.id, name, isGroup, parentId, description });
    const l = await r.issueLabel;
    if (!l) throw new Error(`Could not create label ${name}`);
    ex.labels.push({ id: l.id, name, parent: group ? { name: group } : null });
    console.log(`+ label ${group ? group + '/' : ''}${name}`);
    return l.id;
  };
  // Sequential on purpose: parallel creates race to create the parent group twice.
  const gateLabel: Record<string, string> = {};
  for (const g of GATE_KEYS) gateLabel[g] = await labelId(g, GATE_GROUP);
  const fnLabel: Record<string, string> = {};
  for (const t of TEAMS) {
    const lead = DEMO_TEAM_LEADS[t];
    fnLabel[t] = await labelId(functionLabel(t), FUNCTION_GROUP, lead ? leadLine(lead) : 'No default lead');
  }
  await labelId(BLOCKED_LABEL);

  // 3. Project labels (workspace-level)
  for (const n of missing.projectLabels) {
    const r = await linear.createProjectLabel({ name: n });
    const l = await r.projectLabel;
    if (l) ex.projectLabels.push({ id: l.id, name: n });
    console.log(`+ project label ${n}`);
  }
  const tierLabel = (t: Tier) => ex.projectLabels.find((l) => l.name === TIER_LABEL(t))!.id;

  // 4. Projects
  for (const l of missing.projects) {
    const r = await linear.createProject({
      name: l.name,
      teamIds: [ex.team.id],
      description: projectDescription(l.milestone, l.pm),
      targetDate: l.launchDate,
      labelIds: [tierLabel(l.tier)],
    });
    const p = await r.project;
    if (p) ex.projects.push({ id: p.id, name: p.name });
    console.log(`+ project ${l.name}`);
  }
  const projectId = (launchId: string) => {
    const name = demo.launches.find((l) => l.id === launchId)!.name;
    return ex.projects.find((p) => p.name === name)!.id;
  };

  // 5. Issues
  for (const i of missing.issues) {
    const labelIds = [i.gate ? gateLabel[i.gate] : null, i.team ? fnLabel[i.team] : null].filter((x): x is string => !!x);
    const r = await linear.createIssue({
      teamId: ex.team.id,
      title: i.title,
      description: i.owner ? ownerLine(i.owner) : undefined,
      projectId: i.launchId ? projectId(i.launchId) : undefined,
      stateId: stateId(i.status),
      dueDate: i.due ?? undefined,
      labelIds,
    });
    const created = await r.issue;
    console.log(`+ ${created?.identifier ?? '?'} ${i.title}`);
  }
  console.log(`Done. (${addDays(asOf, 0)})`);
}

/** Re-dates seeded projects and resets seeded issues (matched by name/title) to the seed, relative to today. */
async function restoreSeeded(linear: LinearClient, ex: Existing, demo: ReturnType<typeof demoSnapshot>) {
  const projectChanges = demo.launches.flatMap((l) => {
    const p = ex.projects.find((x) => x.name === l.name);
    const description = projectDescription(l.milestone, l.pm);
    if (!p || (p.targetDate === l.launchDate && (p.description ?? '') === description)) return [];
    return [{ p, l, description }];
  });
  console.log(`Restore: ${projectChanges.length} launch project(s) to re-date.`);
  for (const c of projectChanges) console.log(`  ~ ${c.l.name}: ${c.p.targetDate} → ${c.l.launchDate}`);

  const stateId = (status: keyof typeof STATE_FOR_STATUS) =>
    ex.states.find((s) => s.name.toLowerCase() === STATE_FOR_STATUS[status].name.toLowerCase())?.id;
  const changes = demo.issues.flatMap((d) => {
    const live = ex.issues.find((i) => i.title === d.title);
    if (!live) return [];
    const description = d.owner ? ownerLine(d.owner) : '';
    const want = { description, dueDate: d.due, state: STATE_FOR_STATUS[d.status].name };
    const same = (live.description ?? '') === want.description && (live.dueDate ?? null) === want.dueDate && live.state.name === want.state;
    return same ? [] : [{ live, d, want }];
  });
  console.log(`Restore: ${changes.length} seeded issue(s) differ from the seed.`);
  for (const c of changes) console.log(`  ~ ${c.d.title}`);
  if (!write) return console.log('Dry run: re-run with --restore --yes to reset them.');
  for (const c of projectChanges) {
    await linear.updateProject(c.p.id, { targetDate: c.l.launchDate, description: c.description });
    console.log(`~ re-dated ${c.l.name} → ${c.l.launchDate}`);
  }
  for (const c of changes) {
    await linear.updateIssue(c.live.id, { description: c.want.description, dueDate: c.want.dueDate, stateId: stateId(c.d.status) });
    console.log(`~ restored ${c.d.title}`);
  }
  console.log('Done. (Nudge comments stay on the issues; delete them in Linear if you want a clean slate.)');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

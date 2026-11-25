import { LinearClient } from '@linear/sdk';
import {
  FUNCTION_GROUP,
  GATE_GROUP,
  GATE_KEYS,
  parseLead,
  parseOwner,
  parseProjectDescription,
  statusFromLinear,
  teamFromFunctionLabel,
} from './linear-schema';
import type { GateKey, Issue, Launch, Tier, TrackerSnapshot, TrackerSource } from './types';

export const LINEAR_TIMEOUT_MS = 5_000;
const MAX_PAGES = 5; // 5 × 100 issues is plenty for a launch team

/* ---------- raw GraphQL shapes (only the fields we ask for) ---------- */
interface RawLabel {
  name: string;
  description?: string | null;
  parent?: { name: string } | null;
}
export interface RawProject {
  id: string;
  slugId: string;
  name: string;
  description?: string | null;
  targetDate?: string | null;
  lead?: { name: string } | null;
  labels: { nodes: { name: string }[] };
}
export interface RawIssue {
  identifier: string;
  title: string;
  url: string;
  description?: string | null;
  dueDate?: string | null;
  updatedAt: string;
  assignee?: { name: string } | null;
  state: { name: string; type: string };
  project?: { id: string } | null;
  labels: { nodes: RawLabel[] };
}
/** Everything the adapter reads, from three small queries (Linear caps query complexity). */
export interface RawData {
  projects: RawProject[];
  labels: RawLabel[];
  issues: RawIssue[];
}

const PROJECTS_QUERY = /* GraphQL */ `
  query LcProjects($key: String!) {
    projects(first: 50, filter: { accessibleTeams: { some: { key: { eq: $key } } } }) {
      nodes { id slugId name description targetDate lead { name } labels(first: 10) { nodes { name } } }
    }
  }
`;
const LABELS_QUERY = /* GraphQL */ `
  query LcLabels($key: String!) {
    issueLabels(first: 100, filter: { team: { key: { eq: $key } } }) { nodes { name description parent { name } } }
  }
`;
const ISSUES_QUERY = /* GraphQL */ `
  query LcIssues($key: String!, $after: String) {
    issues(first: 100, after: $after, filter: { team: { key: { eq: $key } } }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        identifier title url description dueDate updatedAt
        assignee { name }
        state { name type }
        project { id }
        labels(first: 10) { nodes { name parent { name } } }
      }
    }
  }
`;

const tierOf = (p: RawProject): Tier | null => {
  for (const l of p.labels.nodes) {
    const m = /^Tier\s*([123])$/i.exec(l.name.trim());
    if (m) return Number(m[1]) as Tier;
  }
  return null;
};

const childOf = (labels: RawLabel[], group: string) =>
  labels.find((l) => l.parent?.name.toLowerCase() === group.toLowerCase())?.name;

const safeUrl = (u: string) => (/^https:\/\/linear\.app\//.test(u) ? u : undefined);

/**
 * Pure mapping from Linear data to a snapshot (PRD §5).
 * - Launches: team projects with a `Tier N` label and a target date that hasn't passed
 *   (a shipped launch has no place on a calendar that runs from today).
 * - Issues: those in a launch project, plus those in no project (hygiene flags them as unlinked).
 *   Issues in other projects (e.g. the build project) and canceled/duplicate issues are left out.
 */
export function mapLinear({ projects, labels: teamLabels, issues }: RawData, asOf: string): TrackerSnapshot {
  const launches: Launch[] = [];
  for (const p of projects) {
    const tier = tierOf(p);
    if (!tier || !p.targetDate || p.targetDate.slice(0, 10) < asOf) continue;
    const d = parseProjectDescription(p.description);
    launches.push({
      id: p.slugId,
      name: p.name,
      milestone: d.milestone ?? 'Launch',
      tier,
      launchDate: p.targetDate.slice(0, 10),
      pm: p.lead?.name ?? d.pm,
    });
  }
  const launchByProject = new Map(projects.filter((p) => launches.some((l) => l.id === p.slugId)).map((p) => [p.id, p.slugId]));

  const out: Issue[] = [];
  for (const i of issues) {
    const labels = i.labels.nodes;
    const status = statusFromLinear(i.state, labels.map((l) => l.name));
    if (!status) continue;
    const launchId = i.project ? launchByProject.get(i.project.id) : null;
    if (launchId === undefined) continue; // in a project that isn't a launch
    const gate = childOf(labels, GATE_GROUP)?.toLowerCase();
    const team_ = childOf(labels, FUNCTION_GROUP);
    out.push({
      id: i.identifier,
      launchId,
      gate: GATE_KEYS.includes(gate as GateKey) ? (gate as GateKey) : null,
      title: i.title,
      team: teamFromFunctionLabel(team_),
      owner: i.assignee?.name ?? parseOwner(i.description),
      status,
      due: i.dueDate ? i.dueDate.slice(0, 10) : null,
      updatedAt: i.updatedAt.slice(0, 10),
      url: safeUrl(i.url),
    });
  }

  // Linear returns newest first; show issues in id order, like the demo.
  const num = (id: string) => Number(id.match(/(\d+)$/)?.[1] ?? 0);
  out.sort((a, b) => num(a.id) - num(b.id));

  const teamLeads: TrackerSnapshot['teamLeads'] = {};
  for (const l of teamLabels) {
    if (l.parent?.name.toLowerCase() !== FUNCTION_GROUP.toLowerCase()) continue;
    const t = teamFromFunctionLabel(l.name);
    if (t) teamLeads[t] = parseLead(l.description);
  }
  return { source: 'linear', asOf, launches, issues: out, teamLeads };
}

export const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('linear_timeout')), ms))]);

export function linearConfigured(): boolean {
  return Boolean(process.env.LINEAR_API_KEY && process.env.LINEAR_TEAM_KEY);
}

export const linearSource: TrackerSource = {
  kind: 'linear',
  async load(asOf) {
    const apiKey = process.env.LINEAR_API_KEY;
    const key = process.env.LINEAR_TEAM_KEY;
    if (!apiKey || !key) throw new Error('linear_not_configured');
    const client = new LinearClient({ apiKey });
    const gql = async <T>(query: string, vars: Record<string, unknown>): Promise<T> => {
      const res: { data?: T } = await client.client.rawRequest<T, Record<string, unknown>>(query, vars);
      if (!res.data) throw new Error('linear_empty_response');
      return res.data;
    };
    const allIssues = async () => {
      const out: RawIssue[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        type D = { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawIssue[] } };
        const d: D = await gql<D>(ISSUES_QUERY, { key, after });
        out.push(...d.issues.nodes);
        if (!d.issues.pageInfo.hasNextPage) break;
        after = d.issues.pageInfo.endCursor;
      }
      return out;
    };
    const run = async () => {
      const [p, l, issues] = await Promise.all([
        gql<{ projects: { nodes: RawProject[] } }>(PROJECTS_QUERY, { key }),
        gql<{ issueLabels: { nodes: RawLabel[] } }>(LABELS_QUERY, { key }),
        allIssues(),
      ]);
      return mapLinear({ projects: p.projects.nodes, labels: l.issueLabels.nodes, issues }, asOf);
    };
    return withTimeout(run(), LINEAR_TIMEOUT_MS);
  },
};

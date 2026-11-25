import { isIsoDate } from '../dates';
import type { GateKey, Issue, IssueStatus, Launch, Team, Tier, TrackerSnapshot } from './types';

/**
 * Validates a snapshot posted by the browser (demo mode sends its edited in-memory data
 * so the agent sees the same tickets as the screen). Untrusted input: strict shape,
 * bounded sizes, unknown fields dropped.
 */
const GATES: GateKey[] = ['prd', 'eng', 'qa', 'flag', 'sec', 'docs', 'enable', 'support', 'price', 'comms'];
const TEAMS: Team[] = ['R&D', 'QA', 'Docs', 'PMM', 'Support', 'Sales Eng', 'Security', 'PM'];
const STATUSES: IssueStatus[] = ['backlog', 'in_progress', 'in_review', 'done', 'blocked'];
const MAX_LAUNCHES = 50;
const MAX_ISSUES = 1000;
const MAX_STR = 300;

const str = (v: unknown, nullable = false): string | null => {
  if (nullable && v == null) return null;
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_STR) throw new Error('bad string');
  return v;
};
const oneOf = <T extends string>(v: unknown, set: readonly T[], nullable = false): T | null => {
  if (nullable && v == null) return null;
  if (!set.includes(v as T)) throw new Error('bad enum');
  return v as T;
};
const date = (v: unknown, nullable = false): string | null => {
  if (nullable && v == null) return null;
  if (!isIsoDate(v)) throw new Error('bad date');
  return v;
};

const tier = (v: unknown): Tier => {
  if (v !== 1 && v !== 2 && v !== 3) throw new Error('bad tier');
  return v;
};

export function parseSnapshot(raw: unknown): TrackerSnapshot | null {
  try {
    const r = raw as Record<string, unknown>;
    if (!r || !Array.isArray(r.launches) || !Array.isArray(r.issues)) return null;
    if (r.launches.length > MAX_LAUNCHES || r.issues.length > MAX_ISSUES) return null;
    const launches: Launch[] = r.launches.map((l: Record<string, unknown>) => ({
      id: str(l.id)!,
      name: str(l.name)!,
      milestone: str(l.milestone)!,
      tier: tier(l.tier),
      launchDate: date(l.launchDate)!,
      pm: str(l.pm, true),
      ...(l.summary == null ? {} : { summary: str(l.summary)! }),
    }));
    const issues: Issue[] = r.issues.map((i: Record<string, unknown>) => ({
      id: str(i.id)!,
      launchId: str(i.launchId, true),
      gate: oneOf(i.gate, GATES, true),
      title: str(i.title)!,
      team: oneOf(i.team, TEAMS, true),
      owner: str(i.owner, true),
      status: oneOf(i.status, STATUSES)!,
      due: date(i.due, true),
      updatedAt: date(String(i.updatedAt ?? '').slice(0, 10))!,
    }));
    const leads: TrackerSnapshot['teamLeads'] = {};
    const rl = (r.teamLeads ?? {}) as Record<string, unknown>;
    for (const t of TEAMS) if (t in rl) leads[t] = str(rl[t], true);
    return { source: 'demo', asOf: date(r.asOf)!, launches, issues, teamLeads: leads };
  } catch {
    return null;
  }
}

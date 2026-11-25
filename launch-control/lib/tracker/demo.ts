import { addDays } from '../dates';
import type { GateKey, Issue, IssueStatus, Launch, Team, TrackerSnapshot, TrackerSource, Tier } from './types';

/* Ported verbatim from prototype/index.html. Offsets are days from "today". */

const LAUNCHES: { id: string; name: string; ms: string; tier: Tier; d: number; pm: string }[] = [
  { id: 'L1', name: 'L1 Triage Agent', ms: 'General availability', tier: 1, d: 16, pm: 'Maya Chen' },
  { id: 'L2', name: 'Change Risk Insights', ms: 'Early access', tier: 1, d: 23, pm: 'Jordan Ellis' },
  { id: 'L3', name: 'Knowledge Graph API v2', ms: 'General availability', tier: 2, d: 9, pm: 'Priya Raman' },
  { id: 'L4', name: 'ServiceNow connector 3.1', ms: 'Minor release', tier: 3, d: 4, pm: 'Sam Ortiz' },
  { id: 'L5', name: 'Incident timeline refresh', ms: 'Minor release', tier: 3, d: 30, pm: 'Maya Chen' },
];

export const DEMO_TEAM_LEADS: Record<Team, string | null> = {
  'R&D': 'Dana Kim',
  QA: 'Tom Alvarez',
  Docs: 'Erin Walsh',
  PMM: 'Nia Brooks',
  Support: 'Kara Singh',
  'Sales Eng': 'Marcus Hill',
  Security: 'Rachel Ng',
  PM: null,
};

type S = 'B' | 'P' | 'R' | 'D' | 'X';
const STATUS: Record<S, IssueStatus> = { B: 'backlog', P: 'in_progress', R: 'in_review', D: 'done', X: 'blocked' };

/* id, launch, gate, title, team, owner, status, due (days from today), days since update */
type Row = [string, string | null, GateKey | null, string, Team, string | null, S, number | null, number];
export const DEMO_ISSUE_ROWS: Row[] = [
  ['LCH-101', 'L1', 'prd', 'Finalize GA scope and success metrics', 'PM', 'Maya Chen', 'D', -10, 6],
  ['LCH-114', 'L1', 'eng', 'Runbook executor for auto-remediation', 'R&D', 'Lior Ben-Ami', 'R', 5, 1],
  ['LCH-117', 'L1', 'eng', 'Tenant-level rate limits for agent actions', 'R&D', 'Dana Kim', 'P', 8, 2],
  ['LCH-121', 'L1', 'eng', 'Fix duplicate incident merge on retry', 'R&D', null, 'B', 10, 4],
  ['LCH-126', 'L1', 'qa', 'Load test at 50k events per minute', 'QA', 'Tom Alvarez', 'X', 6, 3],
  ['LCH-127', 'L1', 'qa', 'Regression suite for triage rules', 'QA', 'Tom Alvarez', 'P', 9, 2],
  ['LCH-130', 'L1', 'flag', 'Rollout plan: 10% to 50% to 100% by cohort', 'PM', 'Maya Chen', 'D', -3, 5],
  ['LCH-133', 'L1', 'sec', 'Security review of agent action permissions', 'Security', 'Rachel Ng', 'P', -2, 9],
  ['LCH-138', 'L1', 'docs', 'GA docs: setup, guardrails, audit log', 'Docs', 'Erin Walsh', 'P', 12, 1],
  ['LCH-139', 'L1', 'docs', 'Release notes draft', 'Docs', null, 'B', null, 16],
  ['LCH-142', 'L1', 'enable', 'SE demo environment with sample incidents', 'Sales Eng', 'Marcus Hill', 'P', 10, 3],
  ['LCH-143', 'L1', 'enable', 'Battlecard vs. native ITSM agents', 'PMM', 'Nia Brooks', 'B', 11, 7],
  ['LCH-147', 'L1', 'price', 'Packaging: agent add-on SKU', 'PMM', 'Nia Brooks', 'D', -6, 8],
  ['LCH-150', 'L1', 'comms', 'Customer announcement and in-app message', 'PMM', 'Nia Brooks', 'B', 14, 5],
  ['LCH-201', 'L2', 'prd', 'EA scope and design-partner criteria', 'PM', 'Jordan Ellis', 'D', -12, 10],
  ['LCH-205', 'L2', 'eng', 'Change ingestion from CI/CD webhooks', 'R&D', 'Omar Haddad', 'P', 12, 1],
  ['LCH-206', 'L2', 'eng', 'Risk score model v1', 'R&D', 'Lior Ben-Ami', 'R', 9, 2],
  ['LCH-210', 'L2', 'qa', 'EA acceptance tests', 'QA', 'Tom Alvarez', 'B', 18, 6],
  ['LCH-212', 'L2', 'flag', 'EA allowlist for 8 design partners', 'PM', 'Jordan Ellis', 'D', -2, 3],
  ['LCH-214', 'L2', 'sec', 'Data protection review for change data', 'Security', 'Rachel Ng', 'D', -4, 4],
  ['LCH-217', 'L2', 'docs', 'EA guide for design partners', 'Docs', 'Erin Walsh', 'B', 19, 3],
  ['LCH-219', 'L2', 'enable', 'EA talk track for CSMs', 'PMM', 'Nia Brooks', 'P', 15, 2],
  ['LCH-221', 'L2', 'support', 'Support triage path for EA tickets', 'Support', 'Kara Singh', 'D', -1, 1],
  ['LCH-223', 'L2', 'price', 'EA pricing decision (free during EA)', 'PMM', 'Nia Brooks', 'D', -8, 12],
  ['LCH-225', 'L2', 'comms', 'Design-partner invite emails', 'PM', 'Jordan Ellis', 'P', 7, 1],
  ['LCH-301', 'L3', 'prd', 'v2 scope and deprecation policy', 'PM', 'Priya Raman', 'D', -15, 15],
  ['LCH-304', 'L3', 'eng', 'Paginate the topology endpoint', 'R&D', 'Omar Haddad', 'D', -1, 1],
  ['LCH-305', 'L3', 'eng', 'Deprecate v1 fields with sunset headers', 'R&D', 'Omar Haddad', 'R', 3, 1],
  ['LCH-308', 'L3', 'qa', 'Contract tests for the v2 schema', 'QA', 'Ivy Park', 'P', 5, 2],
  ['LCH-310', 'L3', 'flag', 'Gradual rollout by API key', 'PM', 'Priya Raman', 'D', -5, 5],
  ['LCH-312', 'L3', 'docs', 'API reference v2 and migration guide', 'Docs', 'Erin Walsh', 'P', 6, 18],
  ['LCH-315', 'L3', 'support', 'Support macro for v1 to v2 questions', 'Support', 'Kara Singh', 'D', -2, 2],
  ['LCH-317', 'L3', 'comms', 'Developer changelog post', 'PMM', 'Nia Brooks', 'B', 7, 4],
  ['LCH-401', 'L4', 'eng', 'Two-way sync for work notes', 'R&D', 'Dana Kim', 'D', -3, 3],
  ['LCH-403', 'L4', 'qa', 'Regression on supported ServiceNow versions', 'QA', 'Ivy Park', 'D', -1, 1],
  ['LCH-405', 'L4', 'docs', 'Release notes 3.1', 'Docs', 'Erin Walsh', 'D', 0, 0],
  ['LCH-501', 'L5', 'eng', 'Timeline zoom and grouping', 'R&D', 'Ben Osei', 'P', 20, 2],
  ['LCH-503', 'L5', 'qa', 'Visual regression snapshots', 'QA', 'Ivy Park', 'B', 24, 9],
  ['LCH-505', 'L5', 'docs', 'Help center update', 'Docs', null, 'B', null, 21],
  ['LCH-610', null, null, 'Investigate flaky webhook test', 'R&D', 'Dana Kim', 'P', 3, 4],
  ['LCH-612', null, null, 'Customer ask: export briefs to PDF', 'PM', null, 'B', null, 30],
];

/** The prototype's sample org, with every date placed relative to `asOf`. */
export function demoSnapshot(asOf: string): TrackerSnapshot {
  const launches: Launch[] = LAUNCHES.map((l) => ({
    id: l.id,
    name: l.name,
    milestone: l.ms,
    tier: l.tier,
    launchDate: addDays(asOf, l.d),
    pm: l.pm,
  }));
  const issues: Issue[] = DEMO_ISSUE_ROWS.map(([id, launchId, gate, title, team, owner, s, due, upd]) => ({
    id,
    launchId,
    gate,
    title,
    team,
    owner,
    status: STATUS[s],
    due: due == null ? null : addDays(asOf, due),
    updatedAt: addDays(asOf, -upd),
  }));
  return { source: 'demo', asOf, launches, issues, teamLeads: { ...DEMO_TEAM_LEADS } };
}

export const demoSource: TrackerSource = {
  kind: 'demo',
  load: async (asOf) => demoSnapshot(asOf),
};

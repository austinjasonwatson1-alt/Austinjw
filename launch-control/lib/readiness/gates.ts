import { addDays, daysBetween } from '../dates';
import type { GateKey, Issue, IssueStatus, Launch, Tier } from '../tracker/types';

export interface GateDef {
  key: GateKey;
  name: string;
  tiers: Tier[];
}

/** Readiness gates scaled by tier: Tier 1 → 10, Tier 2 → 7, Tier 3 → 3. */
export const GATES: GateDef[] = [
  { key: 'prd', name: 'PRD and scope signed off', tiers: [1, 2] },
  { key: 'eng', name: 'Engineering complete', tiers: [1, 2, 3] },
  { key: 'qa', name: 'QA and performance sign-off', tiers: [1, 2, 3] },
  { key: 'flag', name: 'Feature flag and rollout plan', tiers: [1, 2] },
  { key: 'sec', name: 'Security and legal review', tiers: [1] },
  { key: 'docs', name: 'Docs and release notes', tiers: [1, 2, 3] },
  { key: 'enable', name: 'Sales and SE enablement', tiers: [1] },
  { key: 'support', name: 'Support runbook and training', tiers: [1, 2] },
  { key: 'price', name: 'Pricing and packaging', tiers: [1] },
  { key: 'comms', name: 'Customer comms', tiers: [1, 2] },
];

export const gateName = (key: GateKey | null): string | undefined => GATES.find((g) => g.key === key)?.name;

/** Go/no-go happens this many days before the launch date. */
export const GO_NO_GO_LEAD_DAYS = 2;

export type GateState = 'ready' | 'prog' | 'risk';

export const STATE_LABEL: Record<GateState, string> = { ready: 'Ready', prog: 'On track', risk: 'At risk' };
export const GATE_STATUS_LABEL: Record<GateState, string> = { ready: 'Ready', prog: 'In progress', risk: 'At risk' };

export const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  blocked: 'Blocked',
};

/** The demo's status pill cycle: Backlog → In progress → In review → Done → Blocked → Backlog. */
export const NEXT_STATUS: Record<IssueStatus, IssueStatus> = {
  backlog: 'in_progress',
  in_progress: 'in_review',
  in_review: 'done',
  done: 'blocked',
  blocked: 'backlog',
};

export interface GateInfo {
  gate: GateDef;
  issues: Issue[];
  done: number;
  state: GateState;
  why: string;
}

export interface LaunchInfo {
  launch: Launch;
  gates: GateInfo[];
  risk: number;
  ready: number;
  n: number;
  state: GateState;
  daysOut: number;
  goNoGo: string;
}

export const goNoGoDate = (launch: Launch): string => addDays(launch.launchDate, -GO_NO_GO_LEAD_DAYS);

export const isOverdue = (i: Issue, asOf: string): boolean => i.status !== 'done' && i.due != null && i.due < asOf;

/**
 * A gate is at risk if it has no ticket, or any open ticket is blocked, overdue,
 * or due after go/no-go. Ready when every ticket is done. Otherwise in progress.
 * Reasons are checked in that order, so the first one found is the one reported.
 */
export function gateInfo(launch: Launch, gate: GateDef, issues: Issue[], asOf: string): GateInfo {
  const its = issues.filter((i) => i.launchId === launch.id && i.gate === gate.key);
  const done = its.filter((i) => i.status === 'done').length;
  const open = its.filter((i) => i.status !== 'done');
  const cutoff = goNoGoDate(launch);
  let state: GateState;
  let why: string;
  if (!its.length) [state, why] = ['risk', 'No ticket exists'];
  else if (!open.length) [state, why] = ['ready', 'Done'];
  else if (open.some((i) => i.status === 'blocked')) [state, why] = ['risk', 'Blocked'];
  else if (open.some((i) => isOverdue(i, asOf))) [state, why] = ['risk', 'Overdue'];
  else if (open.some((i) => i.due != null && i.due > cutoff)) [state, why] = ['risk', 'Due after go/no-go'];
  else [state, why] = ['prog', `${open.length} open`];
  return { gate, issues: its, done, state, why };
}

export function launchInfo(launch: Launch, issues: Issue[], asOf: string): LaunchInfo {
  const gates = GATES.filter((g) => g.tiers.includes(launch.tier)).map((g) => gateInfo(launch, g, issues, asOf));
  const risk = gates.filter((g) => g.state === 'risk').length;
  const ready = gates.filter((g) => g.state === 'ready').length;
  const state: GateState = risk ? 'risk' : ready === gates.length ? 'ready' : 'prog';
  return {
    launch,
    gates,
    risk,
    ready,
    n: gates.length,
    state,
    daysOut: daysBetween(asOf, launch.launchDate),
    goNoGo: goNoGoDate(launch),
  };
}

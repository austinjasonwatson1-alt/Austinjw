/**
 * The Launch Control ↔ Linear mapping (PRD §5), in one place.
 * Both scripts/seed-linear.ts (writes) and lib/tracker/linear.ts (reads) use it.
 */
import type { GateKey, IssueStatus, Team, Tier } from './types';

export const GATE_GROUP = 'Gate';
export const FUNCTION_GROUP = 'Function';
export const BLOCKED_LABEL = 'blocked';
export const TIER_LABEL = (t: Tier) => `Tier ${t}`;
export const GATE_KEYS: GateKey[] = ['prd', 'eng', 'qa', 'flag', 'sec', 'docs', 'enable', 'support', 'price', 'comms'];
export const TEAMS: Team[] = ['R&D', 'QA', 'Docs', 'PMM', 'Support', 'Sales Eng', 'Security', 'PM'];

/**
 * Function label name per team. Linear label names are unique per team ignoring case,
 * so teams whose names match a gate (QA, Docs, Support) get a " team" suffix.
 */
const FUNCTION_LABEL_OVERRIDES: Partial<Record<Team, string>> = { QA: 'QA team', Docs: 'Docs team', Support: 'Support team' };
export const functionLabel = (t: Team): string => FUNCTION_LABEL_OVERRIDES[t] ?? t;
export const teamFromFunctionLabel = (name?: string | null): Team | null =>
  name ? (TEAMS.find((t) => functionLabel(t).toLowerCase() === name.toLowerCase()) ?? null) : null;

/** Workflow states the seed makes sure exist, and the Launch Control status each one means. */
export const STATE_FOR_STATUS: Record<IssueStatus, { name: string; type: string; color: string }> = {
  backlog: { name: 'Backlog', type: 'backlog', color: '#bec2c8' },
  in_progress: { name: 'In Progress', type: 'started', color: '#f2c94c' },
  in_review: { name: 'In Review', type: 'started', color: '#8fd3ff' },
  done: { name: 'Done', type: 'completed', color: '#5e6ad2' },
  blocked: { name: 'Blocked', type: 'started', color: '#ff5c8a' },
};

/**
 * Linear state → status. "Blocked" is a state named Blocked or a `blocked` label (PRD §5).
 * Canceled and duplicate issues return null and are left out entirely.
 */
export function statusFromLinear(state: { name: string; type: string }, labelNames: string[]): IssueStatus | null {
  if (state.type === 'canceled' || state.type === 'duplicate') return null;
  if (/^blocked$/i.test(state.name) || labelNames.some((n) => n.toLowerCase() === BLOCKED_LABEL)) return 'blocked';
  if (state.type === 'completed') return 'done';
  if (state.type === 'started') return /review/i.test(state.name) ? 'in_review' : 'in_progress';
  return 'backlog';
}

/*
 * People in the sample org aren't members of the Linear workspace, so they can't be assignees.
 * They are written as plain-text lines instead, and a real assignee/lead always wins.
 */
const line = (key: string) => new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'im');
export const ownerLine = (name: string) => `Owner: ${name}`;
export const parseOwner = (description?: string | null) => description?.match(line('Owner'))?.[1] ?? null;
export const leadLine = (name: string) => `Lead: ${name}`;
export const parseLead = (description?: string | null) => description?.match(line('Lead'))?.[1] ?? null;

/** Project description: "<milestone> · PM: <name>". Milestone is the first segment (PRD §5). */
export const projectDescription = (milestone: string, pm: string | null) => (pm ? `${milestone} · PM: ${pm}` : milestone);
export function parseProjectDescription(description?: string | null): { milestone: string | null; pm: string | null } {
  const text = (description ?? '').trim();
  if (!text) return { milestone: null, pm: null };
  const parts = text.split(/\n| · /).map((s) => s.trim());
  const pm = parts.find((p) => /^PM:/i.test(p))?.replace(/^PM:\s*/i, '') || null;
  const first = parts[0] && !/^PM:/i.test(parts[0]) ? parts[0] : null;
  return { milestone: first, pm };
}

/** Sets (or replaces) the `Owner:` line in an issue description, keeping everything else. */
export function setOwnerLine(description: string | null | undefined, name: string): string {
  const text = description ?? '';
  if (line('Owner').test(text)) return text.replace(line('Owner'), ownerLine(name));
  return text.trim() ? `${ownerLine(name)}\n\n${text}` : ownerLine(name);
}

/** Comment posted when hygiene nudges the owner of a stale ticket. */
export const nudgeComment = (owner: string, staleDays: number, goNoGoLabel?: string) =>
  `Nudge from Launch Control: ${owner}, this ticket has had no update in ${staleDays} days.` +
  (goNoGoLabel ? ` Can you post a status before go/no-go on ${goNoGoLabel}?` : ' Can you post a status?');

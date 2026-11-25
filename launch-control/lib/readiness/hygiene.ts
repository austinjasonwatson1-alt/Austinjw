import { addDays, daysBetween, fmtDate } from '../dates';
import type { Issue, TrackerSnapshot } from '../tracker/types';

export type HygieneKey = 'owner' | 'due' | 'stale' | 'link';

export interface HygieneCheck {
  key: HygieneKey;
  name: string;
  fix: string;
  items: Issue[];
}

export const STALE_DAYS = 14;
/** Estimates shown in "Manual work removed" (labeled as estimates in the UI). */
export const MINUTES_PER_SWEEP = 45;
export const MINUTES_PER_FIX = 3;

export const daysSinceUpdate = (i: Issue, asOf: string): number => daysBetween(i.updatedAt, asOf);

export function hygieneChecks(issues: Issue[], asOf: string): HygieneCheck[] {
  const open = issues.filter((i) => i.status !== 'done');
  return [
    { key: 'owner', name: 'No owner', fix: 'Auto-fix assigns the team lead', items: open.filter((i) => !i.owner) },
    {
      key: 'due',
      name: 'No due date',
      fix: 'Auto-fix sets it 4 days before launch',
      items: open.filter((i) => i.due == null && i.launchId),
    },
    {
      key: 'stale',
      name: `No update in ${STALE_DAYS}+ days`,
      fix: 'Auto-fix nudges the owner',
      items: open.filter((i) => daysSinceUpdate(i, asOf) >= STALE_DAYS),
    },
    {
      key: 'link',
      name: 'Not linked to a launch',
      fix: 'Judgment call, routed to a human',
      items: issues.filter((i) => !i.launchId),
    },
  ];
}

/** Share of all tickets (open or done) that fail no hygiene check, 0–100. */
export function cleanScore(issues: Issue[], asOf: string): number {
  if (!issues.length) return 100;
  const bad = new Set<string>();
  hygieneChecks(issues, asOf).forEach((c) => c.items.forEach((i) => bad.add(i.id)));
  return Math.round(((issues.length - bad.size) / issues.length) * 100);
}

export interface FixAction {
  text: string;
  minutes: number;
}

export type FixKind = 'owner' | 'due' | 'nudge';

/** One safe change to one issue. `id` is deterministic so a client can pick fixes by id. */
export interface ProposedFix {
  id: string;
  kind: FixKind;
  issueId: string;
  /** Log line, e.g. "Assigned LCH-121 to Dana Kim (R&D lead)" */
  text: string;
  owner?: string;
  due?: string;
  /** For nudges: days since the last update, and the launch's go/no-go date if linked. */
  staleDays?: number;
  goNoGo?: string;
}

/**
 * The safe fixes: assign the team lead, set a due date 4 days before launch (at least
 * tomorrow), nudge the owner of a stale ticket. Evaluated per issue in that order, so a
 * ticket that just got an owner also gets its nudge. Unlinked tickets are left for a human.
 */
export function proposeFixes(snap: Pick<TrackerSnapshot, 'issues' | 'launches' | 'teamLeads' | 'asOf'>): {
  fixes: ProposedFix[];
  unlinked: number;
} {
  const { asOf } = snap;
  const fixes: ProposedFix[] = [];
  for (const i of snap.issues) {
    if (i.status === 'done') continue;
    let owner = i.owner;
    const lead = i.team ? snap.teamLeads[i.team] : null;
    if (!owner && lead) {
      owner = lead;
      fixes.push({ id: `owner:${i.id}`, kind: 'owner', issueId: i.id, owner, text: `Assigned ${i.id} to ${owner} (${i.team} lead)` });
    }
    const launch = i.launchId ? snap.launches.find((l) => l.id === i.launchId) : undefined;
    if (i.due == null && launch) {
      const due = addDays(asOf, Math.max(1, daysBetween(asOf, launch.launchDate) - 4));
      fixes.push({ id: `due:${i.id}`, kind: 'due', issueId: i.id, due, text: `Set ${i.id} due ${fmtDate(due)}, 4 days before launch` });
    }
    const stale = daysSinceUpdate(i, asOf);
    if (stale >= STALE_DAYS && owner) {
      fixes.push({
        id: `nudge:${i.id}`,
        kind: 'nudge',
        issueId: i.id,
        owner,
        staleDays: stale,
        goNoGo: launch ? addDays(launch.launchDate, -2) : undefined,
        text: `Nudged ${owner} for an update on ${i.id}`,
      });
    }
  }
  return { fixes, unlinked: snap.issues.filter((i) => !i.launchId).length };
}

/** Applies fixes to in-memory issues (demo mode). Pure. */
export function applyFixesLocally(issues: Issue[], fixes: ProposedFix[], asOf: string): Issue[] {
  const byIssue = new Map<string, ProposedFix[]>();
  fixes.forEach((f) => byIssue.set(f.issueId, [...(byIssue.get(f.issueId) ?? []), f]));
  return issues.map((orig) => {
    const fs = byIssue.get(orig.id);
    if (!fs) return orig;
    const i = { ...orig };
    for (const f of fs) {
      if (f.kind === 'owner') i.owner = f.owner!;
      if (f.kind === 'due') i.due = f.due!;
      if (f.kind === 'nudge') i.updatedAt = asOf;
    }
    return i;
  });
}

export const unlinkedNote = (n: number): FixAction | null =>
  n ? { text: `Left ${n} unlinked ticket${n > 1 ? 's' : ''} for a human to triage`, minutes: 0 } : null;

/** Demo auto-fix: propose, apply locally, and log what it did. */
export function autofix(snap: Pick<TrackerSnapshot, 'issues' | 'launches' | 'teamLeads' | 'asOf'>): {
  issues: Issue[];
  actions: FixAction[];
} {
  const { fixes, unlinked } = proposeFixes(snap);
  const actions: FixAction[] = fixes.map((f) => ({ text: f.text, minutes: MINUTES_PER_FIX }));
  const note = unlinkedNote(unlinked);
  if (note) actions.push(note);
  if (!fixes.length && !unlinked) actions.push({ text: 'Nothing to fix. Tracker is clean.', minutes: 0 });
  return { issues: applyFixesLocally(snap.issues, fixes, snap.asOf), actions };
}

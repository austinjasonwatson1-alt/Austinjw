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

/**
 * Applies the safe fixes (demo mode): assign the team lead, set a due date
 * 4 days before launch, nudge stale owners. Unlinked tickets are left for a human.
 * Pure: returns new issues plus the log of what it did.
 */
export function autofix(snap: Pick<TrackerSnapshot, 'issues' | 'launches' | 'teamLeads' | 'asOf'>): {
  issues: Issue[];
  actions: FixAction[];
} {
  const { asOf } = snap;
  const actions: FixAction[] = [];
  let n = 0;
  const issues = snap.issues.map((orig) => {
    if (orig.status === 'done') return orig;
    const i = { ...orig };
    const lead = i.team ? snap.teamLeads[i.team] : null;
    if (!i.owner && lead) {
      i.owner = lead;
      actions.push({ text: `Assigned ${i.id} to ${i.owner} (${i.team} lead)`, minutes: MINUTES_PER_FIX });
      n++;
    }
    const launch = i.launchId ? snap.launches.find((l) => l.id === i.launchId) : undefined;
    if (i.due == null && launch) {
      i.due = addDays(asOf, Math.max(1, daysBetween(asOf, launch.launchDate) - 4));
      actions.push({ text: `Set ${i.id} due ${fmtDate(i.due)}, 4 days before launch`, minutes: MINUTES_PER_FIX });
      n++;
    }
    if (daysSinceUpdate(i, asOf) >= STALE_DAYS && i.owner) {
      i.updatedAt = asOf;
      actions.push({ text: `Nudged ${i.owner} for an update on ${i.id}`, minutes: MINUTES_PER_FIX });
      n++;
    }
    return i;
  });
  const left = issues.filter((i) => !i.launchId).length;
  if (left) actions.push({ text: `Left ${left} unlinked ticket${left > 1 ? 's' : ''} for a human to triage`, minutes: 0 });
  if (!n && !left) actions.push({ text: 'Nothing to fix. Tracker is clean.', minutes: 0 });
  return { issues, actions };
}

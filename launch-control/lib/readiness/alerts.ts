import { fmtDate } from '../dates';
import type { Issue, Launch, TrackerSnapshot } from '../tracker/types';
import { isOverdue, launchInfo } from './gates';

export type AlertReason = 'blocked' | 'overdue' | 'late';

/** One message to the owner of one at-risk ticket. `id` is deterministic so a client can pick alerts by id. */
export interface RiskAlert {
  id: string;
  issueId: string;
  reason: AlertReason;
  /** Who the message is addressed to: the owner, or the team lead / PM when the ticket has none. */
  to: string;
  toIsOwner: boolean;
  gate: string;
  /** One line for the review list, e.g. "Tom Alvarez · LCH-126 blocked" */
  summary: string;
  /** For the work log, e.g. "Tom Alvarez about LCH-126 (blocked)" */
  logText: string;
  /** The message itself, posted as a comment on the ticket. */
  message: string;
}

/** Every alert posted to a tracker starts with this, so repeats can be detected. */
export const ALERT_MARKER = 'Risk alert from Launch Control';

const REASON_LABEL: Record<AlertReason, string> = { blocked: 'blocked', overdue: 'overdue', late: 'due after go/no-go' };

function reasonFor(i: Issue, asOf: string, goNoGo: string): AlertReason | null {
  if (i.status === 'done') return null;
  if (i.status === 'blocked') return 'blocked';
  if (isOverdue(i, asOf)) return 'overdue';
  if (i.due != null && i.due > goNoGo) return 'late';
  return null;
}

/**
 * Alerts for one launch: every open ticket that puts a gate at risk (blocked, overdue, or due
 * after go/no-go) gets one message to its owner. Unowned tickets go to the team lead, then the PM.
 * Gates with no ticket have nobody to message and are returned separately.
 */
export function proposeAlerts(
  snap: Pick<TrackerSnapshot, 'issues' | 'asOf' | 'teamLeads'>,
  launch: Launch,
): { alerts: RiskAlert[]; noTicketGates: string[] } {
  const x = launchInfo(launch, snap.issues, snap.asOf);
  const go = fmtDate(x.goNoGo);
  const alerts: RiskAlert[] = [];
  const noTicketGates: string[] = [];
  for (const g of x.gates) {
    if (g.state !== 'risk') continue;
    if (!g.issues.length) {
      noTicketGates.push(g.gate.name);
      continue;
    }
    for (const i of g.issues) {
      const reason = reasonFor(i, snap.asOf, x.goNoGo);
      if (!reason) continue;
      const lead = i.team ? snap.teamLeads[i.team] : null;
      const to = i.owner ?? lead ?? launch.pm;
      if (!to) continue;
      const toIsOwner = Boolean(i.owner);
      const who = toIsOwner ? to : `${to} (no owner yet, so this goes to the ${lead ? `${i.team} lead` : 'launch PM'})`;
      const what = `${i.id} ("${i.title}")`;
      const ask =
        reason === 'blocked'
          ? `It's blocked. What's needed to unblock it, and from whom?`
          : reason === 'overdue'
            ? `It was due ${fmtDate(i.due!)} and is still open. Can you post a new committed date?`
            : `It's due ${fmtDate(i.due!)}, after the ${go} go/no-go. Can it land by ${go}, or should we plan around it?`;
      alerts.push({
        id: `alert:${i.id}`,
        issueId: i.id,
        reason,
        to,
        toIsOwner,
        gate: g.gate.name,
        summary: `${to} · ${i.id} ${REASON_LABEL[reason]}`,
        logText: `${to} about ${i.id} (${REASON_LABEL[reason]})`,
        message: `${ALERT_MARKER}: ${who}, ${what} puts the "${g.gate.name}" gate for ${launch.name} at risk. ${ask} Go/no-go is ${go}.`,
      });
    }
  }
  return { alerts, noTicketGates };
}

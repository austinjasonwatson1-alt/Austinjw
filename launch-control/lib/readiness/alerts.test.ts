import { describe, expect, it } from 'vitest';
import { addDays } from '../dates';
import { demoSnapshot } from '../tracker/demo';
import { ALERT_MARKER, proposeAlerts } from './alerts';

const AS_OF = '2026-11-24';
const snap = demoSnapshot(AS_OF);
const L = (id: string) => snap.launches.find((l) => l.id === id)!;

describe('proposeAlerts', () => {
  it('alerts the owners of L1’s blocked and overdue tickets, and reports the gate with no ticket', () => {
    const { alerts, noTicketGates } = proposeAlerts(snap, L('L1'));
    expect(alerts.map((a) => [a.id, a.to, a.reason])).toEqual([
      ['alert:LCH-126', 'Tom Alvarez', 'blocked'],
      ['alert:LCH-133', 'Rachel Ng', 'overdue'],
    ]);
    expect(noTicketGates).toEqual(['Support runbook and training']);
    expect(alerts[0].message).toBe(
      `${ALERT_MARKER}: Tom Alvarez, LCH-126 ("Load test at 50k events per minute") puts the "QA and performance sign-off" gate for L1 Triage Agent at risk. It's blocked. What's needed to unblock it, and from whom? Go/no-go is Dec 8.`,
    );
    expect(alerts[1].message).toContain('It was due Nov 22 and is still open. Can you post a new committed date?');
  });

  it('has nothing to send for launches with no risk', () => {
    for (const id of ['L2', 'L3', 'L4', 'L5']) expect(proposeAlerts(snap, L(id)).alerts).toEqual([]);
  });

  it('covers due-after-go/no-go, and routes unowned tickets to the team lead', () => {
    const issues = snap.issues.map((i) =>
      i.id === 'LCH-503' ? { ...i, due: addDays(AS_OF, 29) } : i.id === 'LCH-501' ? { ...i, status: 'blocked' as const, owner: null } : i,
    );
    const { alerts } = proposeAlerts({ ...snap, issues }, L('L5'));
    expect(alerts.map((a) => [a.issueId, a.to, a.reason, a.toIsOwner])).toEqual([
      ['LCH-501', 'Dana Kim', 'blocked', false],
      ['LCH-503', 'Ivy Park', 'late', true],
    ]);
    expect(alerts[0].message).toContain('Dana Kim (no owner yet, so this goes to the R&D lead)');
    expect(alerts[1].message).toContain("It's due Dec 23, after the Dec 22 go/no-go. Can it land by Dec 22, or should we plan around it?");
  });

  it('only alerts risky tickets in an at-risk gate, not its other open work', () => {
    expect(proposeAlerts(snap, L('L1')).alerts.map((a) => a.issueId)).not.toContain('LCH-127');
  });
});

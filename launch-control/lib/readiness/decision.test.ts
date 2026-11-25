import { describe, expect, it } from 'vitest';
import { demoSnapshot } from '../tracker/demo';
import { callToDecision, DECISION_MARKER, decisionUpdate } from './decision';

const snap = demoSnapshot('2026-11-24');
const L = (id: string) => snap.launches.find((l) => l.id === id)!;

describe('decisionUpdate', () => {
  it('posts the call, the readiness numbers and the exec update, with an off-track flag for NO-GO', () => {
    const u = decisionUpdate(L('L1'), snap, 'nogo', { execUpdate: 'L1 is not ready.' });
    expect(u.health).toBe('offTrack');
    expect(u.overrides).toBe(false);
    expect(u.body).toBe(
      [
        `${DECISION_MARKER}: **NO-GO** for L1 Triage Agent (General availability, Tier 1), recorded Nov 24.`,
        '**Readiness at the time:** 3 of 10 gates ready, 3 at risk (QA and performance sign-off; Security and legal review; Support runbook and training). Launch Dec 10, go/no-go Dec 8.',
        '**Exec update:** L1 is not ready.',
      ].join('\n\n'),
    );
  });

  it('lets a person override the rules, and puts the override on the record', () => {
    const u = decisionUpdate(L('L1'), snap, 'go', { note: 'Shipping to design partners only.' });
    expect(u.health).toBe('onTrack');
    expect(u.overrides).toBe(true);
    expect(u.body).toContain('**Note on the call:** the readiness rules say NO-GO; this decision was made by a person with that in view.');
    expect(u.body).toContain('**Note:** Shipping to design partners only.');
  });

  it('labels the note as conditions for GO WITH CONDITIONS, with an at-risk flag', () => {
    const u = decisionUpdate(L('L2'), snap, 'conditions', { note: 'QA acceptance tests pass by Dec 12.' });
    expect(u.health).toBe('atRisk');
    expect(u.overrides).toBe(false);
    expect(u.body).toContain('**Conditions:** QA acceptance tests pass by Dec 12.');
    expect(u.body).toContain('5 of 10 gates ready, 0 at risk.');
  });

  it('bounds and cleans free text', () => {
    const u = decisionUpdate(L('L4'), snap, 'go', { note: 'x'.repeat(900), execUpdate: 'ok\u0000\u0007 fine' });
    expect(u.body).toContain(`**Note:** ${'x'.repeat(500)}\n`);
    expect(u.body).toContain('**Exec update:** ok fine');
  });

  it('maps a call to a decision', () => {
    expect([callToDecision('GO'), callToDecision('GO WITH CONDITIONS'), callToDecision('NO-GO')]).toEqual(['go', 'conditions', 'nogo']);
  });
});

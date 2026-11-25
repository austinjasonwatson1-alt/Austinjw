import { describe, expect, it } from 'vitest';
import { rulesBrief } from '../readiness';
import { demoSnapshot } from '../tracker/demo';
import { briefCall, verifyBrief } from './verify';

const snap = demoSnapshot('2026-11-24');
const L1 = snap.launches[0];

describe('verifyBrief', () => {
  it('passes the rules brief against its own data', () => {
    const v = verifyBrief(rulesBrief(L1, snap), snap, L1);
    expect(v.unknown).toEqual([]);
    expect(v.call).toBe('NO-GO');
    expect(v.agrees).toBe(true);
    expect(v.riskIds).toEqual(['LCH-126', 'LCH-133']);
    expect(v.missedRisks).toEqual([]);
    expect([v.riskGates, v.riskBullets, v.extraRisks]).toEqual([3, 3, false]);
  });

  it('flags a brief that lists more blocking risks than there are at-risk gates', () => {
    const text = '## Recommendation\nNO-GO — x\n## Blocking risks\n- a LCH-126\n- b LCH-133\n- c no ticket\n- d LCH-121 unassigned';
    expect(verifyBrief(text, snap, L1)).toMatchObject({ riskGates: 3, riskBullets: 4, extraRisks: true });
    expect(verifyBrief('## Recommendation\nGO — x\n## Blocking risks\n- None.', snap, snap.launches[3])).toMatchObject({ riskBullets: 0, extraRisks: false });
  });

  it('flags invented ids, a different call and missed risks', () => {
    const text = '## Recommendation\n**GO WITH CONDITIONS** — fine.\n## Blocking risks\n- QA — LCH-126 — Tom — x\n- Docs — LCH-999 — Erin — y';
    const v = verifyBrief(text, snap, L1);
    expect(v.cited).toEqual(['LCH-126', 'LCH-999']);
    expect(v.unknown).toEqual(['LCH-999']);
    expect(v.call).toBe('GO WITH CONDITIONS');
    expect(v.agrees).toBe(false);
    expect(v.missedRisks).toEqual(['LCH-133']);
  });

  it('reads the call with or without bold, and returns null when absent', () => {
    expect(briefCall('## Recommendation\nNO-GO (as of today) — x')).toBe('NO-GO');
    expect(briefCall('## Recommendation\n**GO** — all ready')).toBe('GO');
    expect(briefCall('## Blocking risks\n- none')).toBeNull();
  });

  it('does not treat words like GA-2 style text as unknown tickets unless id-shaped', () => {
    expect(verifyBrief('## Recommendation\nNO-GO — see LCH-126 and Tier 1', snap, L1).cited).toEqual(['LCH-126']);
  });
});

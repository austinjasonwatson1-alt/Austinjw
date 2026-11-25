import { describe, expect, it } from 'vitest';
import { proposeFixes, type ProposedFix } from '../readiness/hygiene';
import { demoSnapshot } from '../tracker/demo';
import { nudgeComment, parseOwner, setOwnerLine } from '../tracker/linear-schema';
import { applyConfirmedFixes, type FixWriter } from './apply';

const snap = demoSnapshot('2026-11-24');

const recorder = (failOn?: string) => {
  const applied: ProposedFix[] = [];
  const writer: FixWriter = {
    apply: async (f) => {
      if (f.id === failOn) throw new Error('linear_rejected');
      applied.push(f);
    },
  };
  return { applied, writer };
};

describe('proposeFixes', () => {
  it('proposes the demo fixes with stable ids, owner before due before nudge', () => {
    const { fixes, unlinked } = proposeFixes(snap);
    expect(fixes.map((f) => f.id)).toEqual([
      'owner:LCH-121',
      'owner:LCH-139', 'due:LCH-139', 'nudge:LCH-139',
      'nudge:LCH-312',
      'owner:LCH-505', 'due:LCH-505', 'nudge:LCH-505',
    ]);
    expect(unlinked).toBe(2);
    expect(fixes.find((f) => f.id === 'nudge:LCH-139')).toMatchObject({ owner: 'Erin Walsh', staleDays: 16, goNoGo: '2026-12-08' });
  });
});

describe('applyConfirmedFixes', () => {
  it('applies only the confirmed ids that are still proposed', async () => {
    const { applied, writer } = recorder();
    const out = await applyConfirmedFixes(snap, ['owner:LCH-121', 'due:LCH-139', 'owner:LCH-101', 'drop:everything'], writer);
    expect(applied.map((f) => f.id)).toEqual(['owner:LCH-121', 'due:LCH-139']);
    expect(out.skipped).toEqual(['owner:LCH-101', 'drop:everything']);
    expect(out.results.every((r) => r.ok)).toBe(true);
  });

  it('uses server-computed values, never client ones', async () => {
    const { applied, writer } = recorder();
    await applyConfirmedFixes(snap, ['owner:LCH-121'], writer);
    expect(applied[0].owner).toBe('Dana Kim');
  });

  it('keeps going after a failure and reports it', async () => {
    const { applied, writer } = recorder('owner:LCH-121');
    const out = await applyConfirmedFixes(snap, ['owner:LCH-121', 'owner:LCH-505'], writer);
    expect(applied.map((f) => f.id)).toEqual(['owner:LCH-505']);
    expect(out.results).toEqual([
      { id: 'owner:LCH-121', ok: false, text: 'Assigned LCH-121 to Dana Kim (R&D lead)', error: 'linear_rejected' },
      { id: 'owner:LCH-505', ok: true, text: 'Assigned LCH-505 to Erin Walsh (Docs lead)' },
    ]);
  });

  it('caps a request at 50 fixes', async () => {
    const { applied, writer } = recorder();
    await applyConfirmedFixes(snap, [...Array(60).fill('x'), 'owner:LCH-121'], writer);
    expect(applied).toHaveLength(0); // the real id was past the cap
  });
});

describe('Linear text helpers', () => {
  it('sets or replaces the owner line and keeps the rest of the description', () => {
    expect(setOwnerLine(null, 'Dana Kim')).toBe('Owner: Dana Kim');
    expect(setOwnerLine('Steps to reproduce…', 'Dana Kim')).toBe('Owner: Dana Kim\n\nSteps to reproduce…');
    expect(setOwnerLine('Owner: Old Name\nnotes', 'Dana Kim')).toBe('Owner: Dana Kim\nnotes');
    expect(parseOwner(setOwnerLine('x', 'Erin Walsh'))).toBe('Erin Walsh');
  });
  it('writes a nudge that names the owner and the go/no-go date', () => {
    expect(nudgeComment('Erin Walsh', 16, 'Dec 8')).toBe(
      'Nudge from Launch Control: Erin Walsh, this ticket has had no update in 16 days. Can you post a status before go/no-go on Dec 8?',
    );
  });
});

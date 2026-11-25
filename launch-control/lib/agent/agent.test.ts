import { describe, expect, it } from 'vitest';
import { demoSnapshot } from '../tracker/demo';
import { parseSnapshot } from '../tracker/validate';
import { agentPrompt } from './prompt';
import { runTool, ToolInputError } from './tools';

const snap = demoSnapshot('2026-11-24');

describe('agent tools (prototype parity)', () => {
  it('list_launches', () => {
    const r = runTool(snap, 'list_launches', {});
    expect(r.trace).toBe('list_launches · 5 launches');
    expect((r.result as unknown[])[0]).toEqual({
      id: 'L1', name: 'L1 Triage Agent', milestone: 'General availability', tier: 1,
      launch_date: 'Dec 10', days_out: 16, state: 'At risk', gates_ready: '3/10',
    });
  });
  it('get_gates', () => {
    const r = runTool(snap, 'get_gates', { launch_id: 'L1' });
    expect(r.trace).toBe('get_gates · L1 · 10 gates, 3 at risk');
    const res = r.result as { go_no_go: string; gates: { gate: string; status: string; reason: string }[] };
    expect(res.go_no_go).toBe('Dec 8');
    expect(res.gates.find((g) => g.gate === 'Support runbook and training')).toEqual({
      gate: 'Support runbook and training', status: 'At risk', reason: 'No ticket exists', done: '0/0', suggested_owner: 'Kara Singh',
    });
  });
  it('list_issues', () => {
    const r = runTool(snap, 'list_issues', { launch_id: 'L1' });
    expect(r.trace).toBe('list_issues · L1 · 14 issues');
    expect((r.result as { id: string }[]).find((i) => i.id === 'LCH-133')).toEqual({
      id: 'LCH-133', title: 'Security review of agent action permissions', gate: 'Security and legal review',
      team: 'Security', owner: 'Rachel Ng', status: 'In progress', due: 'Nov 22', overdue: true, days_since_update: 9,
    });
    expect((r.result as { id: string; owner: string; due: string }[]).find((i) => i.id === 'LCH-139')).toMatchObject({
      owner: 'UNASSIGNED', due: 'NONE',
    });
  });
  it('rejects bad input with a message Claude can act on', () => {
    expect(() => runTool(snap, 'get_gates', { launch_id: 'L9' })).toThrow(ToolInputError);
    expect(() => runTool(snap, 'get_gates', {})).toThrow(/launch_id/);
    expect(() => runTool(snap, 'delete_everything', {})).toThrow(ToolInputError);
  });
  it('prompt names the launch, dates and format', () => {
    const p = agentPrompt(snap.launches[0], snap.asOf);
    expect(p).toContain('Today is Nov 24.');
    expect(p).toContain('Inspect launch L1 ("L1 Triage Agent", General availability, Tier 1, launching Dec 10; go/no-go meeting Dec 8)');
    expect(p).toContain('## Exec update');
    expect(p).toContain('Use NO-GO (as of today) if any gate is At risk');
  });
});

describe('parseSnapshot (untrusted browser input)', () => {
  it('round-trips a demo snapshot', () => {
    const json = JSON.parse(JSON.stringify(snap));
    expect(parseSnapshot(json)).toEqual({ ...snap, source: 'demo' });
  });
  it('rejects bad shapes', () => {
    const bad = (f: (s: any) => void) => {
      const s = JSON.parse(JSON.stringify(snap));
      f(s);
      return parseSnapshot(s);
    };
    expect(parseSnapshot(null)).toBeNull();
    expect(bad((s) => (s.issues[0].status = 'shipped'))).toBeNull();
    expect(bad((s) => (s.launches[0].tier = 4))).toBeNull();
    expect(bad((s) => (s.issues[0].due = 'tomorrow'))).toBeNull();
    expect(bad((s) => (s.issues[0].title = 'x'.repeat(400)))).toBeNull();
    expect(bad((s) => (s.issues = Array(1001).fill(s.issues[0])))).toBeNull();
  });
  it('drops unknown fields', () => {
    const s = JSON.parse(JSON.stringify(snap));
    s.issues[0].html = '<script>';
    expect(parseSnapshot(s)!.issues[0]).not.toHaveProperty('html');
  });
});

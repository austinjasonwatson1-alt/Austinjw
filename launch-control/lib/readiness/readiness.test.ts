import { describe, expect, it } from 'vitest';
import { addDays } from '../dates';
import { demoSnapshot } from '../tracker/demo';
import type { Issue, Launch } from '../tracker/types';
import { autofix, boardSummary, cleanScore, gateInfo, GATES, hygieneChecks, launchInfo, rulesBrief } from './index';

const AS_OF = '2026-11-24';
const fresh = () => demoSnapshot(AS_OF);
const launch = (id: string) => fresh().launches.find((l) => l.id === id)!;
const states = (id: string) => {
  const s = fresh();
  return Object.fromEntries(launchInfo(launch(id), s.issues, AS_OF).gates.map((g) => [g.gate.key, [g.state, g.why]]));
};

describe('gate scaling by tier', () => {
  it('Tier 1 has 10 gates, Tier 2 has 7, Tier 3 has 3', () => {
    expect(GATES.filter((g) => g.tiers.includes(1))).toHaveLength(10);
    expect(GATES.filter((g) => g.tiers.includes(2))).toHaveLength(7);
    expect(GATES.filter((g) => g.tiers.includes(3))).toHaveLength(3);
  });
});

describe('fresh demo data (prototype expected results)', () => {
  it('L1 Triage Agent: 3 of 10 gates at risk, 3 ready, launch at risk, 16 days out', () => {
    const s = fresh();
    const x = launchInfo(launch('L1'), s.issues, AS_OF);
    expect(x.n).toBe(10);
    expect(x.risk).toBe(3);
    expect(x.ready).toBe(3);
    expect(x.state).toBe('risk');
    expect(x.daysOut).toBe(16);
    expect(x.goNoGo).toBe('2026-12-08');
  });

  it('L1 gate-by-gate reasons', () => {
    expect(states('L1')).toEqual({
      prd: ['ready', 'Done'],
      eng: ['prog', '3 open'],
      qa: ['risk', 'Blocked'],
      flag: ['ready', 'Done'],
      sec: ['risk', 'Overdue'],
      docs: ['prog', '2 open'],
      enable: ['prog', '2 open'],
      support: ['risk', 'No ticket exists'],
      price: ['ready', 'Done'],
      comms: ['prog', '1 open'], // due exactly on go/no-go day is not "after" it
    });
  });

  it('other launches: L2 and L3 on track, L4 ready, L5 on track', () => {
    const s = fresh();
    const by = Object.fromEntries(s.launches.map((l) => [l.id, launchInfo(l, s.issues, AS_OF)]));
    expect([by.L2.state, by.L2.ready, by.L2.n]).toEqual(['prog', 5, 10]);
    expect([by.L3.state, by.L3.ready, by.L3.n]).toEqual(['prog', 3, 7]);
    expect([by.L4.state, by.L4.ready, by.L4.n]).toEqual(['ready', 3, 3]);
    expect([by.L5.state, by.L5.ready, by.L5.n]).toEqual(['prog', 0, 3]);
  });

  it('headline and KPIs', () => {
    const b = boardSummary(fresh());
    expect(b.headline).toBe('L1 Triage Agent GA is at risk: 3 of 10 gates need action, 16 days out');
    expect(b.sub).toBe('Go/no-go, the review where it is approved or held, is Dec 8. 4 of 5 launches on the calendar are on track or ready.');
    expect(b.kpis.map((k) => [k.value, k.tone])).toEqual([
      ['5', ''],
      ['14/33', 'ok'],
      ['1', 'hot'],
      ['85%', 'ok'],
    ]);
  });

  it('is independent of the calendar date it is generated for', () => {
    const s = demoSnapshot('2027-02-27'); // crosses a month end and Feb
    expect(launchInfo(s.launches[0], s.issues, s.asOf).risk).toBe(3);
    expect(boardSummary(s).kpis[1].value).toBe('14/33');
  });
});

describe('gate rules', () => {
  const L: Launch = { id: 'X', name: 'X', milestone: 'GA', tier: 1, launchDate: addDays(AS_OF, 10), pm: 'Pat' };
  const gate = GATES[0];
  const issue = (p: Partial<Issue>): Issue => ({
    id: 'I',
    launchId: 'X',
    gate: gate.key,
    title: 't',
    team: 'PM',
    owner: 'o',
    status: 'in_progress',
    due: addDays(AS_OF, 3),
    updatedAt: AS_OF,
    ...p,
  });
  const g = (...its: Partial<Issue>[]) => {
    const r = gateInfo(L, gate, its.map((p, n) => issue({ id: `I${n}`, ...p })), AS_OF);
    return [r.state, r.why];
  };

  it('no ticket → risk', () => expect(g()).toEqual(['risk', 'No ticket exists']));
  it('all done → ready, even if overdue or late', () =>
    expect(g({ status: 'done', due: addDays(AS_OF, -5) }, { status: 'done', due: addDays(AS_OF, 20) })).toEqual(['ready', 'Done']));
  it('blocked → risk', () => expect(g({}, { status: 'blocked' })).toEqual(['risk', 'Blocked']));
  it('overdue → risk', () => expect(g({ due: addDays(AS_OF, -1) })).toEqual(['risk', 'Overdue']));
  it('due today is not overdue', () => expect(g({ due: AS_OF })).toEqual(['prog', '1 open']));
  it('due after go/no-go → risk', () => expect(g({ due: addDays(AS_OF, 9) })).toEqual(['risk', 'Due after go/no-go']));
  it('due on go/no-go → in progress', () => expect(g({ due: addDays(AS_OF, 8) })).toEqual(['prog', '1 open']));
  it('no due date alone is not a gate risk', () => expect(g({ due: null })).toEqual(['prog', '1 open']));
  it('blocked wins over overdue in the reason', () =>
    expect(g({ due: addDays(AS_OF, -1) }, { status: 'blocked' })).toEqual(['risk', 'Blocked']));
  it('only counts tickets for this launch and gate', () => {
    const r = gateInfo(L, gate, [issue({ launchId: 'Y', status: 'blocked' }), issue({ gate: 'eng', status: 'blocked' })], AS_OF);
    expect(r.state).toBe('risk');
    expect(r.why).toBe('No ticket exists');
  });
});

describe('tracker hygiene', () => {
  it('flags the prototype sample issues', () => {
    const s = fresh();
    const c = Object.fromEntries(hygieneChecks(s.issues, AS_OF).map((x) => [x.key, x.items.map((i) => i.id)]));
    expect(c.owner).toEqual(['LCH-121', 'LCH-139', 'LCH-505', 'LCH-612']);
    expect(c.due).toEqual(['LCH-139', 'LCH-505']);
    expect(c.stale).toEqual(['LCH-139', 'LCH-312', 'LCH-505', 'LCH-612']);
    expect(c.link).toEqual(['LCH-610', 'LCH-612']);
    expect(cleanScore(s.issues, AS_OF)).toBe(85);
  });

  it('auto-fix applies the safe fixes and leaves unlinked tickets for a human', () => {
    const s = fresh();
    const { issues, actions } = autofix(s);
    const c = Object.fromEntries(hygieneChecks(issues, AS_OF).map((x) => [x.key, x.items.map((i) => i.id)]));
    expect(c.owner).toEqual(['LCH-612']); // PM team has no default lead
    expect(c.due).toEqual([]);
    expect(c.stale).toEqual(['LCH-612']); // nobody to nudge
    expect(c.link).toEqual(['LCH-610', 'LCH-612']);
    expect(issues.find((i) => i.id === 'LCH-121')!.owner).toBe('Dana Kim');
    expect(issues.find((i) => i.id === 'LCH-139')!.due).toBe(addDays(AS_OF, 12)); // L1 is 16 out → 4 days before
    expect(actions.filter((a) => a.minutes === 3)).toHaveLength(8);
    expect(actions.at(-1)!.text).toBe('Left 2 unlinked tickets for a human to triage');
    expect(s.issues.find((i) => i.id === 'LCH-121')!.owner).toBeNull(); // input untouched
    expect(autofix({ ...s, issues }).actions.filter((a) => a.minutes)).toHaveLength(0);
  });

  it('auto-fix due date is at least 1 day out', () => {
    const s = fresh();
    const L4 = s.launches.find((l) => l.id === 'L4')!; // 4 days out
    const issues: Issue[] = [{ ...s.issues[0], id: 'N', launchId: 'L4', status: 'backlog', due: null }];
    expect(autofix({ ...s, launches: [L4], issues }).issues[0].due).toBe(addDays(AS_OF, 1));
  });
});

describe('rules brief', () => {
  it('writes the prototype brief for L1', () => {
    const s = fresh();
    const text = rulesBrief(launch('L1'), s);
    expect(text).toContain('## Recommendation\nNO-GO (as of today) — 3 gates are blocked, overdue or missing a ticket.');
    expect(text).toContain('- QA and performance sign-off — LCH-126 — Tom Alvarez — blocked: Load test at 50k events per minute');
    expect(text).toContain('- Security and legal review — LCH-133 — Rachel Ng — overdue: Security review of agent action permissions');
    expect(text).toContain('- Support runbook and training — no ticket — Kara Singh — create and own it before Dec 8');
    // Soonest first, max 4, no-due last
    const before = text.split('## Before go/no-go\n')[1].split('\n## ')[0].split('\n');
    expect(before.map((l) => l.split(' ')[1])).toEqual(['LCH-114', 'LCH-117', 'LCH-121', 'LCH-142']);
    expect(text).toContain('LCH-121 Fix duplicate incident merge on retry — unassigned — due Dec 4');
    expect(text).toContain(
      'L1 Triage Agent (General availability, Tier 1) is at risk for Dec 10, with 3 of 10 readiness gates done. The risks are QA and performance sign-off; Security and legal review; Support runbook and training. Go/no-go is Dec 8, and we will confirm owners for each risk this week.',
    );
  });

  it('GO for a ready launch, GO WITH CONDITIONS for one in progress', () => {
    const s = fresh();
    expect(rulesBrief(launch('L4'), s)).toContain('GO — every gate is done.');
    expect(rulesBrief(launch('L4'), s)).toContain('- None.');
    expect(rulesBrief(launch('L2'), s)).toContain('GO WITH CONDITIONS — no blockers, but 5 gates are still in progress.');
  });
});

describe('empty tracker', () => {
  it('explains what counts as a launch instead of claiming everything is on track', () => {
    const b = boardSummary({ launches: [], issues: [], asOf: AS_OF });
    expect(b.headline).toBe('No launches on the calendar yet');
    expect(b.kpis.map((k) => k.value)).toEqual(['0', '0/0', '0', '100%']);
  });
});

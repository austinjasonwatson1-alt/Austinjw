import { describe, expect, it } from 'vitest';
import { boardSummary, hygieneChecks, launchInfo, rulesBrief } from '../readiness';
import { DEMO_TEAM_LEADS, demoSnapshot } from './demo';
import { mapLinear, type RawData, type RawIssue } from './linear';
import {
  FUNCTION_GROUP,
  functionLabel,
  GATE_GROUP,
  leadLine,
  ownerLine,
  parseProjectDescription,
  projectDescription,
  STATE_FOR_STATUS,
  statusFromLinear,
  TIER_LABEL,
} from './linear-schema';

const AS_OF = '2026-11-24';
const demo = demoSnapshot(AS_OF);

/** What scripts/seed-linear.ts writes, as Linear returns it. */
function seeded(): RawData {
  const projects = demo.launches.map((l, n) => ({
    id: `p${n}`,
    slugId: `slug${n}`,
    name: l.name,
    description: projectDescription(l.milestone, l.pm),
    targetDate: l.launchDate,
    lead: null,
    labels: { nodes: [{ name: TIER_LABEL(l.tier) }] },
  }));
  const issues: RawIssue[] = demo.issues.map((i, n) => ({
    identifier: `LCH-${20 + n}`,
    title: i.title,
    url: `https://linear.app/acme/issue/LCH-${20 + n}`,
    description: i.owner ? ownerLine(i.owner) : null,
    dueDate: i.due,
    updatedAt: `${AS_OF}T10:00:00.000Z`,
    assignee: null,
    state: { name: STATE_FOR_STATUS[i.status].name, type: STATE_FOR_STATUS[i.status].type },
    project: i.launchId ? { id: `p${demo.launches.findIndex((l) => l.id === i.launchId)}` } : null,
    labels: {
      nodes: [
        ...(i.gate ? [{ name: i.gate, parent: { name: GATE_GROUP } }] : []),
        ...(i.team ? [{ name: functionLabel(i.team), parent: { name: FUNCTION_GROUP } }] : []),
      ],
    },
  }));
  const labels = (Object.entries(DEMO_TEAM_LEADS) as [keyof typeof DEMO_TEAM_LEADS, string | null][]).map(([t, lead]) => ({
    name: functionLabel(t),
    description: lead ? leadLine(lead) : 'No default lead',
    parent: { name: FUNCTION_GROUP },
  }));
  return { projects, labels, issues };
}

describe('Linear adapter: seeded data scores exactly like the demo', () => {
  const live = mapLinear(seeded(), AS_OF);
  const byName = (name: string) => live.launches.find((l) => l.name === name)!;

  it('maps launches: milestone, tier, date, PM from the description', () => {
    expect(live.launches.map((l) => [l.name, l.milestone, l.tier, l.launchDate, l.pm])).toEqual(
      demo.launches.map((l) => [l.name, l.milestone, l.tier, l.launchDate, l.pm]),
    );
  });

  it('every launch has the same gate states and reasons', () => {
    for (const d of demo.launches) {
      const a = launchInfo(d, demo.issues, AS_OF);
      const b = launchInfo(byName(d.name), live.issues, AS_OF);
      expect(b.gates.map((g) => [g.gate.key, g.state, g.why, g.done, g.issues.length])).toEqual(
        a.gates.map((g) => [g.gate.key, g.state, g.why, g.done, g.issues.length]),
      );
    }
    expect(launchInfo(byName('L1 Triage Agent'), live.issues, AS_OF).risk).toBe(3);
  });

  it('same headline, owners, team leads and rules brief (modulo issue ids)', () => {
    expect(boardSummary(live).headline).toBe(boardSummary(demo).headline);
    expect(live.teamLeads).toEqual(DEMO_TEAM_LEADS);
    const idMap = new Map(live.issues.map((i, n) => [i.id, demo.issues[n].id]));
    const text = rulesBrief(byName('L1 Triage Agent'), live).replace(/LCH-\d+/g, (m) => idMap.get(m) ?? m);
    expect(text).toBe(rulesBrief(demo.launches[0], demo));
  });

  it('hygiene matches except staleness (Linear sets updatedAt itself on seeding)', () => {
    const counts = (s: typeof demo) => Object.fromEntries(hygieneChecks(s.issues, AS_OF).map((c) => [c.key, c.items.length]));
    expect(counts(live)).toEqual({ ...counts(demo), stale: 0 });
  });

  it('keeps issue urls from linear.app only', () => {
    expect(live.issues[0].url).toBe('https://linear.app/acme/issue/LCH-20');
    const raw = seeded();
    raw.issues[0].url = 'javascript:alert(1)';
    expect(mapLinear(raw, AS_OF).issues[0].url).toBeUndefined();
  });
});

describe('Linear adapter: filtering and precedence', () => {
  it('drops canceled issues and issues in non-launch projects (e.g. the build project)', () => {
    const raw = seeded();
    raw.projects.push({ id: 'build', slugId: 'b', name: 'Launch Control v1', description: 'x', targetDate: AS_OF, lead: null, labels: { nodes: [] } });
    raw.issues.push({ ...raw.issues[0], identifier: 'LCH-1', title: 'M0 Setup', project: { id: 'build' } });
    raw.issues.push({ ...raw.issues[0], identifier: 'LCH-2', title: 'Dropped', state: { name: 'Canceled', type: 'canceled' } });
    const s = mapLinear(raw, AS_OF);
    expect(s.launches).toHaveLength(5);
    expect(s.issues.map((i) => i.id)).not.toContain('LCH-1');
    expect(s.issues.map((i) => i.id)).not.toContain('LCH-2');
  });

  it('a real assignee or project lead wins over the description line', () => {
    const raw = seeded();
    raw.issues[0].assignee = { name: 'Austin Watson' };
    raw.projects[0].lead = { name: 'Austin Watson' };
    const s = mapLinear(raw, AS_OF);
    expect(s.issues[0].owner).toBe('Austin Watson');
    expect(s.launches[0].pm).toBe('Austin Watson');
  });

  it('status mapping, including the blocked label', () => {
    expect(statusFromLinear({ name: 'Todo', type: 'unstarted' }, [])).toBe('backlog');
    expect(statusFromLinear({ name: 'In Progress', type: 'started' }, [])).toBe('in_progress');
    expect(statusFromLinear({ name: 'In Review', type: 'started' }, [])).toBe('in_review');
    expect(statusFromLinear({ name: 'Blocked', type: 'started' }, [])).toBe('blocked');
    expect(statusFromLinear({ name: 'In Progress', type: 'started' }, ['Blocked'])).toBe('blocked');
    expect(statusFromLinear({ name: 'Done', type: 'completed' }, [])).toBe('done');
    expect(statusFromLinear({ name: 'Duplicate', type: 'duplicate' }, [])).toBeNull();
  });

  it('project description parsing', () => {
    expect(parseProjectDescription('General availability · PM: Maya Chen')).toEqual({ milestone: 'General availability', pm: 'Maya Chen' });
    expect(parseProjectDescription('Early access\nPM: Jordan Ellis')).toEqual({ milestone: 'Early access', pm: 'Jordan Ellis' });
    expect(parseProjectDescription('')).toEqual({ milestone: null, pm: null });
  });
});

describe('Linear adapter: ordering', () => {
  it('sorts issues by number even when Linear returns newest first', () => {
    const raw = seeded();
    raw.issues.reverse();
    expect(mapLinear(raw, AS_OF).issues.slice(0, 3).map((i) => i.id)).toEqual(['LCH-20', 'LCH-21', 'LCH-22']);
  });
});

import { fmtDate } from '../dates';
import { daysSinceUpdate, gateName, GATE_STATUS_LABEL, isOverdue, launchInfo, STATE_LABEL, STATUS_LABEL } from '../readiness';
import type { TrackerSnapshot } from '../tracker/types';

/**
 * The agent's three read-only tools, ported from prototype/index.html.
 * Definitions are plain JSON Schema; executors are pure functions over a snapshot.
 */
export const TOOL_DEFS = [
  {
    name: 'list_launches',
    description:
      'List every launch on the calendar with tier, launch date, days out and overall readiness state.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_gates',
    description:
      'Readiness gates for one launch: gate name, status (Ready, In progress, At risk), reason, and done/total tickets.',
    input_schema: {
      type: 'object' as const,
      properties: { launch_id: { type: 'string', description: 'Launch id such as L1' } },
      required: ['launch_id'],
    },
  },
  {
    name: 'list_issues',
    description:
      'Tracker issues for one launch: id, title, gate, team, owner, status, due date, overdue flag and days since last update.',
    input_schema: {
      type: 'object' as const,
      properties: { launch_id: { type: 'string' } },
      required: ['launch_id'],
    },
  },
];

export type ToolName = 'list_launches' | 'get_gates' | 'list_issues';

export interface ToolRun {
  /** One line for the live trace, e.g. "get_gates · L1 · 10 gates, 3 at risk" */
  trace: string;
  result: unknown;
}

export class ToolInputError extends Error {}

/** Short ids (L1) read well in the trace; Linear's project slugs don't, so show the name. */
const label = (l: { id: string; name: string }) => (/^[A-Z]\d+$/.test(l.id) ? l.id : l.name);

export function runTool(snap: TrackerSnapshot, name: string, input: unknown): ToolRun {
  const { asOf, launches, issues } = snap;
  const launchFor = () => {
    const id = (input as { launch_id?: unknown } | null)?.launch_id;
    if (typeof id !== 'string') throw new ToolInputError('launch_id must be a string such as L1');
    const l = launches.find((x) => x.id === id);
    if (!l) throw new ToolInputError(`Unknown launch id ${id}. Call list_launches for valid ids.`);
    return l;
  };

  switch (name) {
    case 'list_launches':
      return {
        trace: `list_launches · ${launches.length} launches`,
        result: launches.map((l) => {
          const x = launchInfo(l, issues, asOf);
          return {
            id: l.id,
            name: l.name,
            milestone: l.milestone,
            tier: l.tier,
            launch_date: fmtDate(l.launchDate),
            days_out: x.daysOut,
            state: STATE_LABEL[x.state],
            gates_ready: `${x.ready}/${x.n}`,
          };
        }),
      };
    case 'get_gates': {
      const l = launchFor();
      const x = launchInfo(l, issues, asOf);
      return {
        trace: `get_gates · ${label(l)} · ${x.n} gates, ${x.risk} at risk`,
        result: {
          launch: l.name,
          go_no_go: fmtDate(x.goNoGo),
          gates: x.gates.map((g) => ({
            gate: g.gate.name,
            status: GATE_STATUS_LABEL[g.state],
            reason: g.why,
            done: `${g.done}/${g.issues.length}`,
          })),
        },
      };
    }
    case 'list_issues': {
      const l = launchFor();
      const its = issues.filter((i) => i.launchId === l.id);
      return {
        trace: `list_issues · ${label(l)} · ${its.length} issues`,
        result: its.map((i) => ({
          id: i.id,
          title: i.title,
          gate: gateName(i.gate),
          team: i.team,
          owner: i.owner || 'UNASSIGNED',
          status: STATUS_LABEL[i.status],
          due: i.due == null ? 'NONE' : fmtDate(i.due),
          overdue: isOverdue(i, asOf),
          days_since_update: daysSinceUpdate(i, asOf),
        })),
      };
    }
    default:
      throw new ToolInputError(`Unknown tool ${name}`);
  }
}

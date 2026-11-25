import { fmtDate } from '../dates';
import type { GateKey, Issue, Launch, Team, TrackerSnapshot } from '../tracker/types';
import { isOverdue, launchInfo, STATE_LABEL, type GateInfo, type GateState } from './gates';

/** Who should create a missing gate ticket. Gates not listed fall to the launch PM. */
const MISSING_GATE_TEAM: Partial<Record<GateKey, Team>> = {
  support: 'Support',
  docs: 'Docs',
  comms: 'PMM',
  enable: 'PMM',
  sec: 'Security',
  price: 'PMM',
};

const owner = (i: Issue) => i.owner || 'unassigned';

/** Who should create and own the ticket for a gate nobody filed: that function's lead, else the launch PM. */
export function missingGateOwner(gate: GateKey, launch: Launch, teamLeads: TrackerSnapshot['teamLeads']): string {
  const team = MISSING_GATE_TEAM[gate];
  return (team && teamLeads[team]) || launch.pm || 'the launch PM';
}

export type Call = 'GO' | 'GO WITH CONDITIONS' | 'NO-GO';

/** The go/no-go call implied by a launch's state; the agent's prompt states the same rule. */
export const recommendation = (state: GateState): Call =>
  state === 'ready' ? 'GO' : state === 'risk' ? 'NO-GO' : 'GO WITH CONDITIONS';

/** The ticket a brief should cite for an at-risk gate (blocked first, then overdue, then any open). */
export function riskTicket(gate: GateInfo, asOf: string): Issue | undefined {
  return (
    gate.issues.find((i) => i.status === 'blocked') ||
    gate.issues.find((i) => isOverdue(i, asOf)) ||
    gate.issues.find((i) => i.status !== 'done')
  );
}

/**
 * The no-AI go/no-go brief: same format as the agent's, built from the same data.
 * Default view and the automatic fallback when Claude can't be reached.
 */
export function rulesBrief(
  launch: Launch,
  snap: Pick<TrackerSnapshot, 'issues' | 'asOf' | 'teamLeads'>,
): string {
  const x = launchInfo(launch, snap.issues, snap.asOf);
  const risk = x.gates.filter((g) => g.state === 'risk');
  const prog = x.gates.filter((g) => g.state === 'prog');
  const rec = recommendation(x.state) === 'NO-GO' ? 'NO-GO (as of today)' : recommendation(x.state);
  const why =
    x.state === 'ready'
      ? 'every gate is done.'
      : risk.length
        ? `${risk.length} gate${risk.length > 1 ? 's are' : ' is'} blocked, overdue or missing a ticket.`
        : `no blockers, but ${prog.length} gate${prog.length > 1 ? 's are' : ' is'} still in progress.`;

  const riskLines = risk.map((g) => {
    if (!g.issues.length) {
      const who = missingGateOwner(g.gate.key, launch, snap.teamLeads);
      return `- ${g.gate.name} — no ticket — ${who} — create and own it before ${fmtDate(x.goNoGo)}`;
    }
    const i = riskTicket(g, snap.asOf)!;
    return `- ${g.gate.name} — ${i.id} — ${owner(i)} — ${g.why.toLowerCase()}: ${i.title}`;
  });

  const progLines = prog
    .flatMap((g) => g.issues.filter((i) => i.status !== 'done'))
    .sort((a, b) => (a.due ?? '9999-12-31').localeCompare(b.due ?? '9999-12-31'))
    .slice(0, 4)
    .map((i) => `- ${i.id} ${i.title} — ${owner(i)} — ${i.due == null ? 'no due date' : 'due ' + fmtDate(i.due)}`);

  const exec =
    `${launch.name} (${launch.milestone}, Tier ${launch.tier}) is ${STATE_LABEL[x.state].toLowerCase()} for ${fmtDate(launch.launchDate)}, ` +
    `with ${x.ready} of ${x.n} readiness gates done. ` +
    (risk.length ? `The risks are ${risk.map((g) => g.gate.name).join('; ')}.` : 'There are no blocking risks.') +
    ` Go/no-go is ${fmtDate(x.goNoGo)}${risk.length ? ', and we will confirm owners for each risk this week.' : '.'}`;

  return [
    '## Recommendation',
    `${rec} — ${why}`,
    '## Blocking risks',
    ...(riskLines.length ? riskLines : ['- None.']),
    '## Before go/no-go',
    ...(progLines.length ? progLines : ['- Nothing open.']),
    '## Exec update',
    exec,
  ].join('\n');
}

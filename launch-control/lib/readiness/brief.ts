import { fmtDate } from '../dates';
import type { GateKey, Issue, Launch, Team, TrackerSnapshot } from '../tracker/types';
import { isOverdue, launchInfo, STATE_LABEL } from './gates';

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
  const rec = x.state === 'ready' ? 'GO' : risk.length ? 'NO-GO (as of today)' : 'GO WITH CONDITIONS';
  const why =
    x.state === 'ready'
      ? 'every gate is done.'
      : risk.length
        ? `${risk.length} gate${risk.length > 1 ? 's are' : ' is'} blocked, overdue or missing a ticket.`
        : `no blockers, but ${prog.length} gate${prog.length > 1 ? 's are' : ' is'} still in progress.`;

  const riskLines = risk.map((g) => {
    if (!g.issues.length) {
      const team = MISSING_GATE_TEAM[g.gate.key];
      const who = (team && snap.teamLeads[team]) || launch.pm || 'the launch PM';
      return `- ${g.gate.name} — no ticket — ${who} — create and own it before ${fmtDate(x.goNoGo)}`;
    }
    const i =
      g.issues.find((i) => i.status === 'blocked') ||
      g.issues.find((i) => isOverdue(i, snap.asOf)) ||
      g.issues.find((i) => i.status !== 'done')!;
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

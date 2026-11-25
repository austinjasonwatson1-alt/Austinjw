import { fmtDate } from '../dates';
import type { Launch, TrackerSnapshot } from '../tracker/types';
import { recommendation, type Call } from './brief';
import { launchInfo } from './gates';

/** The go/no-go call a person records after reading the brief. */
export type Decision = 'go' | 'conditions' | 'nogo';
export type Health = 'onTrack' | 'atRisk' | 'offTrack';

export const DECISION_LABEL: Record<Decision, Call> = { go: 'GO', conditions: 'GO WITH CONDITIONS', nogo: 'NO-GO' };
/** Tracker health flag posted with the decision (Linear project update health). */
export const DECISION_HEALTH: Record<Decision, Health> = { go: 'onTrack', conditions: 'atRisk', nogo: 'offTrack' };
export const HEALTH_LABEL: Record<Health, string> = { onTrack: 'On track', atRisk: 'At risk', offTrack: 'Off track' };
export const callToDecision = (c: Call): Decision => (c === 'GO' ? 'go' : c === 'NO-GO' ? 'nogo' : 'conditions');

/** Every decision update starts with this, so the app's own updates can be found again. */
export const DECISION_MARKER = 'Go/no-go decision from Launch Control';
export const MAX_NOTE = 500;
export const MAX_EXEC = 1500;

const clean = (s: string | undefined, max: number) =>
  (s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, max);

export interface DecisionUpdate {
  decision: Decision;
  health: Health;
  rulesCall: Call;
  /** True when the person's call differs from the rules engine's. Allowed, but always on the record. */
  overrides: boolean;
  /** Markdown body of the status update. */
  body: string;
}

/**
 * The status update posted when a person records a go/no-go decision: the call, the readiness
 * numbers at that moment (so an override is visible), their note, and the exec update.
 */
export function decisionUpdate(
  launch: Launch,
  snap: Pick<TrackerSnapshot, 'issues' | 'asOf'>,
  decision: Decision,
  opts: { note?: string; execUpdate?: string } = {},
): DecisionUpdate {
  const x = launchInfo(launch, snap.issues, snap.asOf);
  const rulesCall = recommendation(x.state);
  const overrides = DECISION_LABEL[decision] !== rulesCall;
  const risky = x.gates.filter((g) => g.state === 'risk').map((g) => g.gate.name);
  const note = clean(opts.note, MAX_NOTE);
  const exec = clean(opts.execUpdate, MAX_EXEC);
  const lines = [
    `${DECISION_MARKER}: **${DECISION_LABEL[decision]}** for ${launch.name} (${launch.milestone}, Tier ${launch.tier}), recorded ${fmtDate(snap.asOf)}.`,
    `**Readiness at the time:** ${x.ready} of ${x.n} gates ready, ${x.risk} at risk${risky.length ? ` (${risky.join('; ')})` : ''}. Launch ${fmtDate(launch.launchDate)}, go/no-go ${fmtDate(x.goNoGo)}.`,
  ];
  if (overrides) lines.push(`**Note on the call:** the readiness rules say ${rulesCall}; this decision was made by a person with that in view.`);
  if (note) lines.push(`**${decision === 'conditions' ? 'Conditions' : 'Note'}:** ${note}`);
  if (exec) lines.push(`**Exec update:** ${exec}`);
  return { decision, health: DECISION_HEALTH[decision], rulesCall, overrides, body: lines.join('\n\n') };
}

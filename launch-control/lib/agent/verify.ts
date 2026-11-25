import { parseBrief } from '../brief/parse';
import { launchInfo, recommendation, riskTicket, type Call } from '../readiness';
import type { Launch, TrackerSnapshot } from '../tracker/types';

export interface BriefCheck {
  /** Distinct issue ids the brief cites, in order of first mention. */
  cited: string[];
  /** Cited ids that don't exist in the tracker data the agent was given. */
  unknown: string[];
  /** The brief's call, or null if the Recommendation section couldn't be read. */
  call: Call | null;
  /** The rules engine's call for the same data. */
  rulesCall: Call;
  agrees: boolean;
  /** At-risk tickets the rules engine would cite, and which of them the brief missed. */
  riskIds: string[];
  missedRisks: string[];
}

const ID = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/** Reads the call from the first line of the Recommendation section. */
export function briefCall(text: string): Call | null {
  const blocks = parseBrief(text);
  const h = blocks.findIndex((b) => b.kind === 'heading' && /^recommendation/i.test(b.text));
  const p = blocks[h + 1];
  if (h < 0 || !p || p.kind !== 'para') return null;
  const line = p.spans.map((s) => s.text).join('').trim().toUpperCase();
  if (/^NO-GO\b/.test(line)) return 'NO-GO';
  if (/^GO WITH CONDITIONS\b/.test(line)) return 'GO WITH CONDITIONS';
  if (/^GO\b/.test(line)) return 'GO';
  return null;
}

/**
 * Checks an AI brief against the data it was written from. Model output is untrusted:
 * every issue id it cites must exist, and its call should match the rules engine's.
 */
export function verifyBrief(text: string, snap: Pick<TrackerSnapshot, 'issues' | 'asOf'>, launch: Launch): BriefCheck {
  const known = new Set(snap.issues.map((i) => i.id));
  const cited = [...new Set(text.match(ID) ?? [])];
  const x = launchInfo(launch, snap.issues, snap.asOf);
  const riskIds = x.gates
    .filter((g) => g.state === 'risk' && g.issues.length)
    .map((g) => riskTicket(g, snap.asOf)?.id)
    .filter((id): id is string => !!id);
  const call = briefCall(text);
  const rulesCall = recommendation(x.state);
  return {
    cited,
    unknown: cited.filter((id) => !known.has(id)),
    call,
    rulesCall,
    agrees: call === rulesCall,
    riskIds,
    missedRisks: riskIds.filter((id) => !cited.includes(id)),
  };
}

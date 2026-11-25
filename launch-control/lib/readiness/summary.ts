import { fmtDate } from '../dates';
import type { TrackerSnapshot } from '../tracker/types';
import { launchInfo, type LaunchInfo } from './gates';
import { cleanScore } from './hygiene';

export interface Kpi {
  tone: '' | 'ok' | 'hot';
  value: string;
  label: string;
}

export interface BoardSummary {
  infos: LaunchInfo[];
  /** The launch the headline is about, if any is at risk. */
  hotId: string | null;
  headline: string;
  sub: string;
  kpis: Kpi[];
  hygiene: number;
}

/** "general availability launch", "early access launch", "minor release": spelled out for first-time readers. */
const msShort = (ms: string) => (/release/i.test(ms) ? ms.toLowerCase() : `${ms.toLowerCase()} launch`);

/** Finding-as-headline plus the 4 KPIs above the launch calendar. */
export function boardSummary(snap: Pick<TrackerSnapshot, 'launches' | 'issues' | 'asOf'>): BoardSummary {
  const infos = snap.launches.map((l) => launchInfo(l, snap.issues, snap.asOf));
  const byDate = (a: LaunchInfo, b: LaunchInfo) => a.daysOut - b.daysOut;
  // Soonest at-risk Tier 1 launch first; otherwise the soonest at-risk launch of any tier.
  const hot =
    infos.filter((x) => x.launch.tier === 1).sort(byDate).find((x) => x.risk) ||
    infos.filter((x) => x.risk).sort(byDate)[0];

  let headline: string;
  let sub: string;
  if (!infos.length) {
    headline = 'No launches on the calendar yet';
    sub = 'A launch is a project with a Tier 1, 2 or 3 label and a target date. Add one in the tracker, or switch to Demo data.';
  } else if (hot) {
    headline = `${hot.launch.name} ${msShort(hot.launch.milestone)} is at risk: ${hot.risk} of ${hot.n} gates need action, ${hot.daysOut} days out`;
    sub = `Go/no-go, the review where it is approved or held, is ${fmtDate(hot.goNoGo)}. ${infos.filter((x) => x.state !== 'risk').length} of ${infos.length} launches on the calendar are on track or ready.`;
  } else {
    headline = 'Every launch on the calendar is on track';
    sub = 'No gates are blocked, overdue or missing a ticket.';
  }

  const total = infos.reduce((a, x) => a + x.n, 0);
  const ready = infos.reduce((a, x) => a + x.ready, 0);
  const atRisk = infos.filter((x) => x.state === 'risk').length;
  const hygiene = cleanScore(snap.issues, snap.asOf);
  const kpis: Kpi[] = [
    { tone: '', value: String(infos.filter((x) => x.daysOut <= 30).length), label: 'Launches in the next 30 days' },
    { tone: 'ok', value: `${ready}/${total}`, label: 'Gates ready' },
    { tone: atRisk ? 'hot' : 'ok', value: String(atRisk), label: 'Launches at risk' },
    { tone: hygiene < 85 ? 'hot' : 'ok', value: `${hygiene}%`, label: 'Tracker data quality' },
  ];
  return { infos, hotId: hot?.launch.id ?? null, headline, sub, kpis, hygiene };
}

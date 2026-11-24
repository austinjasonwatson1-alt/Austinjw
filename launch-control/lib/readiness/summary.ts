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

const msShort = (ms: string) => (ms === 'General availability' ? 'GA' : ms.toLowerCase());

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
  if (hot) {
    headline = `${hot.launch.name} ${msShort(hot.launch.milestone)} is at risk: ${hot.risk} of ${hot.n} gates need action, ${hot.daysOut} days out`;
    sub = `Go/no-go is ${fmtDate(hot.goNoGo)}. ${infos.filter((x) => x.state !== 'risk').length} of ${infos.length} launches on the calendar are on track or ready.`;
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
    { tone: hygiene < 85 ? 'hot' : 'ok', value: `${hygiene}%`, label: 'Tracker hygiene' },
  ];
  return { infos, hotId: hot?.launch.id ?? null, headline, sub, kpis, hygiene };
}

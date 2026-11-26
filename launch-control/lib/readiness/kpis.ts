import type { TrackerSnapshot } from '../tracker/types';
import { launchInfo } from './gates';
import { cleanScore } from './hygiene';

export interface DeliveryKpi {
  key: 'owned' | 'onTrack' | 'readyNearGoNoGo' | 'quality';
  label: string;
  /** Display value, e.g. "79%" or "n/a". */
  value: string;
  /** How it is counted, in plain words. */
  detail: string;
  target: string;
  tone: 'ok' | 'hot' | '';
}

const pct = (n: number, d: number) => Math.round((n / d) * 100);

/**
 * Product delivery KPIs computed from the tracker as it is today. A snapshot, not a trend:
 * trends need stored history, which v1 deliberately doesn't have (no database).
 */
export function deliveryKpis(snap: Pick<TrackerSnapshot, 'launches' | 'issues' | 'asOf'>): DeliveryKpi[] {
  const infos = snap.launches.map((l) => launchInfo(l, snap.issues, snap.asOf));
  const gates = infos.flatMap((x) => x.gates);

  // 1. A gate is "owned and dated" when it has a ticket and every open ticket has an owner and a due date.
  const owned = gates.filter((g) => g.issues.length > 0 && g.issues.every((i) => i.status === 'done' || (i.owner && i.due))).length;
  const ownedPct = gates.length ? pct(owned, gates.length) : 100;

  // 2. Launches not at risk.
  const onTrack = infos.filter((x) => x.state !== 'risk').length;

  // 3. For launches whose go/no-go is within 7 days: how many of their gates are already ready.
  const near = infos.filter((x) => x.daysOut - 2 <= 7);
  const nearGates = near.reduce((a, x) => a + x.n, 0);
  const nearReady = near.reduce((a, x) => a + x.ready, 0);

  const quality = cleanScore(snap.issues, snap.asOf);

  return [
    {
      key: 'owned',
      label: 'Gates with an owner and a date',
      value: `${ownedPct}%`,
      detail: `${owned} of ${gates.length} gates have a ticket, and every open ticket has an owner and a due date`,
      target: 'Target 100%',
      tone: ownedPct >= 90 ? 'ok' : 'hot',
    },
    {
      key: 'onTrack',
      label: 'Launches on track',
      value: `${onTrack}/${infos.length}`,
      detail: 'Launches with no gate at risk',
      target: 'Target: all',
      tone: onTrack === infos.length ? 'ok' : 'hot',
    },
    {
      key: 'readyNearGoNoGo',
      label: 'Gates ready within a week of go/no-go',
      value: nearGates ? `${pct(nearReady, nearGates)}%` : 'n/a',
      detail: nearGates
        ? `${nearReady} of ${nearGates} gates ready across ${near.length} launch${near.length === 1 ? '' : 'es'} with go/no-go in the next 7 days`
        : 'No launch has its go/no-go in the next 7 days',
      target: 'Target 80% a week out',
      tone: !nearGates ? '' : pct(nearReady, nearGates) >= 80 ? 'ok' : 'hot',
    },
    {
      key: 'quality',
      label: 'Tracker data quality',
      value: `${quality}%`,
      detail: 'Tickets with an owner, a due date, a recent update and a launch',
      target: 'Target 95%',
      tone: quality >= 95 ? 'ok' : 'hot',
    },
  ];
}

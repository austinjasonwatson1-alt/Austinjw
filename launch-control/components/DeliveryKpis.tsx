'use client';

import type { DeliveryKpi } from '@/lib/readiness';
import { cx } from './cx';

/** Product delivery KPIs as of today. A snapshot: trends need stored history. */
export default function DeliveryKpis({ kpis }: { kpis: DeliveryKpi[] }) {
  return (
    <div className={cx('wrap')}>
      <div className={cx('panel')}>
        <div className={cx('lhead')}>
          <div>
            <h2>Delivery KPIs</h2>
            <small>What leadership would track week to week, counted from the tracker as it is today</small>
          </div>
          <small>Today&apos;s snapshot</small>
        </div>
        <div className={cx('dk')}>
          {kpis.map((k) => (
            <div key={k.key} className={cx('dkItem', k.tone)}>
              <b>{k.value}</b>
              <strong>{k.label}</strong>
              <small>{k.detail}</small>
              <small className={cx('dkTarget')}>{k.target}</small>
            </div>
          ))}
        </div>
        <p className={cx('how')}>
          These move as tickets change: fix an owner or a date above and watch them update. Trends over time need stored
          history, which this version doesn&apos;t keep yet. Targets are examples to agree with each team.
        </p>
      </div>
    </div>
  );
}

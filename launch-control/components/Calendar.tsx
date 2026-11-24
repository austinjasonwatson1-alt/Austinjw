'use client';

import { addDays, fmtDate } from '@/lib/dates';
import { STATE_LABEL, type BoardSummary } from '@/lib/readiness';
import { cx } from './cx';

/** Days shown on the calendar axis. Launches further out are pinned to the right edge. */
const AXIS_DAYS = 35;
const TICKS = [0, 7, 14, 21, 28, 35];

export default function Calendar({
  summary,
  asOf,
  selected,
  onSelect,
}: {
  summary: BoardSummary;
  asOf: string;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const rows = summary.infos.slice().sort((a, b) => a.daysOut - b.daysOut);
  return (
    <>
      <div className={cx('cal')} role="list" aria-label="Launch calendar">
        <div className={cx('axis')}>
          <span />
          <div className={cx('ticks')}>
            {TICKS.map((d) => (
              <span key={d} style={{ left: `${(d / AXIS_DAYS) * 100}%` }}>
                {d ? fmtDate(addDays(asOf, d)) : 'Today'}
              </span>
            ))}
          </div>
          <span />
        </div>
        {rows.map((x) => {
          const L = x.launch;
          const on = L.id === selected;
          const w = (Math.min(Math.max(x.daysOut, 0), AXIS_DAYS) / AXIS_DAYS) * 100;
          return (
            <button
              key={L.id}
              type="button"
              className={cx('row', on && 'on')}
              role="listitem"
              aria-pressed={on}
              onClick={() => onSelect(L.id)}
            >
              <span className={cx('nm')}>
                <b>{L.name}</b>
                <small>
                  {L.milestone} · Tier {L.tier}
                </small>
              </span>
              <span className={cx('trk')}>
                <span className={cx('bar')} style={{ width: `${w}%` }}>
                  {x.gates.map((g) => (
                    <i key={g.gate.key} className={cx('seg', g.state)} title={`${g.gate.name}: ${g.why}`} />
                  ))}
                </span>
                <span className={cx('mk', x.state)} style={{ left: `${w}%` }} />
              </span>
              <span className={cx('dt')}>
                {fmtDate(L.launchDate)}
                <small className={cx(x.state)}>{STATE_LABEL[x.state]}</small>
              </span>
            </button>
          );
        })}
      </div>
      <div className={cx('legend')}>
        <span className={cx('ready')}>
          <i />
          Gate ready
        </span>
        <span className={cx('prog')}>
          <i />
          In progress
        </span>
        <span className={cx('risk')}>
          <i />
          At risk or missing
        </span>
        <span>
          Each bar runs from today to the launch date and is built from that launch&apos;s gates. Select a launch to
          inspect it.
        </span>
      </div>
    </>
  );
}

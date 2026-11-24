'use client';

import type { HygieneCheck } from '@/lib/readiness';
import { cx } from './cx';

export interface LogEntry {
  at: string;
  text: string;
}

const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

export default function HygienePanel({
  checks,
  clean,
  saved,
  log,
  onFix,
  onReset,
}: {
  checks: HygieneCheck[];
  clean: number;
  saved: number;
  log: LogEntry[];
  onFix: () => void;
  onReset: () => void;
}) {
  return (
    <div className={cx('wrap', 'hyg')}>
      <div className={cx('panel')}>
        <div className={cx('lhead')}>
          <div>
            <h2>Tracker hygiene</h2>
            <small>So leadership can report straight from the tool, without cleanup</small>
          </div>
          <small>{clean}% clean</small>
        </div>
        <div>
          {checks.map((c) => (
            <div key={c.key} className={cx('chk', c.items.length > 0 && 'bad')}>
              <span>
                <strong>{c.name}</strong>
              </span>
              <b>{c.items.length}</b>
              <small>
                {c.items.length ? `${c.items.map((i) => i.id).join(', ')} · ` : ''}
                {c.fix}
              </small>
            </div>
          ))}
        </div>
        <div className={cx('btns')}>
          <button type="button" className={cx('go')} onClick={onFix}>
            Auto-fix the safe ones
          </button>
          <button type="button" className={cx('ghost')} onClick={onReset}>
            Reset sample data
          </button>
        </div>
      </div>
      <div className={cx('panel')}>
        <h2>Manual work removed</h2>
        <small>Estimate: 45 min per readiness sweep done by hand, 3 min per ticket fixed by hand</small>
        <div className={cx('big')}>{minutes(saved)}</div>
        <ul className={cx('log')}>
          {log.length ? (
            log.map((l, n) => (
              <li key={log.length - n}>
                <time>{l.at}</time>
                {l.text}
              </li>
            ))
          ) : (
            <li>Nothing yet. Run the agent or auto-fix to log work here.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

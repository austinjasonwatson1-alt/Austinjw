'use client';

import type { HygieneCheck, ProposedFix } from '@/lib/readiness';
import { cx } from './cx';
import ReviewList, { type Outcome } from './ReviewList';

export interface LiveFixes {
  fixes: ProposedFix[];
  /** Writes the confirmed fixes to Linear; resolves to a one-line outcome to show. */
  apply: (ids: string[]) => Promise<Outcome>;
}

const KIND_NOTE: Record<ProposedFix['kind'], string> = {
  owner: 'Sets the owner in Linear',
  due: 'Sets the due date in Linear',
  nudge: 'Posts a comment in Linear asking for an update',
};

/** Linear mode: review proposed fixes, then apply the ticked ones. Nothing is written before Apply. */
function LiveFixPanel({ live }: { live: LiveFixes }) {
  return (
    <ReviewList
      items={live.fixes.map((f) => ({ id: f.id, title: f.text, detail: KIND_NOTE[f.kind] }))}
      label="Proposed fixes"
      openLabel={(n) => `Review ${n} fix${n > 1 ? 'es' : ''}`}
      emptyLabel="Nothing safe to fix"
      confirmLabel={(n) => `Apply ${n} to Linear`}
      busyLabel="Writing to Linear…"
      note="Live data: fixes are written to Linear only after you review and confirm them."
      onConfirm={live.apply}
    />
  );
}

export interface LogEntry {
  at: string;
  text: string;
}

const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

export default function HygienePanel({
  checks,
  clean,
  saved,
  waiting,
  log,
  onFix,
  onReset,
  live,
}: {
  checks: HygieneCheck[];
  clean: number;
  saved: number;
  /** Manual work available to remove right now, computed from the data on screen. */
  waiting: { minutes: number; sweeps: number; fixes: number; alerts: number };
  log: LogEntry[];
  /** Demo actions. Omit both for live Linear data and pass `live` instead. */
  onFix?: () => void;
  onReset?: () => void;
  live?: LiveFixes;
}) {
  return (
    <div className={cx('wrap', 'hyg')}>
      <div className={cx('panel')}>
        <div className={cx('lhead')}>
          <div>
            <h2>Tracker data quality</h2>
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
        {onFix && onReset ? (
          <div className={cx('btns')}>
            <button type="button" className={cx('go')} onClick={onFix}>
              Auto-fix the safe ones
            </button>
            <button type="button" className={cx('ghost')} onClick={onReset}>
              Reset sample data
            </button>
          </div>
        ) : live ? (
          <LiveFixPanel live={live} />
        ) : null}
      </div>
      <div className={cx('panel')}>
        <h2>Manual work removed</h2>
        <small>Estimate: 45 min per readiness sweep done by hand, 3 min per ticket fixed or owner chased by hand</small>
        {log.length === 0 && waiting.minutes > 0 ? (
          <>
            <div className={cx('big', 'bigWaiting')}>{minutes(waiting.minutes)}</div>
            <p className={cx('waitnote')}>
              of manual work waiting this week: {waiting.sweeps} readiness sweep{waiting.sweeps === 1 ? '' : 's'}, {waiting.fixes} ticket
              fix{waiting.fixes === 1 ? '' : 'es'} and {waiting.alerts} owner alert{waiting.alerts === 1 ? '' : 's'}. Run the agent, send an
              alert or apply a fix and this becomes a count of what was removed.
            </p>
          </>
        ) : (
          <>
            <div className={cx('big')}>{minutes(saved)}</div>
            {waiting.minutes > 0 && <p className={cx('waitnote')}>removed so far, of about {minutes(waiting.minutes)} still waiting.</p>}
          </>
        )}
        <ul className={cx('log')}>
          {log.length ? (
            log.map((l, n) => (
              <li key={log.length - n}>
                <time>{l.at}</time>
                {l.text}
              </li>
            ))
          ) : (
            <li>Each automated action is logged here with the time it took off someone&apos;s plate.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

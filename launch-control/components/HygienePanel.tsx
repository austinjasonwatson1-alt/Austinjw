'use client';

import { useState } from 'react';
import type { HygieneCheck, ProposedFix } from '@/lib/readiness';
import { cx } from './cx';

export interface LiveFixes {
  fixes: ProposedFix[];
  /** Writes the confirmed fixes to Linear; resolves to a one-line outcome to show. */
  apply: (ids: string[]) => Promise<{ ok: boolean; message: string }>;
}

const KIND_NOTE: Record<ProposedFix['kind'], string> = {
  owner: 'Sets the owner',
  due: 'Sets the due date',
  nudge: 'Posts a comment asking for an update',
};

/** Linear mode: review proposed fixes, then apply the ticked ones. Nothing is written before Apply. */
function LiveFixPanel({ live }: { live: LiveFixes }) {
  const [reviewing, setReviewing] = useState(false);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const chosen = live.fixes.filter((f) => !off.has(f.id));

  if (!reviewing) {
    return (
      <>
        <div className={cx('btns')}>
          <button
            type="button"
            className={cx('go')}
            disabled={!live.fixes.length}
            onClick={() => {
              setOff(new Set());
              setMsg(null);
              setReviewing(true);
            }}
          >
            {live.fixes.length ? `Review ${live.fixes.length} fix${live.fixes.length > 1 ? 'es' : ''}` : 'Nothing safe to fix'}
          </button>
        </div>
        {msg ? (
          <p className={cx('msg', !msg.ok && 'bad')} role="status">
            {msg.message}
          </p>
        ) : (
          <p className={cx('how')}>Live data: fixes are written to Linear only after you review and confirm them.</p>
        )}
      </>
    );
  }
  const toggle = (id: string) =>
    setOff((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <>
      <ul className={cx('fixlist')} aria-label="Proposed fixes">
        {live.fixes.map((f) => (
          <li key={f.id}>
            <label>
              <input type="checkbox" checked={!off.has(f.id)} disabled={busy} onChange={() => toggle(f.id)} />
              <span>
                {f.text}
                <small>{KIND_NOTE[f.kind]} in Linear</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className={cx('btns')}>
        <button
          type="button"
          className={cx('go')}
          disabled={busy || !chosen.length}
          onClick={async () => {
            setBusy(true);
            const r = await live.apply(chosen.map((f) => f.id));
            setBusy(false);
            setMsg(r);
            setReviewing(false);
          }}
        >
          {busy ? 'Writing to Linear…' : `Apply ${chosen.length} to Linear`}
        </button>
        <button type="button" className={cx('ghost')} disabled={busy} onClick={() => setReviewing(false)}>
          Cancel
        </button>
      </div>
    </>
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
  log,
  onFix,
  onReset,
  live,
}: {
  checks: HygieneCheck[];
  clean: number;
  saved: number;
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

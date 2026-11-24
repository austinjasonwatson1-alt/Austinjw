'use client';

import { useState } from 'react';
import { cx } from './cx';

export interface ReviewItem {
  id: string;
  title: string;
  detail: string;
}

export type Outcome = { ok: boolean; message: string };

/**
 * Review-then-confirm: lists every proposed change, all ticked; only the ticked ones are sent
 * when the person confirms. Used for hygiene fixes and risk alerts.
 */
export default function ReviewList({
  items,
  label,
  openLabel,
  emptyLabel,
  confirmLabel,
  busyLabel,
  note,
  onConfirm,
}: {
  items: ReviewItem[];
  /** Accessible name of the list, e.g. "Proposed fixes" */
  label: string;
  openLabel: (n: number) => string;
  emptyLabel: string;
  confirmLabel: (n: number) => string;
  busyLabel: string;
  /** Shown under the button until there's an outcome to report. */
  note: string;
  onConfirm: (ids: string[]) => Promise<Outcome>;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Outcome | null>(null);
  const chosen = items.filter((f) => !off.has(f.id));

  if (!reviewing) {
    return (
      <>
        <div className={cx('btns')}>
          <button
            type="button"
            className={cx('go')}
            disabled={!items.length}
            onClick={() => {
              setOff(new Set());
              setMsg(null);
              setReviewing(true);
            }}
          >
            {items.length ? openLabel(items.length) : emptyLabel}
          </button>
        </div>
        {msg ? (
          <p className={cx('msg', !msg.ok && 'bad')} role="status">
            {msg.message}
          </p>
        ) : (
          <p className={cx('how')}>{note}</p>
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
      <ul className={cx('fixlist')} aria-label={label}>
        {items.map((f) => (
          <li key={f.id}>
            <label>
              <input type="checkbox" checked={!off.has(f.id)} disabled={busy} onChange={() => toggle(f.id)} />
              <span>
                {f.title}
                <small>{f.detail}</small>
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
            const r = await onConfirm(chosen.map((f) => f.id));
            setBusy(false);
            setMsg(r);
            setReviewing(false);
          }}
        >
          {busy ? busyLabel : confirmLabel(chosen.length)}
        </button>
        <button type="button" className={cx('ghost')} disabled={busy} onClick={() => setReviewing(false)}>
          Cancel
        </button>
      </div>
    </>
  );
}

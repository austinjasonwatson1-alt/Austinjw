'use client';

import { useState } from 'react';
import { spans } from '@/lib/brief/parse';
import { DECISION_LABEL, HEALTH_LABEL, type Decision, type DecisionUpdate } from '@/lib/readiness';
import { cx } from './cx';
import type { Outcome } from './ReviewList';

export interface Recorded {
  decision: Decision;
  at: string;
  posted: boolean;
  url?: string;
}

export interface DecisionProps {
  launchName: string;
  /** What the readiness rules would call. Shown as a suggestion; the person decides. */
  suggested: Decision;
  /** True when the decision posts to Linear; false when it's only logged (demo data). */
  live: boolean;
  recorded?: Recorded;
  preview: (d: Decision, note: string) => DecisionUpdate;
  record: (d: Decision, note: string) => Promise<Outcome>;
}

const ORDER: Decision[] = ['go', 'conditions', 'nogo'];
const TONE: Record<Decision, string> = { go: 'dGo', conditions: 'dCond', nogo: 'dNo' };

/** Renders the update's small Markdown (paragraphs and **bold**) as text nodes, never HTML. */
function Preview({ body }: { body: string }) {
  return (
    <>
      {body.split('\n\n').map((para, n) => (
        <p key={n}>{spans(para).map((s, k) => (s.bold ? <strong key={k}>{s.text}</strong> : <span key={k}>{s.text}</span>))}</p>
      ))}
    </>
  );
}

/** Record the go/no-go call. Nothing is posted until the person confirms the previewed update. */
export default function DecisionBar({ d }: { d: DecisionProps }) {
  const [picked, setPicked] = useState<Decision | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Outcome | null>(null);
  const update = picked ? d.preview(picked, note) : null;

  return (
    <div className={cx('decision')}>
      <h3>Decision</h3>
      <p className={cx('dsub')}>
        The call is a person&apos;s to make. The readiness rules suggest <strong>{DECISION_LABEL[d.suggested]}</strong>.
      </p>
      <div className={cx('btns')} role="group" aria-label="Go/no-go decision">
        {ORDER.map((k) => (
          <button
            key={k}
            type="button"
            className={cx('dbtn', TONE[k])}
            aria-pressed={picked === k}
            disabled={busy}
            onClick={() => {
              setMsg(null);
              setPicked(picked === k ? null : k);
            }}
          >
            {DECISION_LABEL[k] === 'GO' ? 'Go' : DECISION_LABEL[k] === 'NO-GO' ? 'No-go' : 'Go with conditions'}
          </button>
        ))}
      </div>

      {picked && update && (
        <>
          {update.overrides && (
            <p className={cx('msg', 'bad')}>
              This differs from the rules ({update.rulesCall}). You can still record it; the readiness numbers are posted with it.
            </p>
          )}
          <input
            className={cx('pcin')}
            type="text"
            maxLength={500}
            aria-label={picked === 'conditions' ? 'Conditions' : 'Note (optional)'}
            placeholder={picked === 'conditions' ? 'What are the conditions?' : 'Add a note (optional)'}
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className={cx('preview')} aria-label="What will be posted">
            <small>
              {d.live ? 'Will post to Linear as a project update' : 'Sample data: on live data this posts to Linear as a project update'} · Health:{' '}
              {HEALTH_LABEL[update.health]}
            </small>
            <Preview body={update.body} />
          </div>
          <div className={cx('btns')}>
            <button
              type="button"
              className={cx('go')}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const r = await d.record(picked, note);
                setBusy(false);
                setMsg(r);
                if (r.ok) {
                  setPicked(null);
                  setNote('');
                }
              }}
            >
              {busy ? 'Posting…' : d.live ? 'Post decision to Linear' : 'Record decision'}
            </button>
            <button type="button" className={cx('ghost')} disabled={busy} onClick={() => setPicked(null)}>
              Cancel
            </button>
          </div>
        </>
      )}

      {!picked && d.recorded && (
        <p className={cx('checks')} role="status">
          ✓ {DECISION_LABEL[d.recorded.decision]} recorded {d.recorded.at}
          {d.recorded.posted ? ' · ' : ' (sample data: logged, not posted)'}
          {d.recorded.posted &&
            (d.recorded.url ? (
              <a className={cx('dlink')} href={d.recorded.url} target="_blank" rel="noopener noreferrer">
                posted to Linear ↗
              </a>
            ) : (
              'posted to Linear'
            ))}
        </p>
      )}
      {msg && !msg.ok && (
        <p className={cx('msg', 'bad')} role="status">
          {msg.message}
        </p>
      )}
    </div>
  );
}

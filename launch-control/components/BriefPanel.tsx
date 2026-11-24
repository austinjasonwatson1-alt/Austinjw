'use client';

import { useEffect, useRef, useState } from 'react';
import { execUpdate } from '@/lib/brief/parse';
import BriefText from './BriefText';
import { cx } from './cx';

export interface Brief {
  launchId: string;
  kind: 'ai' | 'rules';
  text: string;
  at: string;
  trace: string[];
  stale?: boolean;
}

export default function BriefPanel({
  brief,
  running,
  agentAvailable,
  onRun,
}: {
  brief: Brief;
  running: boolean;
  agentAvailable: boolean;
  onRun: () => void;
}) {
  const [copyLabel, setCopyLabel] = useState('Copy exec update');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const flash = (t: string) => {
      setCopyLabel(t);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopyLabel('Copy exec update'), 1500);
    };
    try {
      await navigator.clipboard.writeText(execUpdate(brief.text));
      flash('Copied');
    } catch {
      flash('Copy blocked here');
    }
  };

  return (
    <aside className={cx('panel', 'brief')} aria-live="polite">
      <h2>Go/no-go brief</h2>
      <div className={cx('src')}>
        {brief.kind === 'ai' ? (
          <>
            <span className={cx('pill', 'ai')}>Claude agent</span>
            <span>written {brief.at}</span>
          </>
        ) : (
          <>
            <span className={cx('pill')}>Rules engine</span>
            <span>updates live as tickets move</span>
          </>
        )}
      </div>
      <div className={cx('btns')}>
        <button type="button" className={cx('go')} disabled={running} onClick={onRun}>
          {running ? 'Agent is reading the tracker…' : agentAvailable ? 'Run readiness agent' : 'Run readiness check'}
        </button>
        <button type="button" className={cx('ghost')} onClick={copy}>
          {copyLabel}
        </button>
      </div>
      <ul className={cx('trace')}>
        {brief.trace.map((t, n) => (
          <li key={n}>{t}</li>
        ))}
      </ul>
      <div className={cx('out')}>
        {running && !brief.text ? <p>Thinking…</p> : <BriefText text={brief.text} />}
        {brief.kind === 'ai' && brief.stale && (
          <p className={cx('stale')}>Tickets may have changed since this brief. Run the agent again for a fresh read.</p>
        )}
      </div>
      <p className={cx('how')}>
        The agent is Claude with three read-only tools over the tracker: list_launches, get_gates and list_issues. It
        reads the live data, then writes the brief. If Claude can&apos;t be reached, a rules engine writes the same brief
        from the same data, so the launch review never stalls.
      </p>
    </aside>
  );
}

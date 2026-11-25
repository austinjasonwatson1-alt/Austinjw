'use client';

import { useEffect, useRef, useState } from 'react';
import type { BriefCheck } from '@/lib/agent/verify';
import { execUpdate } from '@/lib/brief/parse';
import BriefText from './BriefText';
import DecisionBar, { type DecisionProps } from './DecisionBar';
import { cx } from './cx';

export interface Brief {
  launchId: string;
  kind: 'ai' | 'rules';
  text: string;
  at: string;
  trace: string[];
  stale?: boolean;
  /** Fresh AI briefs only: run stats and the check against the tracker data. */
  meta?: { ms: number; toolCalls: number };
  check?: BriefCheck;
  /** A real agent run on the untouched demo data, saved earlier today and shown without the passcode. */
  saved?: boolean;
  /** "Linear" or "demo data": what the ids were checked against. */
  checkedAgainst?: string;
}

function Checks({ check, against }: { check: BriefCheck; against: string }) {
  const n = check.cited.length;
  return (
    <p className={cx('checks')}>
      {check.unknown.length ? (
        <span className={cx('bad')}>
          ⚠ {check.unknown.length} issue ID{check.unknown.length > 1 ? 's' : ''} not in {against}: {check.unknown.join(', ')}
        </span>
      ) : (
        <span>
          ✓ {n} issue ID{n === 1 ? '' : 's'} checked against {against}
        </span>
      )}
      {' · '}
      {check.agrees ? (
        <span>✓ call passes the readiness rules</span>
      ) : (
        <span className={cx('bad')}>⚠ readiness rules say {check.rulesCall}</span>
      )}
    </p>
  );
}

export default function BriefPanel({
  brief,
  running,
  agentAvailable,
  onRun,
  decision,
}: {
  brief: Brief;
  running: boolean;
  agentAvailable: boolean;
  onRun: () => void;
  decision?: DecisionProps;
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
            <span>
              {brief.saved ? 'written earlier today (saved run)' : `written ${brief.at}`}
              {brief.meta && ` in ${(brief.meta.ms / 1000).toFixed(1)} s · ${brief.meta.toolCalls} tool call${brief.meta.toolCalls === 1 ? '' : 's'}`}
            </span>
          </>
        ) : (
          <>
            <span className={cx('pill')}>Readiness rules (no AI)</span>
            <span>updates live as tickets move</span>
          </>
        )}
      </div>
      {brief.kind === 'ai' && brief.check && !brief.stale && !running && (
        <Checks check={brief.check} against={brief.checkedAgainst ?? 'the tracker'} />
      )}
      <div className={cx('btns')}>
        <button type="button" className={cx('go', running && 'working')} disabled={running} onClick={onRun}>
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
        {running && !brief.text ? (
          <p className={cx('thinking')}>Reading the tracker and checking each gate…</p>
        ) : (
          <BriefText text={brief.text} />
        )}
        {brief.kind === 'ai' && brief.stale && (
          <p className={cx('stale')}>Tickets may have changed since this brief. Run the agent again for a fresh read.</p>
        )}
      </div>
      {decision && !running && <DecisionBar key={brief.launchId} d={decision} />}
      <p className={cx('how')}>
        The agent is Claude with three read-only tools over the tracker: list_launches, get_gates and list_issues. It
        reads the live data, then writes the brief. The readiness rules make the go/no-go call and check the agent;
        the agent explains it: who has to do what by when, and the update for execs. If Claude can&apos;t be reached, the
        rules write a plain brief from the same data, so the launch review never stalls.
      </p>
    </aside>
  );
}

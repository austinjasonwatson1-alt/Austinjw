'use client';

import { fmtDate } from '@/lib/dates';
import { daysSinceUpdate, isOverdue, STALE_DAYS, STATUS_LABEL, type LaunchInfo, type RiskAlert } from '@/lib/readiness';
import type { Issue } from '@/lib/tracker/types';
import { cx } from './cx';
import ReviewList, { type Outcome } from './ReviewList';

const PILL: Partial<Record<Issue['status'], string>> = { done: 'sD', blocked: 'sX' };

function IssueRow({ i, asOf, onCycle }: { i: Issue; asOf: string; onCycle?: (id: string) => void }) {
  const upd = daysSinceUpdate(i, asOf);
  return (
    <li>
      <code>
        {i.url ? (
          <a className={cx('idlink')} href={i.url} target="_blank" rel="noopener noreferrer">
            {i.id}
          </a>
        ) : (
          i.id
        )}
      </code>
      <span className={cx('it')}>
        {i.title}
        <small>
          {i.owner ? i.owner : <span className={cx('bad')}>No owner</span>}
          {' · '}
          {i.due == null ? (
            <span className={cx('bad')}>No due date</span>
          ) : isOverdue(i, asOf) ? (
            <span className={cx('bad')}>Overdue, was due {fmtDate(i.due)}</span>
          ) : (
            `Due ${fmtDate(i.due)}`
          )}
          {i.status !== 'done' && upd >= STALE_DAYS && (
            <>
              {' · '}
              <span className={cx('bad')}>No update in {upd} days</span>
            </>
          )}
        </small>
      </span>
      {onCycle ? (
        <button
          type="button"
          className={cx('st', PILL[i.status])}
          aria-label={`${i.id} status ${STATUS_LABEL[i.status]}, tap to change`}
          onClick={() => onCycle(i.id)}
        >
          {STATUS_LABEL[i.status]}
        </button>
      ) : (
        <span className={cx('st', 'ro', PILL[i.status])} aria-label={`${i.id} status ${STATUS_LABEL[i.status]}`}>
          {STATUS_LABEL[i.status]}
        </span>
      )}
    </li>
  );
}

export interface AlertProps {
  alerts: RiskAlert[];
  noTicketGates: string[];
  /** True when alerts post to Linear; false when they're only logged (demo data). */
  live: boolean;
  send: (ids: string[]) => Promise<Outcome>;
}

function RiskAlerts({ a, launchId }: { a: AlertProps; launchId: string }) {
  const n = a.noTicketGates.length;
  return (
    <div className={cx('alertbox')}>
      <h3>Risk alerts</h3>
      <ReviewList
        key={launchId}
        items={a.alerts.map((x) => ({ id: x.id, title: x.summary, detail: x.message }))}
        label="Proposed risk alerts"
        openLabel={(k) => `Review ${k} alert${k > 1 ? 's' : ''} to owners`}
        emptyLabel="No owners to alert"
        confirmLabel={(k) => (a.live ? `Send ${k} to Linear` : `Send ${k} alert${k > 1 ? 's' : ''}`)}
        busyLabel="Sending…"
        note={
          (a.live
            ? 'Each alert is posted as a comment on its ticket in Linear, so the owner is notified. Nothing is sent until you confirm.'
            : 'Demo data: alerts are logged, not sent. In Linear mode they post as comments on each ticket.') +
          (n ? ` ${n} at-risk gate${n > 1 ? 's have' : ' has'} no ticket to alert on: someone has to create ${n > 1 ? 'them' : 'it'}.` : '')
        }
        onConfirm={a.send}
      />
    </div>
  );
}

export default function GatesPanel({
  info,
  asOf,
  onCycle,
  alerts,
}: {
  info: LaunchInfo;
  asOf: string;
  /** Omit to show statuses read-only (live Linear data). */
  onCycle?: (id: string) => void;
  /** Shown when the launch has at-risk gates. */
  alerts?: AlertProps;
}) {
  const L = info.launch;
  return (
    <div className={cx('panel')}>
      <div className={cx('lhead')}>
        <div>
          <h2>
            {L.name} · {L.milestone}
          </h2>
          <small>
            Tier {L.tier} · launches {fmtDate(L.launchDate)} · go/no-go {fmtDate(info.goNoGo)} · PM {L.pm ?? 'unassigned'}
          </small>
        </div>
        <small>
          {info.ready} of {info.n} gates ready
        </small>
      </div>
      <div className={cx('meter')}>
        <i style={{ width: `${(info.ready / info.n) * 100}%` }} />
      </div>
      {alerts && <RiskAlerts a={alerts} launchId={L.id} />}
      <div>
        {info.gates.map((g) => (
          <details
            key={`${L.id}-${g.gate.key}`}
            className={cx('gate', g.state)}
            // Focus on what needs action: open the at-risk gates; if none, open what's in progress.
            open={info.risk ? g.state === 'risk' : g.state === 'prog'}
          >
            <summary>
              <span className={cx('dot')} />
              <span className={cx('gn')}>{g.gate.name}</span>
              <span className={cx('gw')}>{g.why}</span>
              <span className={cx('gc')}>
                {g.done}/{g.issues.length}
              </span>
            </summary>
            {g.issues.length ? (
              <ul>
                {g.issues.map((i) => (
                  <IssueRow key={i.id} i={i} asOf={asOf} onCycle={onCycle} />
                ))}
              </ul>
            ) : (
              <p className={cx('none')}>No ticket exists for this gate. Someone has to create and own it.</p>
            )}
          </details>
        ))}
      </div>
      {info.risk > 0 && info.gates.some((g) => g.state === 'prog') && (
        <p className={cx('collapsedNote')}>Gates in progress are collapsed so the risks stand out. Open any gate to see its tickets.</p>
      )}
      <p className={cx('how')}>
        {onCycle
          ? 'Tap a status pill to move an issue along (Backlog → In progress → In review → Done → Blocked). Gates, the calendar and the brief update live.'
          : 'Live from Linear. Change an issue in Linear (tap its id to open it), then refresh to rescore.'}
      </p>
    </div>
  );
}

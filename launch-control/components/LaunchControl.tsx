'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readSse } from '@/lib/agent/sse';
import { localToday } from '@/lib/dates';
import {
  autofix,
  boardSummary,
  hygieneChecks,
  MINUTES_PER_SWEEP,
  NEXT_STATUS,
  rulesBrief,
  type FixAction,
} from '@/lib/readiness';
import { demoSnapshot } from '@/lib/tracker/demo';
import type { TrackerSnapshot } from '@/lib/tracker/types';
import BriefPanel, { type Brief } from './BriefPanel';
import Calendar from './Calendar';
import { cx } from './cx';
import GatesPanel from './GatesPanel';
import HygienePanel, { type LogEntry } from './HygienePanel';

const TRACKER_TIMEOUT_MS = 5_000;
/** A little over the server's 45 s Claude deadline, so the server's own error arrives first. */
const AGENT_TIMEOUT_MS = 50_000;
const CACHE_KEY = (id: string) => `lc-brief-${id}`;

const clock = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** Last good AI brief for a launch (PRD §6), shown as stale until the agent runs again. */
function cachedBrief(launchId: string): Brief | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY(launchId)) || 'null');
    if (c && typeof c.text === 'string') {
      return { launchId, kind: 'ai', text: c.text, at: String(c.at ?? ''), trace: [], stale: true };
    }
  } catch {
    /* storage blocked or corrupt: fall through to the rules brief */
  }
  return null;
}

async function fetchSnapshot(signal: AbortSignal): Promise<TrackerSnapshot> {
  const today = localToday();
  try {
    const res = await fetch(`/api/tracker?source=demo&today=${today}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(TRACKER_TIMEOUT_MS)]),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as TrackerSnapshot;
  } catch (e) {
    if (signal.aborted) throw e;
    return { ...demoSnapshot(today), notice: 'Couldn’t reach the server, so this is the built-in demo data.' };
  }
}

export default function LaunchControl() {
  const [snap, setSnap] = useState<TrackerSnapshot | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [running, setRunning] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState(false);
  const agentCtl = useRef<AbortController | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [saved, setSaved] = useState(0);
  const loadCtl = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadCtl.current?.abort();
    const ctl = (loadCtl.current = new AbortController());
    try {
      const s = await fetchSnapshot(ctl.signal);
      setSnap(s);
      setSel((cur) => (cur && s.launches.some((l) => l.id === cur) ? cur : (boardSummary(s).hotId ?? s.launches[0]?.id ?? null)));
    } catch {
      /* superseded by a newer load */
    }
  }, []);

  useEffect(() => {
    load();
    return () => loadCtl.current?.abort();
  }, [load]);

  useEffect(() => {
    fetch('/api/brief', { signal: AbortSignal.timeout(TRACKER_TIMEOUT_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setAgentAvailable(Boolean(j?.available)))
      .catch(() => setAgentAvailable(false));
    return () => agentCtl.current?.abort();
  }, []);

  const stopAgent = () => {
    agentCtl.current?.abort();
    agentCtl.current = null;
    setRunning(false);
  };

  const summary = useMemo(() => (snap ? boardSummary(snap) : null), [snap]);
  const checks = useMemo(() => (snap ? hygieneChecks(snap.issues, snap.asOf) : []), [snap]);

  const addLog = (entries: FixAction[]) => {
    const at = clock();
    // Newest first, like the prototype's log.
    setLog((l) => [...entries.map((e) => ({ at, text: e.text })).reverse(), ...l]);
    setSaved((m) => m + entries.reduce((a, e) => a + e.minutes, 0));
  };

  if (!snap || !summary) {
    return (
      <section className={cx('band')}>
        <div className={cx('wrap')}>
          <h1>Loading launch readiness</h1>
        </div>
      </section>
    );
  }

  const info = summary.infos.find((x) => x.launch.id === sel) ?? summary.infos[0];
  const L = info?.launch;

  let shown: Brief | null = null;
  if (L) {
    if (brief && brief.launchId === L.id) shown = brief.kind === 'rules' ? { ...brief, text: rulesBrief(L, snap) } : brief;
    else shown = cachedBrief(L.id) ?? { launchId: L.id, kind: 'rules', text: rulesBrief(L, snap), at: clock(), trace: [] };
  }

  const select = (id: string) => {
    if (id === sel) return;
    stopAgent();
    setSel(id);
    setBrief(null);
  };

  const cycleStatus = (id: string) => {
    setSnap((s) =>
      s && {
        ...s,
        issues: s.issues.map((i) => (i.id === id ? { ...i, status: NEXT_STATUS[i.status], updatedAt: s.asOf } : i)),
      },
    );
    if (shown?.kind === 'ai') setBrief({ ...shown, stale: true });
  };

  const rulesFallback = (trace: string, logText: string) => {
    if (!L) return;
    setBrief({ launchId: L.id, kind: 'rules', text: rulesBrief(L, snap), at: clock(), trace: [trace] });
    addLog([{ text: logText, minutes: MINUTES_PER_SWEEP }]);
  };

  const runAgent = async () => {
    if (!L) return;
    if (!agentAvailable) {
      rulesFallback(
        'Claude is not available in this view, so the rules engine wrote this brief.',
        `Readiness check on ${L.name} (rules engine)`,
      );
      return;
    }
    stopAgent();
    const ctl = (agentCtl.current = new AbortController());
    const launch = L;
    const trace: string[] = [];
    const base = { launchId: launch.id, kind: 'ai' as const, at: clock(), stale: false };
    setRunning(true);
    setBrief({ ...base, text: '', trace: [] });
    let failure = 'error';
    try {
      const res = await fetch('/api/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ launchId: launch.id, snapshot: snap }),
        signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(AGENT_TIMEOUT_MS)]),
      });
      if (!res.ok || !res.body) throw new Error(`http_${res.status}`);
      for await (const { event, data } of readSse(res.body)) {
        const d = data as { label?: string; text?: string; code?: string };
        if (event === 'tool' && d.label) {
          trace.push(d.label);
          setBrief((b) => (b && b.launchId === launch.id ? { ...b, trace: [...trace] } : b));
        } else if (event === 'text' && typeof d.text === 'string') {
          setBrief((b) => (b && b.launchId === launch.id ? { ...b, text: d.text! } : b));
        } else if (event === 'done' && typeof d.text === 'string') {
          const at = clock();
          setBrief({ ...base, at, text: d.text, trace: [...trace] });
          try {
            localStorage.setItem(CACHE_KEY(launch.id), JSON.stringify({ text: d.text, at }));
          } catch {
            /* storage blocked: brief still shows */
          }
          addLog([{ text: `Readiness agent briefed ${launch.name}`, minutes: MINUTES_PER_SWEEP }]);
          return;
        } else if (event === 'error') {
          failure = d.code || 'error';
          throw new Error(failure);
        }
      }
      throw new Error('ended_early');
    } catch (e) {
      if (ctl.signal.aborted) return; // superseded by a launch switch or reset
      if (failure === 'error' && e instanceof DOMException && e.name === 'TimeoutError') failure = 'timeout';
      else if (failure === 'error' && e instanceof Error) failure = e.message || 'error';
      rulesFallback(
        `Claude didn't answer (${failure}), so the rules engine wrote this brief.`,
        `Readiness check on ${launch.name} (rules engine fallback)`,
      );
    } finally {
      if (agentCtl.current === ctl) {
        agentCtl.current = null;
        setRunning(false);
      }
    }
  };

  const fix = () => {
    const r = autofix(snap);
    setSnap({ ...snap, issues: r.issues });
    addLog(r.actions);
  };

  const reset = () => {
    stopAgent();
    try {
      snap.launches.forEach((l) => localStorage.removeItem(CACHE_KEY(l.id)));
    } catch {
      /* storage blocked */
    }
    setBrief(null);
    setLog([]);
    setSaved(0);
    load();
  };

  return (
    <>
      <section className={cx('band')}>
        <div className={cx('wrap')}>
          {snap.notice && (
            <p className={cx('notice')} role="status">
              <b>Heads up:</b> {snap.notice}
            </p>
          )}
          <div className={cx('top')}>
            <div>
              <h1>{summary.headline}</h1>
              <p className={cx('sub')}>{summary.sub}</p>
            </div>
            <div className={cx('kpis')}>
              {summary.kpis.map((k) => (
                <div key={k.label} className={cx('kpi', k.tone)}>
                  <b>{k.value}</b>
                  <small>{k.label}</small>
                </div>
              ))}
            </div>
          </div>
          <Calendar summary={summary} asOf={snap.asOf} selected={L?.id ?? ''} onSelect={select} />
        </div>
      </section>

      {info && shown && (
        <section className={cx('band', 'bandTight')}>
          <div className={cx('wrap', 'work')}>
            <GatesPanel info={info} asOf={snap.asOf} onCycle={cycleStatus} />
            <BriefPanel brief={shown} running={running} agentAvailable={agentAvailable} onRun={runAgent} />
          </div>
        </section>
      )}

      <section className={cx('band', 'bandTight')}>
        <HygienePanel
          checks={checks}
          clean={summary.hygiene}
          saved={saved}
          log={log}
          onFix={fix}
          onReset={reset}
        />
      </section>

      <footer className={cx('band', 'bandTight')}>
        <div className={cx('wrap')}>
          Sample data for a fictional product org; dates are relative to today. Built by Austin Watson as a working
          prototype of launch readiness tooling.
        </div>
      </footer>
    </>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readSse } from '@/lib/agent/sse';
import { execUpdate } from '@/lib/brief/parse';
import { verifyBrief } from '@/lib/agent/verify';
import { localToday } from '@/lib/dates';
import {
  autofix,
  boardSummary,
  hygieneChecks,
  MINUTES_PER_SWEEP,
  callToDecision,
  DECISION_LABEL,
  decisionUpdate,
  HEALTH_LABEL,
  MINUTES_PER_FIX,
  recommendation,
  type Decision,
  NEXT_STATUS,
  proposeAlerts,
  proposeFixes,
  rulesBrief,
  type FixAction,
} from '@/lib/readiness';
import { demoSnapshot } from '@/lib/tracker/demo';
import type { SourceKind, TrackerSnapshot } from '@/lib/tracker/types';
import BriefPanel, { type Brief } from './BriefPanel';
import Calendar from './Calendar';
import { cx } from './cx';
import GatesPanel from './GatesPanel';
import type { Recorded } from './DecisionBar';
import HygienePanel, { type LogEntry } from './HygienePanel';
import PasscodeDialog from './PasscodeDialog';

const TRACKER_TIMEOUT_MS = 5_000;
/** A little over the server's 45 s Claude deadline, so the server's own error arrives first. */
const AGENT_TIMEOUT_MS = 50_000;
const AGENT_RUNS_LABEL = '10 agent runs per hour';
const CACHE_KEY = (id: string) => `lc-brief-${id}`;
const SOURCE_KEY = 'lc-source';
const PASS_KEY = 'lc-pass'; // sessionStorage: forgotten when the browser session ends
const minutes = (s: number) => `${Math.max(1, Math.ceil(s / 60))} min`;

const savedSource = (): SourceKind => {
  try {
    return localStorage.getItem(SOURCE_KEY) === 'linear' ? 'linear' : 'demo';
  } catch {
    return 'demo';
  }
};

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

async function fetchSnapshot(source: SourceKind, signal: AbortSignal): Promise<TrackerSnapshot> {
  const today = localToday();
  try {
    // The server enforces Linear's 5 s timeout; the browser allows a little more for the round trip.
    const res = await fetch(`/api/tracker?source=${source}&today=${today}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(TRACKER_TIMEOUT_MS + 2_000)]),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as TrackerSnapshot;
  } catch (e) {
    if (signal.aborted) throw e;
    return { ...demoSnapshot(today), notice: 'Couldn’t reach the server, so this is the built-in sample data.' };
  }
}

export default function LaunchControl() {
  const [snap, setSnap] = useState<TrackerSnapshot | null>(null);
  const [source, setSource] = useState<SourceKind>('demo');
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [running, setRunning] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [passRequired, setPassRequired] = useState(false);
  const [dlg, setDlg] = useState<{ error?: string } | null>(null);
  const passRef = useRef<string | null>(null);
  const askResolve = useRef<((v: string | null) => void) | null>(null);
  const agentCtl = useRef<AbortController | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  /** Alerts sent this session ("source:alert:ISSUE"), hidden from the review list so nobody is chased twice. */
  const [alerted, setAlerted] = useState<Set<string>>(new Set());
  /** Decisions recorded this session, keyed "source:launchId". */
  const [decisions, setDecisions] = useState<Record<string, Recorded>>({});
  /** Demo data exactly as loaded (no ticket edits or fixes yet): the saved agent briefs still match it. */
  const [pristine, setPristine] = useState(true);
  const [samples, setSamples] = useState<Record<string, Brief>>({});
  const [saved, setSaved] = useState(0);
  const loadCtl = useRef<AbortController | null>(null);

  const load = useCallback(async (src: SourceKind) => {
    loadCtl.current?.abort();
    const ctl = (loadCtl.current = new AbortController());
    setLoading(true);
    try {
      const s = await fetchSnapshot(src, ctl.signal);
      setSnap(s);
      setSel((cur) => (cur && s.launches.some((l) => l.id === cur) ? cur : (boardSummary(s).hotId ?? s.launches[0]?.id ?? null)));
    } catch {
      /* superseded by a newer load */
    } finally {
      if (loadCtl.current === ctl) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Demo data is the default; a returning visitor gets the source they last chose.
    const src = savedSource();
    setSource(src);
    load(src);
    return () => loadCtl.current?.abort();
  }, [load]);

  useEffect(() => {
    fetch('/api/brief', { signal: AbortSignal.timeout(TRACKER_TIMEOUT_MS) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        setAgentAvailable(Boolean(j?.available));
        setPassRequired(Boolean(j?.passcodeRequired));
      })
      .catch(() => setAgentAvailable(false));
    return () => agentCtl.current?.abort();
  }, []);

  useEffect(() => {
    try {
      passRef.current = sessionStorage.getItem(PASS_KEY);
    } catch {
      /* storage blocked: we'll ask */
    }
  }, []);

  const askPasscode = (error?: string) =>
    new Promise<string | null>((resolve) => {
      askResolve.current = resolve;
      setDlg({ error });
    });
  const closeDialog = (value: string | null) => {
    setDlg(null);
    askResolve.current?.(value);
    askResolve.current = null;
  };

  /**
   * POST with the demo passcode. Asks for it first if needed, and again (up to 3 tries) if the
   * server rejects it. Resolves to null if the person cancels.
   */
  const postGuarded = async (url: string, body: unknown, signal: AbortSignal): Promise<Response | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (passRequired && !passRef.current) {
        const p = await askPasscode(attempt ? 'That passcode didn’t work. Try again.' : undefined);
        if (!p) return null;
        passRef.current = p;
        try {
          sessionStorage.setItem(PASS_KEY, p);
        } catch {
          /* keep it in memory only */
        }
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(passRef.current ? { 'x-demo-passcode': passRef.current } : {}) },
        body: JSON.stringify(body),
        signal,
      });
      if (res.status !== 401) return res;
      passRef.current = null;
      try {
        sessionStorage.removeItem(PASS_KEY);
      } catch {
        /* nothing stored */
      }
      if (!passRequired) setPassRequired(true); // server config changed since load
    }
    return null;
  };

  const stopAgent = () => {
    agentCtl.current?.abort();
    agentCtl.current = null;
    setRunning(false);
  };

  // Visitors without the passcode still see Claude's work: a saved agent run for the untouched demo data.
  useEffect(() => {
    if (!snap || snap.source !== 'demo' || !pristine || !sel || !agentAvailable) return;
    const key = `${snap.asOf}:${sel}`;
    if (samples[key]) return;
    const launch = snap.launches.find((l) => l.id === sel);
    if (!launch) return;
    const ctl = new AbortController();
    fetch(`/api/brief/sample?launch=${encodeURIComponent(sel)}&today=${snap.asOf}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { text?: string; ms?: number; toolCalls?: number; trace?: string[]; asOf?: string } | null) => {
        if (!j?.text || j.asOf !== snap.asOf) return;
        const text = j.text;
        setSamples((m) => ({
          ...m,
          [key]: {
            launchId: sel,
            kind: 'ai',
            text,
            at: '',
            trace: j.trace ?? [],
            saved: true,
            meta: { ms: j.ms ?? 0, toolCalls: j.toolCalls ?? 0 },
            check: verifyBrief(text, snap, launch),
            checkedAgainst: 'sample data',
          },
        }));
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [snap, sel, pristine, agentAvailable, samples]);

  const summary = useMemo(() => (snap ? boardSummary(snap) : null), [snap]);
  const checks = useMemo(() => (snap ? hygieneChecks(snap.issues, snap.asOf) : []), [snap]);
  const proposed = useMemo(() => (snap ? proposeFixes(snap) : { fixes: [], unlinked: 0 }), [snap]);
  /** Manual work waiting right now, from the data on screen: one sweep per launch, plus each proposed fix and alert. */
  const waiting = useMemo(() => {
    if (!snap) return { minutes: 0, sweeps: 0, fixes: 0, alerts: 0 };
    const alerts = snap.launches.reduce((n, l) => n + proposeAlerts(snap, l).alerts.length, 0);
    const sweeps = snap.launches.length;
    const fixes = proposed.fixes.length;
    return { minutes: sweeps * MINUTES_PER_SWEEP + (fixes + alerts) * MINUTES_PER_FIX, sweeps, fixes, alerts };
  }, [snap, proposed]);

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

  /** True only when the data on screen really came from Linear (not a demo fallback). */
  const live = snap.source === 'linear';
  const info = summary.infos.find((x) => x.launch.id === sel) ?? summary.infos[0];
  const L = info?.launch;

  let shown: Brief | null = null;
  if (L) {
    if (brief && brief.launchId === L.id) shown = brief.kind === 'rules' ? { ...brief, text: rulesBrief(L, snap) } : brief;
    else
      shown =
        cachedBrief(L.id) ??
        (snap.source === 'demo' && pristine ? samples[`${snap.asOf}:${L.id}`] : undefined) ?? {
          launchId: L.id,
          kind: 'rules',
          text: rulesBrief(L, snap),
          at: clock(),
          trace: [],
        };
  }

  const switchSource = (src: SourceKind) => {
    if (src === source) return;
    try {
      localStorage.setItem(SOURCE_KEY, src);
    } catch {
      /* storage blocked: choice lasts for this page view */
    }
    stopAgent();
    setBrief(null);
    setSource(src);
    load(src);
  };

  const select = (id: string) => {
    if (id === sel) return;
    stopAgent();
    setSel(id);
    setBrief(null);
  };

  const cycleStatus = (id: string) => {
    setPristine(false);
    setSnap((s) =>
      s && {
        ...s,
        issues: s.issues.map((i) => (i.id === id ? { ...i, status: NEXT_STATUS[i.status], updatedAt: s.asOf } : i)),
      },
    );
    // A live agent brief is kept and marked stale; a saved sample no longer applies, so the rules brief takes over.
    if (shown?.kind === 'ai' && !shown.saved) setBrief({ ...shown, stale: true });
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
    if (passRequired && !passRef.current) {
      const p = await askPasscode();
      if (!p) return;
      passRef.current = p;
      try {
        sessionStorage.setItem(PASS_KEY, p);
      } catch {
        /* keep it in memory only */
      }
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
      const res = await postGuarded(
        '/api/brief',
        // Live data: the server reads Linear itself. Demo: send what's on screen.
        live ? { launchId: launch.id, source: 'linear', asOf: snap.asOf } : { launchId: launch.id, snapshot: snap },
        AbortSignal.any([ctl.signal, AbortSignal.timeout(AGENT_TIMEOUT_MS)]),
      );
      if (!res) {
        // Passcode cancelled: put back whatever brief was showing and run nothing.
        setBrief(null);
        return;
      }
      if (res.status === 429) {
        const j = (await res.json().catch(() => ({}))) as { retryAfter?: number };
        failure = `rate limit: ${AGENT_RUNS_LABEL}, try again in ${minutes(j.retryAfter ?? 3600)}`;
        throw new Error(failure);
      }
      if (!res.ok || !res.body) throw new Error(`http_${res.status}`);
      for await (const { event, data } of readSse(res.body)) {
        const d = data as { label?: string; text?: string; code?: string; ms?: number; toolCalls?: number };
        if (event === 'tool' && d.label) {
          trace.push(d.label);
          setBrief((b) => (b && b.launchId === launch.id ? { ...b, trace: [...trace] } : b));
        } else if (event === 'text' && typeof d.text === 'string') {
          setBrief((b) => (b && b.launchId === launch.id ? { ...b, text: d.text! } : b));
        } else if (event === 'done' && typeof d.text === 'string') {
          const at = clock();
          setBrief({
            ...base,
            at,
            text: d.text,
            trace: [...trace],
            meta: { ms: d.ms ?? 0, toolCalls: d.toolCalls ?? trace.length },
            // In live mode the server read Linear moments ago; the screen's snapshot is the same data.
            check: verifyBrief(d.text, snap, launch),
            checkedAgainst: live ? 'Linear' : 'sample data',
          });
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
      else if (failure === 'error' && e instanceof TypeError) failure = navigator.onLine === false ? 'offline' : 'network';
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
    setPristine(false);
    const r = autofix(snap);
    setSnap({ ...snap, issues: r.issues });
    addLog(r.actions);
  };

  /** Linear mode: write the confirmed fixes, log the outcome, then reload from Linear. */
  const applyLinearFixes = async (ids: string[]): Promise<{ ok: boolean; message: string }> => {
    try {
      const res = await postGuarded('/api/hygiene/apply', { asOf: snap.asOf, fixIds: ids }, AbortSignal.timeout(60_000));
      if (!res) return { ok: false, message: 'Nothing was written: the passcode was not entered.' };
      const j = (await res.json().catch(() => ({}))) as {
        results?: { ok: boolean; text: string; id: string; error?: string }[];
        skipped?: string[];
        error?: string;
        retryAfter?: number;
      };
      if (!res.ok || !j.results) {
        const why =
          j.error === 'rate_limited'
            ? `too many changes from this network this hour; try again in ${minutes(j.retryAfter ?? 3600)}`
            : j.error === 'linear_unavailable'
              ? 'Linear didn’t answer'
              : j.error === 'linear_not_configured'
                ? 'Linear isn’t configured on this server'
                : (j.error ?? `HTTP ${res.status}`);
        addLog([{ text: `Linear fixes not applied: ${why}`, minutes: 0 }]);
        return { ok: false, message: `Nothing was written: ${why}.` };
      }
      const good = j.results.filter((r) => r.ok);
      const bad = j.results.filter((r) => !r.ok);
      const entries: FixAction[] = [
        ...good.map((r) => ({ text: `${r.text} in Linear`, minutes: MINUTES_PER_FIX })),
        ...bad.map((r) => ({ text: `Couldn’t apply in Linear: ${r.text} (${r.error ?? 'error'})`, minutes: 0 })),
      ];
      if (j.skipped?.length) entries.push({ text: `Skipped ${j.skipped.length} fix${j.skipped.length > 1 ? 'es' : ''} already handled in Linear`, minutes: 0 });
      if (proposed.unlinked) entries.push({ text: `Left ${proposed.unlinked} unlinked ticket${proposed.unlinked > 1 ? 's' : ''} for a human to triage`, minutes: 0 });
      addLog(entries);
      await load('linear');
      return {
        ok: !bad.length,
        message: `Wrote ${good.length} fix${good.length === 1 ? '' : 'es'} to Linear${bad.length ? `; ${bad.length} failed (see log)` : ''}${j.skipped?.length ? `; ${j.skipped.length} already handled` : ''}.`,
      };
    } catch {
      addLog([{ text: 'Linear fixes not applied: the request failed', minutes: 0 }]);
      return { ok: false, message: 'Nothing was confirmed as written: the request failed. Refresh to check Linear.' };
    }
  };

  const sendAlerts = async (ids: string[]): Promise<{ ok: boolean; message: string }> => {
    if (!L) return { ok: false, message: 'No launch selected.' };
    const all = proposeAlerts(snap, L).alerts;
    const mark = (sent: string[]) => setAlerted((s) => new Set([...s, ...sent.map((id) => `${snap.source}:${id}`)]));
    if (!live) {
      const sent = all.filter((a) => ids.includes(a.id));
      addLog(sent.map((a) => ({ text: `Alerted ${a.logText}`, minutes: MINUTES_PER_FIX })));
      mark(sent.map((a) => a.id));
      return { ok: true, message: `Logged ${sent.length} alert${sent.length === 1 ? '' : 's'} (sample data: nothing was sent).` };
    }
    try {
      const res = await postGuarded('/api/alerts/send', { launchId: L.id, asOf: snap.asOf, alertIds: ids }, AbortSignal.timeout(60_000));
      if (!res) return { ok: false, message: 'Nothing was sent: the passcode was not entered.' };
      const j = (await res.json().catch(() => ({}))) as {
        results?: { ok: boolean; text: string; id: string; error?: string }[];
        skipped?: string[];
        error?: string;
        retryAfter?: number;
      };
      if (!res.ok || !j.results) {
        const why = j.error === 'rate_limited' ? `too many sends from this network; try again in ${minutes(j.retryAfter ?? 3600)}` : j.error === 'linear_unavailable' ? 'Linear didn’t answer' : (j.error ?? `HTTP ${res.status}`);
        addLog([{ text: `Risk alerts not sent: ${why}`, minutes: 0 }]);
        return { ok: false, message: `Nothing was sent: ${why}.` };
      }
      const good = j.results.filter((r) => r.ok);
      const bad = j.results.filter((r) => !r.ok);
      addLog([
        ...good.map((r) => ({ text: `Alerted ${r.text} in Linear`, minutes: MINUTES_PER_FIX })),
        ...bad.map((r) => ({ text: `Didn’t alert ${r.text}: ${r.error ?? 'error'}`, minutes: 0 })),
      ]);
      mark([...good, ...bad.filter((r) => /already alerted/.test(r.error ?? ''))].map((r) => r.id));
      const dup = bad.filter((r) => /already alerted/.test(r.error ?? '')).length;
      return {
        ok: bad.length === dup,
        message: `Sent ${good.length} alert${good.length === 1 ? '' : 's'} to Linear${dup ? `; ${dup} already alerted in the last 24 h` : ''}${bad.length - dup ? `; ${bad.length - dup} failed (see log)` : ''}${j.skipped?.length ? `; ${j.skipped.length} no longer at risk` : ''}.`,
      };
    } catch {
      addLog([{ text: 'Risk alerts not sent: the request failed', minutes: 0 }]);
      return { ok: false, message: 'Nothing was confirmed as sent: the request failed.' };
    }
  };

  const recordDecision = async (d: Decision, note: string): Promise<{ ok: boolean; message: string }> => {
    if (!L || !shown) return { ok: false, message: 'No launch selected.' };
    const key = `${snap.source}:${L.id}`;
    const exec = execUpdate(shown.text);
    const label = DECISION_LABEL[d];
    if (!live) {
      setDecisions((m) => ({ ...m, [key]: { decision: d, at: clock(), posted: false } }));
      addLog([{ text: `Recorded go/no-go for ${L.name}: ${label} (sample data: not posted)`, minutes: 0 }]);
      return { ok: true, message: 'Recorded.' };
    }
    try {
      const res = await postGuarded('/api/decision', { launchId: L.id, asOf: snap.asOf, decision: d, note, execUpdate: exec }, AbortSignal.timeout(30_000));
      if (!res) return { ok: false, message: 'Nothing was posted: the passcode was not entered.' };
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; health?: keyof typeof HEALTH_LABEL; error?: string; retryAfter?: number };
      if (!res.ok || !j.ok) {
        const why = j.error === 'rate_limited' ? `too many posts from this network; try again in ${minutes(j.retryAfter ?? 3600)}` : j.error === 'linear_unavailable' || j.error === 'linear_write_failed' ? 'Linear didn’t accept it' : (j.error ?? `HTTP ${res.status}`);
        addLog([{ text: `Go/no-go for ${L.name} not posted: ${why}`, minutes: 0 }]);
        return { ok: false, message: `Nothing was posted: ${why}.` };
      }
      setDecisions((m) => ({ ...m, [key]: { decision: d, at: clock(), posted: true, url: j.url } }));
      addLog([{ text: `Posted go/no-go for ${L.name} to Linear: ${label}${j.health ? ` (health: ${HEALTH_LABEL[j.health]})` : ''}`, minutes: 0 }]);
      return { ok: true, message: 'Posted.' };
    } catch {
      addLog([{ text: `Go/no-go for ${L.name} not posted: the request failed`, minutes: 0 }]);
      return { ok: false, message: 'Nothing was confirmed as posted: the request failed.' };
    }
  };

  const reset = () => {
    stopAgent();
    setAlerted(new Set());
    setDecisions({});
    setPristine(true);
    try {
      snap.launches.forEach((l) => localStorage.removeItem(CACHE_KEY(l.id)));
    } catch {
      /* storage blocked */
    }
    setBrief(null);
    setLog([]);
    setSaved(0);
    load('demo');
  };

  return (
    <>
      <header className={cx('topbar')}>
        <div className={cx('topin')}>
        <a className={cx('brand')} href="/" aria-label="Launch Control home">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="#0f2f52" />
            <rect x="10" y="26" width="9" height="12" rx="2" fill="#8fd3ff" />
            <rect x="21" y="26" width="9" height="12" rx="2" fill="#8fd3ff" />
            <rect x="32" y="26" width="9" height="12" rx="2" fill="#ff5c8a" />
            <rect x="44" y="21" width="15" height="15" transform="rotate(45 51.5 32)" fill="#0f2f52" stroke="#ff5c8a" strokeWidth="3.5" />
          </svg>
          <span>
            <b>Launch Control</b>
            <small>Launch readiness and go/no-go</small>
          </span>
        </a>
        <div className={cx('topright')}>
          <div className={cx('srcbar')}>
            <span id="src-label">Data source</span>
            <span className={cx('toggle')} role="group" aria-labelledby="src-label">
              <button type="button" aria-pressed={source === 'linear'} onClick={() => switchSource('linear')}>
                Live data (Linear)
              </button>
              <button type="button" aria-pressed={source === 'demo'} onClick={() => switchSource('demo')}>
                Sample data
              </button>
            </span>
            {source === 'linear' && (
              <button type="button" className={cx('refresh')} onClick={() => load('linear')} disabled={loading}>
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            )}
            {source === 'demo' && loading && <span role="status">Loading…</span>}
          </div>
          <a className={cx('toplink')} href="/one-pager">
            One-pager
          </a>
        </div>
        </div>
      </header>

      <section className={cx('band')}>
        <div className={cx('wrap')}>
          {snap.notice && (
            <p className={cx('notice')} role="status">
              <b>Heads up:</b> {snap.notice}
            </p>
          )}
          <p className={cx('step')}>
            <b>1</b> Which launches are at risk
          </p>
          <p className={cx('intro')}>
            {live
              ? `Live from Linear: ${snap.launches.length} upcoming launches.`
              : `A sample product org with ${snap.launches.length} upcoming launches.`}{' '}
            Each launch must pass a set of readiness gates (checkpoints like QA sign-off, security review and docs) before its
            go/no-go review.
          </p>
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
          <p className={cx('wrap', 'step')}>
            <b>2</b> Why, and what to do about it
          </p>
          <div className={cx('wrap', 'work')}>
            <GatesPanel
              info={info}
              asOf={snap.asOf}
              onCycle={live ? undefined : cycleStatus}
              alerts={
                info.risk
                  ? (() => {
                      const p = proposeAlerts(snap, info.launch);
                      return {
                        alerts: p.alerts.filter((a) => !alerted.has(`${snap.source}:${a.id}`)),
                        noTicketGates: p.noTicketGates,
                        live,
                        send: sendAlerts,
                      };
                    })()
                  : undefined
              }
            />
            <BriefPanel
              brief={shown}
              running={running}
              agentAvailable={agentAvailable}
              onRun={runAgent}
              decision={{
                launchName: info.launch.name,
                suggested: callToDecision(recommendation(info.state)),
                live,
                recorded: decisions[`${snap.source}:${info.launch.id}`],
                preview: (d, note) => decisionUpdate(info.launch, snap, d, { note, execUpdate: execUpdate(shown.text) }),
                record: recordDecision,
              }}
            />
          </div>
        </section>
      )}

      <section className={cx('band', 'bandTight')}>
        <p className={cx('wrap', 'step')}>
          <b>3</b> Keep the tracker data clean, so reports can come straight from it
        </p>
        <HygienePanel
          checks={checks}
          clean={summary.hygiene}
          saved={saved}
          waiting={waiting}
          log={log}
          onFix={live ? undefined : fix}
          onReset={live ? undefined : reset}
          live={live ? { fixes: proposed.fixes, apply: applyLinearFixes } : undefined}
        />
      </section>

      <PasscodeDialog open={dlg != null} error={dlg?.error} onSubmit={(p) => closeDialog(p)} onCancel={() => closeDialog(null)} />

      <footer className={cx('band', 'bandTight')}>
        <div className={cx('wrap')}>
          {live
            ? 'Live data from Linear, seeded with a fictional product org. Built by Austin Watson as a working prototype of launch readiness tooling.'
            : 'Sample data for a fictional product org; dates are relative to today. Built by Austin Watson as a working prototype of launch readiness tooling.'}{' '}
          <a href="/one-pager" style={{ color: 'var(--sky)' }}>
            One-pager
          </a>
        </div>
      </footer>
    </>
  );
}

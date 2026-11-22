"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { flush, pendingCount, saveChunk, saveFinish, type FinishResult } from "@/client/queue";
import { primeTones, startTone, stopTone } from "@/client/tones";
import { Mic } from "./Icons";

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "recording"; startedAt: number }
  | { kind: "finishing" }
  | { kind: "done"; result: FinishResult; cutShort?: number }
  | { kind: "saved"; cutShort?: number }
  | { kind: "error"; message: string };

type Session = {
  rec: MediaRecorder;
  stream: MediaStream;
  id: string;
  seq: number;
  saves: Promise<void>[];
  startedAt: number;
  hiddenAt?: number;
  userStopped: boolean;
  ctx?: AudioContext;
  raf?: number;
  lock?: WakeLockSentinel | null;
};

const SLICE_MS = 5000; // upload a piece every five seconds

function pickMime(): string {
  const options = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return options.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function Recorder() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [pending, setPending] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const live = useRef<Session | null>(null);

  const refreshPending = useCallback(async () => {
    try {
      const p = await pendingCount();
      setPending(p.finishes);
    } catch {
      /* private mode etc. */
    }
  }, []);

  // The nav bar uploads anything left on the phone; refresh the waiting count when it does.
  useEffect(() => {
    refreshPending();
    window.addEventListener("wr:changed", refreshPending);
    const t = setInterval(refreshPending, 5000);
    return () => {
      window.removeEventListener("wr:changed", refreshPending);
      clearInterval(t);
    };
  }, [refreshPending]);

  // Hands-free start: opening the app at /?start=1 (from a Siri Shortcut or a
  // home-screen bookmark) starts recording straight away. If the phone insists
  // on a tap first, the normal button is right there.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.get("start") !== "1") return;
    url.searchParams.delete("start");
    window.history.replaceState(null, "", url.pathname + url.search);
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.kind !== "recording") return;
    const t = setInterval(() => setElapsed(Date.now() - state.startedAt), 250);
    return () => clearInterval(t);
  }, [state]);

  // Keep the screen awake while recording; re-acquire it when the app comes back.
  // Also note when the app was hidden: iPhone usually stops a web app's recording
  // when the screen locks or you switch apps, and we want to say so honestly.
  useEffect(() => {
    const onVis = async () => {
      const s = live.current;
      if (!s) return;
      if (document.visibilityState === "hidden") {
        s.hiddenAt ??= Date.now();
        s.lock = null; // the system releases the wake lock when hidden
        return;
      }
      const micEnded = s.stream.getAudioTracks().every((t) => t.readyState === "ended");
      if (micEnded && s.rec.state !== "inactive") {
        s.rec.stop(); // recording can't continue; finish with what we have
        return;
      }
      s.hiddenAt = undefined; // still recording after coming back: nothing was lost
      s.lock = (await navigator.wakeLock?.request("screen").catch(() => null)) ?? null;
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  async function start() {
    if (live.current) return;
    setState({ kind: "starting" });
    primeTones();
    await startTone(); // before the mic opens, so the cue isn't recorded
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setState({
        kind: "error",
        message: "Writer's Room needs the microphone. Allow it in your browser's settings, then try again.",
      });
      return;
    }
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
    const session: Session = {
      rec,
      stream,
      id: crypto.randomUUID(),
      seq: 0,
      saves: [] as Promise<void>[],
      startedAt: Date.now(),
      userStopped: false,
      lock: null,
    };
    live.current = session;

    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      const seq = session.seq++;
      const p = saveChunk(session.id, seq, e.data).then(() => {
        flush().catch(() => {});
      });
      session.saves.push(p);
    };
    rec.onstop = () => finalize(session);
    rec.onerror = () => rec.state !== "inactive" && rec.stop();
    // A phone call, Siri or another app taking the mic ends the track.
    stream.getAudioTracks().forEach((t) =>
      t.addEventListener("ended", () => rec.state !== "inactive" && rec.stop()),
    );
    rec.start(SLICE_MS);

    session.lock = (await navigator.wakeLock?.request("screen").catch(() => null)) ?? null;
    meter(session);
    setElapsed(0);
    setState({ kind: "recording", startedAt: session.startedAt });
  }

  function meter(session: Session) {
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(session.stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      session.ctx = ctx;
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += (v - 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / buf.length) / 40);
        button.current?.style.setProperty("--level", level.toFixed(3));
        session.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* the meter is decoration; recording works without it */
    }
  }

  function stop() {
    const s = live.current;
    if (!s || s.rec.state === "inactive") return;
    s.userStopped = true;
    s.rec.stop();
  }

  async function finalize(session: Session) {
    live.current = null;
    session.stream.getTracks().forEach((t) => t.stop());
    if (session.raf) cancelAnimationFrame(session.raf);
    session.ctx?.close().catch(() => {});
    session.lock?.release().catch(() => {});
    stopTone();
    setState({ kind: "finishing" });
    // If you didn't tap stop, the recording ended on its own (screen lock, app switch,
    // phone call). If the app was hidden, audio stopped then; otherwise it stopped now.
    const endedAt = session.userStopped ? Date.now() : (session.hiddenAt ?? Date.now());
    const cutShort = session.userStopped ? undefined : endedAt - session.startedAt;
    try {
      await Promise.all(session.saves);
      if (session.seq === 0) {
        setState({ kind: "error", message: "That recording was too short to hear anything. Try again." });
        return;
      }
      await saveFinish({
        captureId: session.id,
        chunkCount: session.seq,
        durationMs: endedAt - session.startedAt,
        mimeType: session.rec.mimeType || "audio/webm",
      });
      const results = await flush(() => window.dispatchEvent(new Event("wr:changed")));
      const mine = results.find((r) => r.captureId === session.id);
      setState(mine ? { kind: "done", result: mine, cutShort } : { kind: "saved", cutShort });
    } catch {
      setState({ kind: "saved", cutShort });
    } finally {
      refreshPending();
    }
  }

  const recording = state.kind === "recording";
  const busy = state.kind === "starting" || state.kind === "finishing";
  // Computed on the phone (not on the server or at build time) so it's always today, in your time zone.
  const [today, setToday] = useState("");
  useEffect(() => {
    const set = () => setToday(new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
    set();
    const t = setInterval(set, 60000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="home">
      <div className="home-top">
        <span className="wordmark">Writer&rsquo;s Room</span>
        <span className="home-date">{today}</span>
      </div>

      <div className="home-hero">
        <h1 className="display">{recording ? "Listening." : "Talk it out."}</h1>
        <p className="muted" style={{ margin: "8px 0 0" }}>
          {recording ? "Take your time. Every few seconds is saved as you go." : "Your words, kept the way you said them."}
        </p>
      </div>

      <div className="stage" data-compact={["done", "saved", "error"].includes(state.kind) || undefined}>
        <button
          ref={button}
          type="button"
          className="record"
          data-state={recording ? "recording" : busy ? "busy" : "idle"}
          onClick={recording ? stop : start}
          disabled={busy}
          aria-label={recording ? "Stop recording" : "Start recording"}
        >
          {recording ? <span className="stop" /> : <Mic className="" />}
        </button>

        {recording && (
          <>
            <div className="timer" aria-live="off">
              {fmt(elapsed)}
            </div>
            <div className="stage-caption">
              <p>
                Say <span className="say">&ldquo;new note&rdquo;</span> to start another idea.
              </p>
            </div>
          </>
        )}

        {state.kind === "idle" && (
          <div className="stage-caption">
            <strong>Tap to start talking</strong>
            <p>
              Say <span className="say">&ldquo;new note&rdquo;</span> between ideas. Start with{" "}
              <span className="say">&ldquo;scene note&rdquo;</span> or{" "}
              <span className="say">&ldquo;character note&rdquo;</span> to label one.
            </p>
          </div>
        )}

        {busy && (
          <div className="stage-caption" style={{ display: "grid", justifyItems: "center", gap: 14 }}>
            <strong>{state.kind === "starting" ? "Getting the mic ready…" : "Writing down your words…"}</strong>
            <div className="shimmer" />
          </div>
        )}

        {(state.kind === "done" || state.kind === "saved") && state.cutShort != null && (
          <div className="notice warn" style={{ width: "100%" }} role="status">
            <p>
              <strong>Recording stopped on its own at {fmt(state.cutShort)}.</strong> The screen probably locked or
              another app took over. Everything up to then is saved.
            </p>
          </div>
        )}

        {state.kind === "done" && <Result result={state.result} onAgain={() => setState({ kind: "idle" })} />}

        {state.kind === "saved" && (
          <div className="notice" style={{ width: "100%" }}>
            <p>
              <strong>Saved on this phone.</strong> No signal right now, so it will upload and transcribe the next
              time Writer&rsquo;s Room is open with a connection.
            </p>
            <div className="row">
              <button className="btn" type="button" onClick={() => setState({ kind: "idle" })}>
                Record another
              </button>
            </div>
          </div>
        )}

        {state.kind === "error" && (
          <div className="notice" style={{ width: "100%" }}>
            <p>{state.message}</p>
            <div className="row">
              <button className="btn" type="button" onClick={() => setState({ kind: "idle" })}>
                OK
              </button>
            </div>
          </div>
        )}
      </div>

      {pending > 0 && !recording && (
        <div className="status-line" style={{ justifyContent: "center" }}>
          <span className="dot wait" /> {pending === 1 ? "1 recording" : `${pending} recordings`} waiting to upload
        </div>
      )}
    </div>
  );
}

function Result({ result, onAgain }: { result: FinishResult; onAgain: () => void }) {
  if (result.ok && result.status === "ready") {
    const n = result.noteCount ?? 0;
    return (
      <div style={{ width: "100%", display: "grid", gap: 12 }}>
        <Link href="/inbox" className="result-card">
          <span className="count tabular">{n}</span>
          <span className="grow">
            <strong>{n === 1 ? "note" : "notes"} ready to review</strong>
            <br />
            <span className="muted" style={{ fontSize: 14 }}>
              In your Inbox, in your own words.
            </span>
          </span>
          <span aria-hidden style={{ fontSize: 22 }}>→</span>
        </Link>
        <button className="btn btn-ghost" type="button" onClick={onAgain}>
          Record another
        </button>
      </div>
    );
  }
  const message =
    result.status === "empty"
      ? "We didn't catch any words in that one. The recording is in your Inbox if you want to check it."
      : `Couldn't transcribe that yet. The recording is safe in your Inbox, where you can try again. (${result.error ?? "unknown error"})`;
  return (
    <div className="notice" style={{ width: "100%" }}>
      <p>{message}</p>
      <div className="row">
        <Link className="btn" href="/inbox">
          Open Inbox
        </Link>
        <button className="btn btn-ghost" type="button" onClick={onAgain}>
          Record another
        </button>
      </div>
    </div>
  );
}

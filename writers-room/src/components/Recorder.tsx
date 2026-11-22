"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { flush, pendingCount, saveChunk, saveFinish, type FinishResult } from "@/client/queue";
import { Mic } from "./Icons";

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "recording"; startedAt: number }
  | { kind: "finishing" }
  | { kind: "done"; result: FinishResult }
  | { kind: "saved" }
  | { kind: "error"; message: string };

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
  const live = useRef<{
    rec: MediaRecorder;
    stream: MediaStream;
    id: string;
    seq: number;
    saves: Promise<void>[];
    startedAt: number;
    ctx?: AudioContext;
    raf?: number;
    lock?: WakeLockSentinel | null;
  } | null>(null);

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

  useEffect(() => {
    if (state.kind !== "recording") return;
    const t = setInterval(() => setElapsed(Date.now() - state.startedAt), 250);
    return () => clearInterval(t);
  }, [state]);

  // Keep the screen awake while recording; re-acquire it when the app comes back.
  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState === "visible" && live.current && !live.current.lock) {
        live.current.lock = await navigator.wakeLock?.request("screen").catch(() => null);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  async function start() {
    setState({ kind: "starting" });
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
    const session = {
      rec,
      stream,
      id: crypto.randomUUID(),
      seq: 0,
      saves: [] as Promise<void>[],
      startedAt: Date.now(),
      lock: null as WakeLockSentinel | null,
    } as NonNullable<typeof live.current>;
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
    rec.start(SLICE_MS);

    session.lock = (await navigator.wakeLock?.request("screen").catch(() => null)) ?? null;
    meter(session);
    setElapsed(0);
    setState({ kind: "recording", startedAt: session.startedAt });
  }

  function meter(session: NonNullable<typeof live.current>) {
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
    if (s && s.rec.state !== "inactive") s.rec.stop();
  }

  async function finalize(session: NonNullable<typeof live.current>) {
    live.current = null;
    session.stream.getTracks().forEach((t) => t.stop());
    if (session.raf) cancelAnimationFrame(session.raf);
    session.ctx?.close().catch(() => {});
    session.lock?.release().catch(() => {});
    setState({ kind: "finishing" });
    try {
      await Promise.all(session.saves);
      if (session.seq === 0) {
        setState({ kind: "error", message: "That recording was too short to hear anything. Try again." });
        return;
      }
      await saveFinish({
        captureId: session.id,
        chunkCount: session.seq,
        durationMs: Date.now() - session.startedAt,
        mimeType: session.rec.mimeType || "audio/webm",
      });
      const results = await flush(() => window.dispatchEvent(new Event("wr:changed")));
      const mine = results.find((r) => r.captureId === session.id);
      setState(mine ? { kind: "done", result: mine } : { kind: "saved" });
    } catch {
      setState({ kind: "saved" });
    } finally {
      refreshPending();
    }
  }

  const recording = state.kind === "recording";
  const busy = state.kind === "starting" || state.kind === "finishing";
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

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

      <div className="stage">
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

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, Mic, More, Pause, Pen, Play, Trash } from "./Icons";

type Note = {
  id: string;
  body: string;
  source: "spoken" | "typed" | "ai_suggestion";
  status: "review" | "confirmed";
  spoken_label: string | null;
  capture_id: string | null;
  raw_text: string | null;
  cleanup: string | null;
  keep_audio: boolean;
  created_at: string;
};
type Capture = {
  id: string;
  status: "recording" | "processing" | "ready" | "empty" | "failed";
  duration_ms: number | null;
  error: string | null;
  has_audio: boolean;
  created_at: string;
};

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
};
const length = (ms: number | null) => {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} sec` : `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} sec` : ""}`.trim();
};

export function Inbox() {
  const [data, setData] = useState<{ captures: Capture[]; notes: Note[] } | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/notes", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) {
      setError("Couldn't load your Inbox. Check your connection and pull to refresh.");
      return;
    }
    setError("");
    setData(await res.json());
  }, []);

  useEffect(() => {
    load();
    window.addEventListener("wr:changed", load);
    window.addEventListener("focus", load);
    return () => {
      window.removeEventListener("wr:changed", load);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  // Keep polling while something is still being transcribed.
  useEffect(() => {
    if (!data?.captures.some((c) => c.status === "processing" || c.status === "recording")) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [data, load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const mutate = useCallback(
    async (url: string, init: RequestInit, message?: string) => {
      const res = await fetch(url, init).catch(() => null);
      if (!res?.ok) {
        setToast("That didn't save. Try again.");
        return false;
      }
      if (message) setToast(message);
      await load();
      window.dispatchEvent(new Event("wr:changed"));
      return true;
    },
    [load],
  );

  const patch = (id: string, body: object, message?: string) =>
    mutate(`/api/notes/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, message);
  const remove = (id: string) => mutate(`/api/notes/${id}`, { method: "DELETE" }, "Deleted");
  const retry = (captureId: string) =>
    mutate(`/api/captures/${captureId}/finish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const discard = (captureId: string) => mutate(`/api/captures/${captureId}/audio`, { method: "DELETE" }, "Recording deleted");

  if (!data) {
    return (
      <div className="app">
        <Header review={0} total={0} loading />
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const review = data.notes.filter((n) => n.status === "review");
  const filed = data.notes.filter((n) => n.status === "confirmed");
  const captures = new Map(data.captures.map((c) => [c.id, c]));

  // Group notes to review by the recording they came from, newest recording first.
  const groups = new Map<string, Note[]>();
  for (const n of review) {
    const k = n.capture_id ?? "typed";
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  const problems = data.captures.filter((c) => ["processing", "recording", "failed", "empty"].includes(c.status));

  return (
    <div className="app">
      <Header review={review.length} total={data.notes.length} />
      {error && <p className="error">{error}</p>}

      {problems.length > 0 && (
        <section className="section">
          <div className="cards">
            {problems.map((c) => (
              <CaptureNotice key={c.id} capture={c} onRetry={() => retry(c.id)} onDiscard={() => discard(c.id)} />
            ))}
          </div>
        </section>
      )}

      {review.length > 0 && (
        <section className="section" aria-labelledby="review-h">
          <span className="eyebrow" id="review-h">
            To review
          </span>
          {[...groups.entries()].map(([key, notes]) => {
            const cap = captures.get(key);
            return (
              <div className="group" key={key}>
                {cap && <GroupHead capture={cap} count={notes.length} />}
                <div className="cards">
                  {notes.map((n) => (
                    <NoteCard
                      key={n.id}
                      note={n}
                      audioAvailable={Boolean(cap?.has_audio)}
                      onKeep={() => patch(n.id, { confirm: true }, "Kept in Inbox")}
                      onSave={(body) => patch(n.id, { body }, "Saved")}
                      onDelete={() => remove(n.id)}
                      onKeepAudio={(v) => patch(n.id, { keepAudio: v }, v ? "Recording will be kept" : undefined)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {filed.length > 0 && (
        <section className="section" aria-labelledby="filed-h">
          <span className="eyebrow" id="filed-h">
            In your Inbox
          </span>
          <div className="cards">
            {filed.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                audioAvailable={Boolean(n.capture_id && captures.get(n.capture_id)?.has_audio)}
                onSave={(body) => patch(n.id, { body }, "Saved")}
                onDelete={() => remove(n.id)}
                onKeepAudio={(v) => patch(n.id, { keepAudio: v })}
              />
            ))}
          </div>
        </section>
      )}

      {data.notes.length === 0 && problems.length === 0 && (
        <div className="empty">
          <p className="display">Nothing here yet.</p>
          <p>Everything you say or type lands here first. Tap Talk to capture your first idea.</p>
        </div>
      )}

      <footer className="foot">
        <a
          className="btn"
          href="/api/export"
          download
          onClick={(e) => {
            // Ask for times in this phone's own time zone.
            e.currentTarget.href = `/api/export?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
          }}
        >
          <Download /> Download everything
        </a>
        <p>All your notes and the full authorship log, as a plain text file.</p>
      </footer>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function Header({ review, total, loading }: { review: number; total: number; loading?: boolean }) {
  return (
    <header className="page-head">
      <span className="wordmark">Writer&rsquo;s Room</span>
      <h1 className="display" style={{ marginTop: 22 }}>
        Inbox
      </h1>
      <p>
        {loading
          ? "Loading…"
          : review > 0
            ? `${review} to review · ${total} ${total === 1 ? "note" : "notes"} in all`
            : total > 0
              ? `${total} ${total === 1 ? "note" : "notes"}, all reviewed`
              : "Unsorted notes wait here."}
      </p>
    </header>
  );
}

function GroupHead({ capture, count }: { capture: Capture; count: number }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  function toggle() {
    if (!audio.current) {
      audio.current = new Audio(`/api/captures/${capture.id}/audio`);
      audio.current.onended = () => setPlaying(false);
    }
    if (playing) {
      audio.current.pause();
      setPlaying(false);
    } else {
      audio.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }
  useEffect(() => () => audio.current?.pause(), []);
  return (
    <div className="group-head">
      <span>
        {when(capture.created_at)}
        {capture.duration_ms ? ` · ${length(capture.duration_ms)}` : ""}
        {` · ${count} ${count === 1 ? "note" : "notes"}`}
      </span>
      <span className="line" />
      {capture.has_audio && (
        <button type="button" className="play" onClick={toggle} aria-label={playing ? "Pause recording" : "Play recording"}>
          {playing ? <Pause /> : <Play />}
          {playing ? "Pause" : "Listen"}
        </button>
      )}
    </div>
  );
}

function CaptureNotice({ capture, onRetry, onDiscard }: { capture: Capture; onRetry: () => void; onDiscard: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown> | void) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  if (capture.status === "processing" || capture.status === "recording") {
    return (
      <div className="notice">
        <p>
          <strong>Transcribing</strong> your recording from {when(capture.created_at).toLowerCase()}…
        </p>
        <div className="shimmer" />
      </div>
    );
  }
  return (
    <div className="notice">
      <p>
        {capture.status === "empty" ? (
          <>
            <strong>No words heard</strong> in your recording from {when(capture.created_at).toLowerCase()}.
          </>
        ) : (
          <>
            <strong>Couldn&rsquo;t transcribe</strong> your recording from {when(capture.created_at).toLowerCase()}. It&rsquo;s
            saved, so nothing is lost.
            {capture.error && (
              <>
                <br />
                <span className="muted" style={{ fontSize: 14 }}>
                  {capture.error}
                </span>
              </>
            )}
          </>
        )}
      </p>
      <div className="row">
        <button className="btn" type="button" disabled={busy} onClick={() => run(onRetry)}>
          {busy ? "Working…" : "Try again"}
        </button>
        <button className="btn btn-ghost btn-danger" type="button" disabled={busy} onClick={() => confirm("Delete this recording?") && run(onDiscard)}>
          Delete recording
        </button>
      </div>
    </div>
  );
}

const SWIPE_KEEP = 110;

function NoteCard({
  note,
  audioAvailable,
  onKeep,
  onSave,
  onDelete,
  onKeepAudio,
}: {
  note: Note;
  audioAvailable: boolean;
  onKeep?: () => Promise<boolean>;
  onSave: (body: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onKeepAudio: (v: boolean) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [open, setOpen] = useState(false);
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const start = useRef<{ x: number; y: number; locked: boolean | null } | null>(null);
  const reviewing = note.status === "review";

  // Swipe right to keep (review cards only).
  const onTouchStart = (e: React.TouchEvent) => {
    if (!reviewing || editing) return;
    start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, locked: null };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = start.current;
    if (!s) return;
    const mx = e.touches[0].clientX - s.x;
    const my = e.touches[0].clientY - s.y;
    if (s.locked === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) s.locked = Math.abs(mx) > Math.abs(my);
    if (s.locked) setDx(Math.max(0, mx));
  };
  const onTouchEnd = async () => {
    const s = start.current;
    start.current = null;
    if (!s?.locked) return;
    if (dx > SWIPE_KEEP && onKeep) {
      setLeaving(true);
      setDx(window.innerWidth);
      if (!(await onKeep())) {
        setLeaving(false);
        setDx(0);
      }
    } else setDx(0);
  };

  const progress = Math.min(1, dx / SWIPE_KEEP);

  return (
    <div className="swipe">
      {reviewing && (
        <div className="swipe-under" style={{ opacity: progress }} aria-hidden>
          <Check /> Keep
        </div>
      )}
      <article
        className={`card ${reviewing ? "" : "filed"}`}
        style={{
          transform: dx ? `translateX(${dx}px)` : undefined,
          transition: start.current ? "none" : "transform 0.25s cubic-bezier(.2,.8,.2,1)",
          opacity: leaving ? 0 : 1,
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="meta">
          <span className="tag">
            {note.source === "spoken" ? <Mic /> : <Pen />}
            {note.source === "spoken" ? "Spoken" : "Typed"}
          </span>
          {note.spoken_label && <span className="tag label">{note.spoken_label}</span>}
          {(!reviewing || !note.capture_id) && <span>{when(note.created_at)}</span>}
        </div>

        {editing ? (
          <>
            <textarea className="editor" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <div className="actions">
              <button className="btn btn-ghost" type="button" onClick={() => (setEditing(false), setDraft(note.body))}>
                Cancel
              </button>
              <span className="spacer" />
              <button
                className="btn btn-ink"
                type="button"
                disabled={!draft.trim()}
                onClick={async () => (await onSave(draft)) && setEditing(false)}
              >
                Save
              </button>
            </div>
          </>
        ) : (
          <p className="card-body">{note.body}</p>
        )}

        {open && !editing && (
          <div className="details">
            {note.source === "spoken" && note.raw_text && (
              <>
                <h4>Exactly what you said</h4>
                <blockquote>{note.raw_text}</blockquote>
                <p style={{ margin: "0 0 12px" }}>
                  {note.cleanup === "ai"
                    ? "Tidied by AI: filler words and punctuation only, checked word for word against what you said."
                    : "Tidied by the app: filler words removed, nothing else changed."}
                </p>
              </>
            )}
            {note.capture_id && audioAvailable && (
              <div className="toggle">
                <span>
                  <strong style={{ color: "var(--ink)" }}>Keep the recording</strong>
                  <br />
                  Otherwise it&rsquo;s deleted once its notes are reviewed.
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={note.keep_audio}
                  aria-label="Keep the recording"
                  className="switch"
                  onClick={() => onKeepAudio(!note.keep_audio)}
                />
              </div>
            )}
            {note.capture_id && !audioAvailable && <p style={{ margin: 0 }}>The recording has been deleted.</p>}
          </div>
        )}

        {!editing && (
          <div className="actions">
            {reviewing && onKeep && (
              <button className="btn btn-keep" type="button" onClick={() => onKeep()}>
                <Check /> Keep
              </button>
            )}
            <button className="btn btn-ghost" type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <span className="spacer" />
            {(note.source === "spoken" || note.capture_id) && (
              <button
                className="btn btn-ghost"
                type="button"
                aria-expanded={open}
                aria-label="Details"
                onClick={() => setOpen(!open)}
              >
                <More />
              </button>
            )}
            <button
              className="btn btn-ghost btn-danger"
              type="button"
              aria-label="Delete note"
              onClick={() => confirm("Delete this note?") && onDelete()}
            >
              <Trash />
            </button>
          </div>
        )}
      </article>
    </div>
  );
}

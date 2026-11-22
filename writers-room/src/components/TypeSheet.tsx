"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function TypeSheet({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    if (!text.trim()) return;
    setSaving(true);
    setError("");
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(res ? (await res.json()).error : "You're offline. Your text is still here, try again soon.");
      return;
    }
    window.dispatchEvent(new Event("wr:changed"));
    onClose();
    router.push("/inbox");
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="type-title">
        <div className="grab" />
        <h2 id="type-title">Type a note</h2>
        <textarea
          ref={ref}
          className="editor"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What's the idea?"
          rows={5}
        />
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-ink" type="button" onClick={save} disabled={saving || !text.trim()}>
            {saving ? "Saving…" : "Save to Inbox"}
          </button>
        </div>
      </div>
    </>
  );
}

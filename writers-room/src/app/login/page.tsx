"use client";

import { useState } from "react";

export default function Login() {
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase: pass }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) window.location.href = "/";
    else setError(res ? (await res.json()).error : "You're offline.");
  }

  return (
    <main className="login">
      <span className="wordmark">Writer&rsquo;s Room</span>
      <h1 className="display">Welcome back.</h1>
      <p className="muted" style={{ margin: 0 }}>
        This notebook is private. Enter your passphrase once and this phone stays signed in.
      </p>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <input
          className="field"
          type="password"
          autoComplete="current-password"
          placeholder="Passphrase"
          aria-label="Passphrase"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoFocus
        />
        {error && <p className="error">{error}</p>}
        <button className="btn btn-ink" style={{ minHeight: 52 }} disabled={busy || !pass}>
          {busy ? "Checking…" : "Open notebook"}
        </button>
      </form>
    </main>
  );
}

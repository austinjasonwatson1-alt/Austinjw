"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { flush } from "@/client/queue";
import { Mic, Pen, Tray } from "./Icons";
import { TypeSheet } from "./TypeSheet";

export function Nav() {
  const path = usePathname();
  const [typing, setTyping] = useState(false);
  const [toReview, setToReview] = useState(0);

  // Upload anything left on the phone from earlier (dead zones, closed tabs),
  // on every screen, whenever there's a connection.
  useEffect(() => {
    const go = () => flush(() => window.dispatchEvent(new Event("wr:changed"))).catch(() => {});
    go();
    window.addEventListener("online", go);
    const t = setInterval(go, 20000);
    return () => {
      window.removeEventListener("online", go);
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const load = () =>
      fetch("/api/notes")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setToReview(d.notes.filter((n: { status: string }) => n.status === "review").length))
        .catch(() => {});
    load();
    window.addEventListener("wr:changed", load);
    return () => window.removeEventListener("wr:changed", load);
  }, [path]);

  return (
    <>
      <nav className="nav" aria-label="Main">
        <div className="nav-inner">
          <Link href="/" aria-current={path === "/" ? "page" : undefined}>
            <Mic />
            Talk
          </Link>
          <button type="button" onClick={() => setTyping(true)}>
            <Pen />
            Type
          </button>
          <Link href="/inbox" aria-current={path === "/inbox" ? "page" : undefined}>
            <Tray />
            Inbox
            {toReview > 0 && <span className="badge tabular">{toReview}</span>}
          </Link>
        </div>
      </nav>
      {typing && <TypeSheet onClose={() => setTyping(false)} />}
    </>
  );
}

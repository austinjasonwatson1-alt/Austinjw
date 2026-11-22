"use client";

// Every few seconds of audio is written to the phone's own storage first, then
// uploaded. A piece is only removed from the phone once the server has it, so a
// dead zone on the drive, a closed tab or a crash doesn't lose a note.

type Chunk = { key: string; captureId: string; seq: number; mime: string; data: ArrayBuffer };
type Finish = { captureId: string; chunkCount: number; durationMs: number; mimeType: string };

const DB_NAME = "writers-room";
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("chunks", { keyPath: "key" });
      req.result.createObjectStore("finishes", { keyPath: "captureId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const pad = (n: number) => String(n).padStart(6, "0");

export async function saveChunk(captureId: string, seq: number, blob: Blob) {
  const data = await blob.arrayBuffer();
  await tx("chunks", "readwrite", (s) =>
    s.put({ key: `${captureId}:${pad(seq)}`, captureId, seq, mime: blob.type, data } satisfies Chunk),
  );
}

export async function saveFinish(f: Finish) {
  await tx("finishes", "readwrite", (s) => s.put(f));
}

export async function pendingCount(): Promise<{ chunks: number; finishes: number }> {
  const [chunks, finishes] = await Promise.all([
    tx("chunks", "readonly", (s) => s.count()),
    tx("finishes", "readonly", (s) => s.count()),
  ]);
  return { chunks, finishes };
}

export type FinishResult = { captureId: string; ok: boolean; noteCount?: number; status?: string; error?: string };

let flushing: Promise<FinishResult[]> | null = null;

/** Upload everything waiting on the phone. Safe to call often; runs one at a time. */
export function flush(onFinish?: (r: FinishResult) => void): Promise<FinishResult[]> {
  flushing ??= doFlush(onFinish).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function doFlush(onFinish?: (r: FinishResult) => void): Promise<FinishResult[]> {
  const results: FinishResult[] = [];
  const chunks = (await tx("chunks", "readonly", (s) => s.getAll())) as Chunk[];
  chunks.sort((a, b) => a.key.localeCompare(b.key));
  for (const c of chunks) {
    const res = await fetch(`/api/captures/${c.captureId}/chunks/${c.seq}`, {
      method: "PUT",
      headers: { "Content-Type": c.mime || "application/octet-stream" },
      body: c.data,
    }).catch(() => null);
    if (!res?.ok) return results; // offline or server trouble: try again later
    await tx("chunks", "readwrite", (s) => s.delete(c.key));
  }
  const finishes = (await tx("finishes", "readonly", (s) => s.getAll())) as Finish[];
  for (const f of finishes) {
    const res = await fetch(`/api/captures/${f.captureId}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(f),
    }).catch(() => null);
    if (!res) return results;
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) continue; // pieces still on their way; retry next flush
    if (!res.ok) {
      const r = { captureId: f.captureId, ok: false, error: body.error ?? "Something went wrong" };
      results.push(r);
      onFinish?.(r);
      if (res.status >= 500 || res.status === 401) return results;
      continue;
    }
    await tx("finishes", "readwrite", (s) => s.delete(f.captureId));
    const r = {
      captureId: f.captureId,
      ok: true,
      status: body.capture?.status,
      noteCount: body.notes?.length ?? 0,
      error: body.capture?.error ?? undefined,
    };
    results.push(r);
    onFinish?.(r);
  }
  return results;
}

import "server-only";
import { db } from "./db";
import { cleanNotes } from "./pipeline/cleanup";
import { splitTranscript } from "./pipeline/split";
import { transcribe, transcriptionProvider } from "./transcribe";

export type Note = {
  id: string;
  body: string;
  source: "spoken" | "typed" | "ai_suggestion";
  space: string;
  status: "review" | "confirmed";
  spoken_label: string | null;
  capture_id: string | null;
  raw_text: string | null;
  cleanup: string | null;
  keep_audio: boolean;
  created_at: string;
  confirmed_at: string | null;
};

export type Capture = {
  id: string;
  status: "recording" | "processing" | "ready" | "empty" | "failed";
  duration_ms: number | null;
  error: string | null;
  has_audio: boolean;
  created_at: string;
};

type Actor = "author" | "ai" | "system";

async function log(
  event: string,
  actor: Actor,
  ids: { noteId?: string | null; captureId?: string | null },
  source: string | null,
  detail: unknown = null,
) {
  const d = await db();
  await d.query(
    `insert into authorship_log (note_id, capture_id, event, actor, source, detail) values ($1, $2, $3, $4, $5, $6)`,
    [ids.noteId ?? null, ids.captureId ?? null, event, actor, source, detail == null ? null : JSON.stringify(detail)],
  );
}

// ---------- Captures (recordings) ----------

export async function saveChunk(captureId: string, seq: number, data: Buffer, mimeType: string) {
  const d = await db();
  await d.query(
    `insert into captures (id, mime_type) values ($1, $2) on conflict (id) do nothing`,
    [captureId, mimeType],
  );
  await d.query(
    `insert into capture_chunks (capture_id, seq, data) values ($1, $2, $3)
     on conflict (capture_id, seq) do update set data = excluded.data`,
    [captureId, seq, data],
  );
}

export class MissingChunks extends Error {
  constructor(public missing: number[]) {
    super(`Missing audio pieces: ${missing.join(", ")}`);
  }
}

async function loadAudio(captureId: string): Promise<{ audio: Buffer; mime: string }> {
  const d = await db();
  const rows = await d.query<{ data: Uint8Array }>(
    `select data from capture_chunks where capture_id = $1 order by seq`,
    [captureId],
  );
  const [cap] = await d.query<{ mime_type: string | null }>(
    `select mime_type from captures where id = $1`,
    [captureId],
  );
  return {
    audio: Buffer.concat(rows.map((r) => Buffer.from(r.data))),
    mime: cap?.mime_type ?? "audio/webm",
  };
}

/** Sizes of each stored piece, so playback can serve any byte range without loading it all. */
export async function audioInfo(captureId: string): Promise<{ mime: string; sizes: { seq: number; size: number }[] }> {
  const d = await db();
  const rows = await d.query<{ seq: number; size: number | string }>(
    `select seq, octet_length(data) as size from capture_chunks where capture_id = $1 order by seq`,
    [captureId],
  );
  const [cap] = await d.query<{ mime_type: string | null }>(`select mime_type from captures where id = $1`, [captureId]);
  return {
    mime: (cap?.mime_type ?? "audio/webm").split(";")[0],
    sizes: rows.map((r) => ({ seq: Number(r.seq), size: Number(r.size) })),
  };
}

export async function audioPiece(captureId: string, seq: number): Promise<Buffer> {
  const d = await db();
  const [row] = await d.query<{ data: Uint8Array }>(
    `select data from capture_chunks where capture_id = $1 and seq = $2`,
    [captureId, seq],
  );
  return row ? Buffer.from(row.data) : Buffer.alloc(0);
}

/**
 * Finish a recording: check every piece arrived, transcribe, split into notes,
 * clean up, and put the notes in the Inbox for review.
 */
export async function finishCapture(
  captureId: string,
  input: { chunkCount?: number; durationMs?: number; mimeType?: string },
): Promise<{ capture: Capture; notes: Note[] }> {
  const d = await db();
  // A retry from the Inbox doesn't know the details; use what was stored the first time.
  const [prev] = await d.query<{ chunk_count: number | null; duration_ms: number | null; mime_type: string | null }>(
    `select chunk_count, duration_ms, mime_type from captures where id = $1`,
    [captureId],
  );
  const info = {
    chunkCount: input.chunkCount ?? prev?.chunk_count ?? 0,
    durationMs: input.durationMs ?? prev?.duration_ms ?? 0,
    mimeType: input.mimeType ?? prev?.mime_type ?? "audio/webm",
  };
  if (info.chunkCount < 1) throw new MissingChunks([0]);
  await d.query(`insert into captures (id, mime_type) values ($1, $2) on conflict (id) do nothing`, [
    captureId,
    info.mimeType,
  ]);
  const have = await d.query<{ seq: number }>(
    `select seq from capture_chunks where capture_id = $1`,
    [captureId],
  );
  const got = new Set(have.map((r) => Number(r.seq)));
  const missing = [...Array(info.chunkCount).keys()].filter((i) => !got.has(i));
  if (missing.length) throw new MissingChunks(missing);

  // Claim the capture so a double tap or retry can't process it twice.
  const claimed = await d.query(
    `update captures set status = 'processing', chunk_count = $2, duration_ms = $3, mime_type = $4, error = null
     where id = $1 and status in ('recording', 'failed', 'empty') returning id`,
    [captureId, info.chunkCount, info.durationMs, info.mimeType],
  );
  if (!claimed.length) return getCaptureWithNotes(captureId);

  try {
    const { audio, mime } = await loadAudio(captureId);
    const transcript = await transcribe(audio, mime);
    await d.query(`update captures set raw_transcript = $2 where id = $1`, [captureId, transcript]);
    await log("transcribed", "system", { captureId }, "spoken", { transcript, provider: transcriptionProvider() });

    const segments = splitTranscript(transcript);
    if (!segments.length) {
      await d.query(`update captures set status = 'empty', processed_at = now() where id = $1`, [captureId]);
      return getCaptureWithNotes(captureId);
    }
    const cleaned = await cleanNotes(segments.map((s) => s.content));
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const c = cleaned[i];
      const id = crypto.randomUUID();
      await d.query(
        // A spoken note is dated when it was said (the recording's start), not when it was transcribed.
        `insert into notes (id, body, source, space, status, spoken_label, suggested_space, capture_id, position, raw_text, cleanup, created_at)
         values ($1, $2, 'spoken', 'inbox', 'review', $3, $4, $5, $6, $7, $8, (select created_at from captures where id = $5))`,
        [id, c.text, s.spokenLabel, s.spokenSpace, captureId, i, s.raw, c.method],
      );
      await log("created", "author", { noteId: id, captureId }, "spoken", { text: s.raw });
      await log("cleaned", c.method === "ai" ? "ai" : "system", { noteId: id, captureId }, "spoken", {
        method: c.method,
        result: c.text,
        rejected_ai_version: c.rejected ?? null,
      });
    }
    await d.query(`update captures set status = 'ready', processed_at = now() where id = $1`, [captureId]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await d.query(`update captures set status = 'failed', error = $2 where id = $1`, [captureId, message]);
  }
  return getCaptureWithNotes(captureId);
}

const CAPTURE_COLS = `id, status, duration_ms, error, created_at,
  (audio_deleted_at is null and exists (select 1 from capture_chunks k where k.capture_id = captures.id)) as has_audio`;
const NOTE_COLS = `id, body, source, space, status, spoken_label, capture_id, raw_text, cleanup, keep_audio, created_at, confirmed_at`;

async function getCaptureWithNotes(captureId: string) {
  const d = await db();
  const [capture] = await d.query<Capture>(`select ${CAPTURE_COLS} from captures where id = $1`, [captureId]);
  const notes = await d.query<Note>(
    `select ${NOTE_COLS} from notes where capture_id = $1 and deleted_at is null order by position`,
    [captureId],
  );
  return { capture, notes };
}

/** Audio goes once nothing from the recording is waiting for review and no note asked to keep it. */
async function maybeDeleteAudio(captureId: string | null) {
  if (!captureId) return;
  const d = await db();
  const [state] = await d.query<{ pending: string | number; keep: string | number }>(
    `select count(*) filter (where status = 'review') as pending,
            count(*) filter (where keep_audio) as keep
     from notes where capture_id = $1 and deleted_at is null`,
    [captureId],
  );
  if (Number(state.pending) === 0 && Number(state.keep) === 0) {
    const deleted = await d.query(`delete from capture_chunks where capture_id = $1 returning seq`, [captureId]);
    await d.query(
      `update captures set audio_deleted_at = coalesce(audio_deleted_at, now()) where id = $1`,
      [captureId],
    );
    if (deleted.length) await log("audio_deleted", "system", { captureId }, null);
  }
}

export async function deleteCapture(captureId: string) {
  const d = await db();
  await d.query(`update notes set deleted_at = now() where capture_id = $1 and deleted_at is null`, [captureId]);
  await d.query(`delete from capture_chunks where capture_id = $1`, [captureId]);
  await d.query(`update captures set audio_deleted_at = now(), status = case when status = 'failed' then 'empty' else status end where id = $1`, [captureId]);
  await log("capture_deleted", "author", { captureId }, null);
}

// ---------- Inbox ----------

export async function listInbox(): Promise<{ captures: Capture[]; notes: Note[] }> {
  const d = await db();
  const notes = await d.query<Note>(
    `select ${NOTE_COLS} from notes where deleted_at is null and space = 'inbox'
     order by created_at desc, position asc limit 500`,
  );
  const captures = await d.query<Capture>(
    `select ${CAPTURE_COLS} from captures
     where (exists (select 1 from notes n where n.capture_id = captures.id and n.deleted_at is null))
        or (status in ('recording', 'processing', 'failed', 'empty') and audio_deleted_at is null)
     order by created_at desc limit 200`,
  );
  return { captures, notes };
}

export async function addTypedNote(body: string): Promise<Note> {
  const d = await db();
  const id = crypto.randomUUID();
  const [note] = await d.query<Note>(
    `insert into notes (id, body, source, status, confirmed_at) values ($1, $2, 'typed', 'confirmed', now())
     returning ${NOTE_COLS}`,
    [id, body],
  );
  await log("created", "author", { noteId: id }, "typed", { text: body });
  return note;
}

export async function updateNote(
  id: string,
  change: { body?: string; confirm?: boolean; keepAudio?: boolean },
): Promise<Note | null> {
  const d = await db();
  const [before] = await d.query<Note>(`select ${NOTE_COLS} from notes where id = $1 and deleted_at is null`, [id]);
  if (!before) return null;
  if (change.body != null && change.body !== before.body) {
    await d.query(`update notes set body = $2, updated_at = now() where id = $1`, [id, change.body]);
    await log("edited", "author", { noteId: id, captureId: before.capture_id }, before.source, {
      before: before.body,
      after: change.body,
    });
  }
  if (change.keepAudio != null && change.keepAudio !== before.keep_audio) {
    await d.query(`update notes set keep_audio = $2, updated_at = now() where id = $1`, [id, change.keepAudio]);
    await log(change.keepAudio ? "audio_kept" : "audio_released", "author", { noteId: id, captureId: before.capture_id }, null);
  }
  if (change.confirm && before.status === "review") {
    await d.query(`update notes set status = 'confirmed', confirmed_at = now(), updated_at = now() where id = $1`, [id]);
    await log("confirmed", "author", { noteId: id, captureId: before.capture_id }, before.source);
  }
  await maybeDeleteAudio(before.capture_id);
  const [after] = await d.query<Note>(`select ${NOTE_COLS} from notes where id = $1`, [id]);
  return after;
}

export async function deleteNote(id: string): Promise<boolean> {
  const d = await db();
  const [note] = await d.query<Note>(
    `update notes set deleted_at = now() where id = $1 and deleted_at is null returning ${NOTE_COLS}`,
    [id],
  );
  if (!note) return false;
  await log("deleted", "author", { noteId: id, captureId: note.capture_id }, note.source);
  await maybeDeleteAudio(note.capture_id);
  return true;
}

import "server-only";

// One tiny query function that works against either:
// - Supabase (or any Postgres) when DATABASE_URL is set: the deployed app, and
// - an embedded Postgres saved in ./.data when it isn't: zero-setup local runs.

type Row = Record<string, unknown>;
export type Db = { query<T = Row>(text: string, params?: unknown[]): Promise<T[]> };

const SCHEMA = `
create table if not exists books (
  id uuid primary key,
  title text not null,
  created_at timestamptz not null default now()
);

-- One recording session. Audio is held in chunks until the author confirms its notes.
create table if not exists captures (
  id uuid primary key,
  status text not null default 'recording',
  mime_type text,
  duration_ms integer,
  chunk_count integer,
  raw_transcript text,
  error text,
  audio_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists capture_chunks (
  capture_id uuid not null references captures(id) on delete cascade,
  seq integer not null,
  data bytea not null,
  primary key (capture_id, seq)
);

create table if not exists notes (
  id uuid primary key,
  body text not null,
  source text not null check (source in ('spoken', 'typed', 'ai_suggestion')),
  space text not null default 'inbox',
  book_id uuid references books(id),
  chapter text,
  status text not null default 'review' check (status in ('review', 'confirmed')),
  spoken_label text,
  suggested_space text,
  sort_confidence real,
  capture_id uuid references captures(id),
  position integer not null default 0,
  raw_text text,
  cleanup text,
  keep_audio boolean not null default false,
  reference_note_id uuid references notes(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  deleted_at timestamptz
);
create index if not exists notes_live on notes (created_at desc) where deleted_at is null;

-- Append-only record of who did what to every note. Never updated or deleted.
create table if not exists authorship_log (
  id bigserial primary key,
  note_id uuid,
  capture_id uuid,
  event text not null,
  actor text not null check (actor in ('author', 'ai', 'system')),
  source text,
  detail jsonb,
  at timestamptz not null default now()
);
`;

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: postgres } = await import("postgres");
    // prepare:false works with Supabase's connection pooler.
    const sql = postgres(url, { prepare: false, max: 3, onnotice: () => {} });
    const db: Db = {
      query: async (text, params = []) =>
        (await sql.unsafe(text, params as never[])) as unknown as never[],
    };
    await sql.unsafe(SCHEMA);
    return db;
  }
  if (process.env.VERCEL) throw new Error("DATABASE_URL is not set.");
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(process.env.WR_DATA_DIR ?? "./.data/pglite");
  await pg.exec(SCHEMA);
  return {
    query: async (text, params = []) => (await pg.query(text, params)).rows as never[],
  };
}

const g = globalThis as unknown as { __wrDb?: Promise<Db> };

export function db(): Promise<Db> {
  g.__wrDb ??= connect().catch((e) => {
    g.__wrDb = undefined;
    throw e;
  });
  return g.__wrDb;
}

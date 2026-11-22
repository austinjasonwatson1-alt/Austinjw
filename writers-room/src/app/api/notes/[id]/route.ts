import { NextResponse } from "next/server";
import { deleteNote, updateNote } from "@/lib/store";
import { isUuid } from "@/lib/validate";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const b = (await req.json().catch(() => ({}))) as { body?: string; confirm?: boolean; keepAudio?: boolean };
  const body = typeof b.body === "string" ? b.body.trim() : undefined;
  if (body !== undefined && (!body || body.length > 20000)) {
    return NextResponse.json({ error: "A note can't be empty." }, { status: 400 });
  }
  const note = await updateNote(id, {
    body,
    confirm: b.confirm === true,
    keepAudio: typeof b.keepAudio === "boolean" ? b.keepAudio : undefined,
  });
  if (!note) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ note });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  return (await deleteNote(id))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "Not found" }, { status: 404 });
}

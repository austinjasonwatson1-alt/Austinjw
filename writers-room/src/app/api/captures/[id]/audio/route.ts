import { NextResponse } from "next/server";
import { deleteCapture, getAudio } from "@/lib/store";
import { isUuid } from "@/lib/validate";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { audio, mime } = await getAudio(id);
  if (!audio.length) return NextResponse.json({ error: "Audio was deleted" }, { status: 404 });
  return new NextResponse(new Uint8Array(audio), {
    headers: { "Content-Type": mime.split(";")[0], "Cache-Control": "private, no-store" },
  });
}

// Discard a whole recording (used for recordings with no words or that failed).
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  await deleteCapture(id);
  return NextResponse.json({ ok: true });
}

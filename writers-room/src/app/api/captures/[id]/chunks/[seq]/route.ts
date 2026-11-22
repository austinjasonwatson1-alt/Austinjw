import { NextResponse } from "next/server";
import { saveChunk } from "@/lib/store";
import { isUuid } from "@/lib/validate";

// Each piece of a recording (a few seconds of audio) is uploaded as it's made.
export async function PUT(req: Request, ctx: { params: Promise<{ id: string; seq: string }> }) {
  const { id, seq } = await ctx.params;
  const n = Number(seq);
  if (!isUuid(id) || !Number.isInteger(n) || n < 0 || n > 100000) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const data = Buffer.from(await req.arrayBuffer());
  if (data.length === 0 || data.length > 4 * 1024 * 1024) {
    return NextResponse.json({ error: "Bad audio piece" }, { status: 400 });
  }
  await saveChunk(id, n, data, req.headers.get("content-type") ?? "audio/webm");
  return NextResponse.json({ ok: true });
}

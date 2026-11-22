import { NextResponse } from "next/server";
import { finishCapture, MissingChunks } from "@/lib/store";
import { isUuid } from "@/lib/validate";

export const maxDuration = 300; // long drives take a while to transcribe

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    chunkCount?: number;
    durationMs?: number;
    mimeType?: string;
  };
  const retry = body.chunkCount === undefined;
  if (!isUuid(id) || (!retry && (!Number.isInteger(body.chunkCount) || body.chunkCount! < 1))) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  try {
    const result = await finishCapture(id, {
      chunkCount: body.chunkCount,
      durationMs: body.durationMs === undefined ? undefined : Math.max(0, Math.round(body.durationMs)),
      mimeType: body.mimeType === undefined ? undefined : String(body.mimeType).slice(0, 100),
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof MissingChunks) {
      return NextResponse.json({ error: e.message, missing: e.missing }, { status: 409 });
    }
    throw e;
  }
}

import { NextResponse } from "next/server";
import { audioInfo, audioPiece, deleteCapture } from "@/lib/store";
import { isUuid } from "@/lib/validate";

// Plays a recording back. iPhone Safari asks for audio in byte ranges and won't
// play without them, and long recordings exceed hosting response limits, so this
// streams only the stored pieces that the requested range covers.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { mime, sizes } = await audioInfo(id);
  const total = sizes.reduce((n, p) => n + p.size, 0);
  if (!total) return NextResponse.json({ error: "Audio was deleted" }, { status: 404 });

  let start = 0;
  let end = total - 1;
  const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    if (range[1] === "" && range[2] !== "") {
      start = Math.max(0, total - Number(range[2])); // "bytes=-500": the last 500 bytes
    } else {
      start = Number(range[1] || 0);
      if (range[2] !== "") end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= total) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
  }

  // Work out which pieces overlap [start, end] and stream just those bytes.
  const parts: { seq: number; from: number; to: number }[] = [];
  let offset = 0;
  for (const p of sizes) {
    const pStart = offset;
    const pEnd = offset + p.size - 1;
    if (pEnd >= start && pStart <= end) {
      parts.push({ seq: p.seq, from: Math.max(start, pStart) - pStart, to: Math.min(end, pEnd) - pStart + 1 });
    }
    offset += p.size;
  }
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= parts.length) return controller.close();
      const part = parts[i++];
      const data = await audioPiece(id, part.seq);
      controller.enqueue(new Uint8Array(data.subarray(part.from, part.to)));
    },
  });
  return new NextResponse(body, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
      "Cache-Control": "private, no-store",
    },
  });
}

// Discard a whole recording (used for recordings with no words or that failed).
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  await deleteCapture(id);
  return NextResponse.json({ ok: true });
}

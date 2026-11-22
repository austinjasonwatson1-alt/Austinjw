import { exportAll } from "@/lib/store";

export const dynamic = "force-dynamic";

// "Download everything": all notes plus the authorship log as a .txt file.
export async function GET(req: Request) {
  const tz = new URL(req.url).searchParams.get("tz") ?? "UTC";
  const parts = await exportAll(tz.slice(0, 64));
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Send in batches so a large notebook streams instead of hitting size limits.
      if (i >= parts.length) return controller.close();
      controller.enqueue(enc.encode(parts.slice(i, i + 200).join("")));
      i += 200;
    },
  });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="writers-room-${date}.txt"`,
      "Cache-Control": "private, no-store",
    },
  });
}

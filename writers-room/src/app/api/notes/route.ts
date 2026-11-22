import { NextResponse } from "next/server";
import { addTypedNote, listInbox } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listInbox());
}

export async function POST(req: Request) {
  const { body } = (await req.json().catch(() => ({}))) as { body?: string };
  const text = (body ?? "").trim();
  if (!text || text.length > 20000) return NextResponse.json({ error: "Write something first." }, { status: 400 });
  return NextResponse.json({ note: await addTypedNote(text) });
}

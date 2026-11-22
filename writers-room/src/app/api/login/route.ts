import { NextResponse } from "next/server";
import { checkPassphrase, COOKIE, makeSession, SESSION_DAYS } from "@/lib/auth";

export async function POST(req: Request) {
  const { passphrase } = (await req.json().catch(() => ({}))) as { passphrase?: string };
  if (!passphrase || !(await checkPassphrase(passphrase))) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return NextResponse.json({ error: "That passphrase didn't match." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, await makeSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return res;
}

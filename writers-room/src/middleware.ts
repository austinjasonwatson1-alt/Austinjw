import { NextResponse, type NextRequest } from "next/server";
import { authMode, COOKIE, verifySession } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const mode = authMode();
  if (mode === "open") return NextResponse.next();
  if (mode === "misconfigured") {
    return new NextResponse("Set APP_PASSPHRASE in the hosting settings to use Writer's Room.", { status: 503 });
  }
  if (await verifySession(req.cookies.get(COOKIE)?.value)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the login page itself and static files.
  matcher: ["/((?!login|api/login|_next/|favicon|icon|apple-icon|manifest|fonts/).*)"],
};

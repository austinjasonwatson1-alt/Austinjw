// Single-user private login. The passphrase lives in the APP_PASSPHRASE
// environment variable; a signed cookie keeps the phone signed in for a year.
// Uses Web Crypto so it runs in middleware too.

export const COOKIE = "wr_session";
export const SESSION_DAYS = 365;

const enc = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Login is required when a passphrase is set, and always on the deployed app. */
export function authMode(): "open" | "required" | "misconfigured" {
  if (process.env.APP_PASSPHRASE) return "required";
  return process.env.VERCEL ? "misconfigured" : "open";
}

export async function makeSession(): Promise<string> {
  const expires = Date.now() + SESSION_DAYS * 864e5;
  return `${expires}.${await hmac(process.env.APP_PASSPHRASE!, `wr:${expires}`)}`;
}

export async function verifySession(value: string | undefined): Promise<boolean> {
  const secret = process.env.APP_PASSPHRASE;
  if (!secret || !value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(secret, `wr:${exp}`));
}

export async function checkPassphrase(input: string): Promise<boolean> {
  const secret = process.env.APP_PASSPHRASE;
  if (!secret) return false;
  // Compare HMACs so the comparison time doesn't reveal the passphrase length.
  return safeEqual(await hmac(secret, input), await hmac(secret, secret));
}

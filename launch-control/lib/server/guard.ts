import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Cost and write guards for the public URL (PRD §6).
 * - Passcode: required on agent runs and Linear writes whenever DEMO_PASSCODE is set.
 * - Rate limit: fixed per-IP budget per hour. In-memory, so on Vercel each server
 *   instance counts separately: a cost guard for a demo, not a billing system.
 */

export const PASSCODE_HEADER = 'x-demo-passcode';

export const passcodeRequired = () => Boolean(process.env.DEMO_PASSCODE);

const digest = (s: string) => createHash('sha256').update(s).digest();

export function passcodeOk(req: Request): boolean {
  const want = process.env.DEMO_PASSCODE;
  if (!want) return true;
  const got = req.headers.get(PASSCODE_HEADER) ?? '';
  return timingSafeEqual(digest(got), digest(want)); // equal-length digests: no length or timing leak
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd?.split(',')[0] || req.headers.get('x-real-ip') || 'local').trim();
}

interface Bucket {
  start: number;
  count: number;
}
const buckets = new Map<string, Bucket>();
const HOUR = 3_600_000;

/** Counts one attempt. Returns null if allowed, or seconds until the window resets. */
export function rateLimit(scope: string, ip: string, perHour: number, now = Date.now()): number | null {
  const key = `${scope}:${ip}`;
  let b = buckets.get(key);
  if (!b || now - b.start >= HOUR) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (now - v.start >= HOUR) buckets.delete(k);
  if (b.count >= perHour) return Math.ceil((b.start + HOUR - now) / 1000);
  b.count++;
  return null;
}

export const AGENT_RUNS_PER_HOUR = 10;
export const APPLY_RUNS_PER_HOUR = 20;

/** Shared gate for POST routes: rate limit first (so wrong passcodes count too), then passcode. */
export function guard(req: Request, scope: string, perHour: number): Response | null {
  const wait = rateLimit(scope, clientIp(req), perHour);
  if (wait != null) {
    return Response.json({ error: 'rate_limited', retryAfter: wait }, { status: 429, headers: { 'Retry-After': String(wait) } });
  }
  if (!passcodeOk(req)) return Response.json({ error: 'passcode_required' }, { status: 401 });
  return null;
}

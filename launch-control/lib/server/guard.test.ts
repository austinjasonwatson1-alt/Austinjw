import { afterEach, describe, expect, it } from 'vitest';
import { clientIp, guard, passcodeOk, rateLimit } from './guard';

const req = (headers: Record<string, string> = {}) => new Request('http://x/api', { method: 'POST', headers });

afterEach(() => {
  delete process.env.DEMO_PASSCODE;
});

describe('passcode', () => {
  it('is open when no passcode is configured', () => expect(passcodeOk(req())).toBe(true));
  it('checks the header when one is configured', () => {
    process.env.DEMO_PASSCODE = 'bigpanda';
    expect(passcodeOk(req())).toBe(false);
    expect(passcodeOk(req({ 'x-demo-passcode': 'wrong' }))).toBe(false);
    expect(passcodeOk(req({ 'x-demo-passcode': 'bigpanda' }))).toBe(true);
  });
});

describe('rate limit', () => {
  it('allows N per hour per ip and scope, then reports seconds to wait', () => {
    const t = 1_000_000;
    for (let n = 0; n < 3; n++) expect(rateLimit('t1', '1.1.1.1', 3, t)).toBeNull();
    expect(rateLimit('t1', '1.1.1.1', 3, t + 60_000)).toBe(3540);
    expect(rateLimit('t1', '2.2.2.2', 3, t)).toBeNull(); // other ip
    expect(rateLimit('t2', '1.1.1.1', 3, t)).toBeNull(); // other scope
    expect(rateLimit('t1', '1.1.1.1', 3, t + 3_600_000)).toBeNull(); // window reset
  });
  it('reads the first forwarded ip', () => {
    expect(clientIp(req({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }))).toBe('9.9.9.9');
    expect(clientIp(req())).toBe('local');
  });
  it('counts wrong passcodes against the limit', async () => {
    process.env.DEMO_PASSCODE = 'pw';
    const r = () => req({ 'x-forwarded-for': '7.7.7.7', 'x-demo-passcode': 'guess' });
    expect(guard(r(), 'g', 2)?.status).toBe(401);
    expect(guard(r(), 'g', 2)?.status).toBe(401);
    const third = guard(r(), 'g', 2)!;
    expect(third.status).toBe(429);
    expect((await third.json()).error).toBe('rate_limited');
  });
});

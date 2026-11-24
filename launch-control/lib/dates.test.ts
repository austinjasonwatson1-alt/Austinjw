import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, fmtDate, isIsoDate, localToday } from './dates';

describe('dates', () => {
  it('adds days across months and years', () => {
    expect(addDays('2026-11-24', 16)).toBe('2026-12-10');
    expect(addDays('2026-12-30', 5)).toBe('2027-01-04');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('counts days between dates across DST changes', () => {
    expect(daysBetween('2026-03-01', '2026-03-15')).toBe(14);
    expect(daysBetween('2026-11-24', '2026-11-08')).toBe(-16);
  });
  it('formats like the prototype', () => expect(fmtDate('2026-12-08')).toBe('Dec 8'));
  it('validates ISO dates', () => {
    expect(isIsoDate('2026-11-24')).toBe(true);
    expect(isIsoDate('2026-11-24T00:00')).toBe(false);
    expect(isIsoDate('yesterday')).toBe(false);
  });
  it('reads the local date', () => expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05'));
});

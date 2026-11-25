/**
 * Calendar-date helpers. All dates in the domain are ISO calendar dates ("YYYY-MM-DD")
 * so scoring is timezone-free: "today" is passed in, never read from the clock here.
 */
const DAY = 86_400_000;

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const toUtc = (iso: string): number => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

export const isIsoDate = (s: unknown): s is string =>
  typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(toUtc(s));

/** Date `n` days after `iso`. */
export const addDays = (iso: string, n: number): string =>
  new Date(toUtc(iso) + n * DAY).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (positive when `to` is later). */
export const daysBetween = (from: string, to: string): number =>
  Math.round((toUtc(to) - toUtc(from)) / DAY);

/** "Nov 24" style label, matching the prototype. */
export const fmtDate = (iso: string): string =>
  new Date(toUtc(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Today's date in the local timezone of whoever calls it (browser or server). */
export const localToday = (now: Date = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
};

import { NextResponse, type NextRequest } from 'next/server';
import { daysBetween, isIsoDate } from '@/lib/dates';
import { demoSnapshot, getSource, type SourceKind } from '@/lib/tracker';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tracker?source=demo|linear&today=YYYY-MM-DD
 * `today` is the browser's local date so demo dates line up with the viewer's calendar.
 * It is only trusted within a day of the server's UTC date (timezones span ±1 day).
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const serverToday = new Date().toISOString().slice(0, 10);
  const asked = q.get('today');
  const asOf = isIsoDate(asked) && Math.abs(daysBetween(serverToday, asked)) <= 1 ? asked : serverToday;
  const kind: SourceKind = q.get('source') === 'linear' ? 'linear' : 'demo';

  const source = getSource(kind);
  if (!source) {
    return NextResponse.json({
      ...demoSnapshot(asOf),
      notice: 'Linear isn’t connected yet, so this is the built-in demo data.',
    });
  }
  try {
    return NextResponse.json(await source.load(asOf));
  } catch {
    return NextResponse.json({
      ...demoSnapshot(asOf),
      notice: `Couldn’t load ${kind} data, so this is the built-in demo data.`,
    });
  }
}

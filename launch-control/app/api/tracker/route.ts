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
      notice: 'Linear isn’t configured on this server, so this is the built-in sample data.',
    });
  }
  try {
    return NextResponse.json(await source.load(asOf));
  } catch (e) {
    const why = e instanceof Error && e.message === 'linear_timeout' ? 'Linear didn’t answer within 5 seconds' : kind === 'linear' ? 'Couldn’t load data from Linear' : 'Couldn’t load tracker data';
    console.error(`[tracker] ${kind} failed: ${e instanceof Error ? e.message : 'error'}`);
    return NextResponse.json({ ...demoSnapshot(asOf), notice: `${why}, so this is the built-in sample data.` });
  }
}

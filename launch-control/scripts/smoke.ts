/**
 * Smoke test: walks the demo script against any URL and fails loudly.
 * For the QA gate (3 clean runs on the production URL).
 *
 *   npx playwright install chromium          # once per machine
 *   npm run smoke -- https://your-app.vercel.app --passcode <DEMO_PASSCODE>
 *   npm run smoke -- http://localhost:3000 --no-agent      # skip the paid Claude run
 *
 * Flags: --passcode <p>, --no-agent, --no-linear, --headed. Never writes to Linear.
 */
import { chromium, type Page } from 'playwright';

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//.test(a)) ?? 'http://localhost:3000';
const flag = (f: string) => args.includes(f);
const passcode = args[args.indexOf('--passcode') + 1] && args.includes('--passcode') ? args[args.indexOf('--passcode') + 1] : '';

let failed = 0;
async function step(name: string, fn: () => Promise<string | void>) {
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`✓ ${name} (${Date.now() - t0} ms)${note ? ` — ${note}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name} — ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}
const expect = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const headline = (p: Page) => p.textContent('h1').then((t) => t ?? '');

async function main() {
  console.log(`Smoke test: ${url}\n`);
  const browser = await chromium.launch({ headless: !flag('--headed'), executablePath: process.env.PW_CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin }).catch(() => {});
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await step('loads with a finding headline', async () => {
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => localStorage.setItem('lc-source', 'demo')).catch(() => {});
    await p.reload();
    await p.waitForSelector('[role=listitem]', { timeout: 15_000 });
    const h = await headline(p);
    expect(!/Loading/.test(h), 'still loading');
    return h;
  });

  await step('demo: status pill rescoring', async () => {
    await p.click('button:has-text("Reset sample data")');
    await p.waitForTimeout(500);
    const before = await headline(p);
    await p.click('button[aria-label^="LCH-126 status"]');
    const after = await headline(p);
    expect(before !== after, `headline didn't change: ${after}`);
    return after;
  });

  if (!flag('--no-agent')) {
    await step('agent: brief with tool trace', async () => {
      await p.click('button:has-text("Run readiness")');
      const dlg = await p.waitForSelector('dialog[open]', { timeout: 1500 }).catch(() => null);
      if (dlg) {
        expect(passcode, 'passcode dialog appeared: pass --passcode');
        await p.fill('dialog input', passcode);
        await p.click('dialog >> text=Continue');
      }
      await p.waitForSelector('[class*=go]:has-text("Run readiness"):not([disabled])', { timeout: 55_000 });
      const aside = await p.innerText('aside');
      expect(/Claude agent/.test(aside), `fell back to rules: ${(await p.innerText('ul[class*=trace]')).trim()}`);
      expect(/get_gates/.test(aside) && /list_issues/.test(aside), 'tool trace missing');
      expect(/Recommendation/.test(aside) && /Exec update/.test(aside), 'brief format missing');
      const rec = aside.match(/(NO-GO|GO WITH CONDITIONS|GO)\b/)?.[0];
      const risk = Number((await headline(p)).match(/(\d+) of \d+ gates/)?.[1] ?? 0);
      expect(!risk || rec === 'NO-GO', `recommended ${rec} with ${risk} gate(s) at risk`);
      return aside.match(/(NO-GO|GO WITH CONDITIONS|GO)[^\n]{0,60}/)?.[0];
    });
  }

  await step('risk alerts: review opens (nothing sent)', async () => {
    await p.click('button:has-text("Reset sample data")');
    await p.waitForTimeout(400);
    await p.click('button:has-text("Review 2 alerts")');
    const items = await p.$$eval('[aria-label="Proposed risk alerts"] li', (e) => e.map((x) => x.textContent ?? ''));
    await p.click('[class*=alertbox] button:has-text("Cancel")');
    expect(items.length === 2 && items.every((t) => t.startsWith('Tom') || t.startsWith('Rachel')), `unexpected alerts: ${items.join(' | ')}`);
    return items.map((t) => t.split(' — ')[0].split('Risk alert')[0].trim()).join('; ');
  });

  await step('decision: preview opens (nothing posted)', async () => {
    await p.click('[class*=decision] button:has-text("No-go")');
    const preview = await p.innerText('[class*=preview]');
    await p.click('[class*=decision] button:has-text("Cancel")');
    expect(/Go\/no-go decision from Launch Control: NO-GO/.test(preview) && /Readiness at the time/.test(preview), `unexpected preview: ${preview.slice(0, 80)}`);
    return 'NO-GO preview with readiness numbers';
  });

  await step('copy exec update', async () => {
    await p.click('button:has-text("Copy exec update")');
    await p.waitForSelector('button:has-text("Copied"), button:has-text("Copy blocked")', { timeout: 3000 });
    const text = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    expect(text.length > 40, 'clipboard empty');
    return `${text.slice(0, 60)}…`;
  });

  await step('demo: auto-fix and reset', async () => {
    await p.click('button:has-text("Auto-fix the safe ones")');
    const hyg = await p.locator('[class*=hyg] small', { hasText: '% clean' }).textContent();
    await p.click('button:has-text("Reset sample data")');
    await p.waitForTimeout(500);
    expect(/clean/.test(hyg ?? ''), 'no hygiene score');
    return `after fix ${hyg}, reset to "${(await headline(p)).slice(0, 40)}…"`;
  });

  if (!flag('--no-linear')) {
    await step('linear: live data loads (no fallback banner)', async () => {
      await p.click('button:has-text("Linear")');
      await p.waitForSelector('text=Live from Linear', { timeout: 10_000 }).catch(async () => {
        const banner = await p.locator('p[role=status]').innerText().catch(() => 'no banner');
        throw new Error(`fell back to demo: ${banner}`);
      });
      const ids = await p.$$eval('code a', (a) => a.length);
      expect(ids > 0, 'no issue links');
      return `${await headline(p)} (${ids} linked issues)`;
    });
    await step('linear: review fixes opens (nothing written)', async () => {
      const btn = p.locator('[class*=hyg] button:has-text("Review")');
      if (!(await btn.count())) return 'no fixes proposed (already applied? run seed:linear --restore)';
      await btn.click();
      const n = await p.locator('[aria-label="Proposed fixes"] li').count();
      await p.click('[class*=hyg] button:has-text("Cancel")');
      expect(n > 0, 'empty review list');
      return `${n} fixes proposed`;
    });
    await p.click('button:has-text("Demo data")');
  }

  await step('phone width: no horizontal scroll', async () => {
    await p.setViewportSize({ width: 375, height: 800 });
    await p.waitForTimeout(300);
    expect(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'page scrolls sideways');
  });

  await step('no console errors', async () => {
    expect(!errors.length, errors.join(' | '));
  });

  await browser.close();
  console.log(failed ? `\n${failed} step(s) failed.` : '\nAll steps passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

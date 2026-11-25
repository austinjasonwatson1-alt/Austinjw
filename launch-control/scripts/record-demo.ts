/**
 * Records a captioned walkthrough of the demo script as a video.
 *
 *   npm run dev                                   # in another terminal (needs ANTHROPIC + LINEAR keys, no passcode)
 *   npm run demo:video -- http://localhost:3000   # writes demo-video/walkthrough.webm
 *   ffmpeg -i demo-video/walkthrough.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart public/demo.mp4
 *
 * Runs one real agent brief (about a cent). Never writes to Linear: alerts and the decision are
 * recorded on demo data, and the Linear part only looks.
 */
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const url = process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ?? 'http://localhost:3000';
const OUT = 'demo-video';
const SIZE = { width: 1280, height: 720 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Caption bar and a visible cursor, injected into the page (video capture has no real cursor). */
async function overlay(p: Page) {
  await p.evaluate(() => {
    const cap = document.createElement('div');
    cap.id = 'lc-cap';
    cap.style.cssText =
      'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:980px;width:max-content;z-index:99999;' +
      'background:rgba(5,18,32,.92);color:#fff;border:1px solid rgba(143,211,255,.45);border-radius:12px;padding:12px 20px;' +
      'font:500 20px/1.35 "Hanken Grotesk",system-ui,sans-serif;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.45);opacity:0;transition:opacity .3s';
    document.body.appendChild(cap);
    const cur = document.createElement('div');
    cur.id = 'lc-cur';
    cur.style.cssText =
      'position:fixed;left:640px;top:360px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;z-index:100000;pointer-events:none;' +
      'background:rgba(143,211,255,.35);border:2px solid #8fd3ff;transition:left .7s cubic-bezier(.3,.7,.3,1),top .7s cubic-bezier(.3,.7,.3,1),transform .15s';
    document.body.appendChild(cur);
  });
}
const caption = (p: Page, text: string) =>
  p.evaluate((t) => {
    const c = document.getElementById('lc-cap')!;
    c.textContent = t;
    c.style.opacity = t ? '1' : '0';
  }, text);

async function pointAt(p: Page, selector: string) {
  const el = p.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) throw new Error(`not visible: ${selector}`);
  const x = box.x + Math.min(box.width / 2, 140);
  const y = box.y + box.height / 2;
  await p.evaluate(([cx, cy]) => {
    const c = document.getElementById('lc-cur')!;
    c.style.left = `${cx}px`;
    c.style.top = `${cy}px`;
  }, [x, y]);
  await p.mouse.move(x, y);
  await wait(850);
  return el;
}
async function click(p: Page, selector: string) {
  const el = await pointAt(p, selector);
  await p.evaluate(() => (document.getElementById('lc-cur')!.style.transform = 'scale(.7)'));
  await wait(140);
  await el.click();
  await p.evaluate(() => (document.getElementById('lc-cur')!.style.transform = 'none'));
  await wait(350);
}
const scrollTo = async (p: Page, selector: string, offset = 90) => {
  await p
    .locator(selector)
    .first()
    .evaluate((el, o) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - o, behavior: 'smooth' }), offset);
  await wait(900);
};

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT, size: SIZE } });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    try {
      localStorage.clear();
      localStorage.setItem('lc-source', 'demo');
    } catch {
      /* ignore */
    }
  });
  await p.goto(url);
  await p.waitForSelector('[role=listitem]');
  await overlay(p);
  await wait(900);

  await caption(p, 'Launch Control: is every launch ready? The headline is the finding.');
  await wait(4200);
  await caption(p, 'Each bar is a launch, built from its readiness gates. Pink means at risk; the white tick is go/no-go.');
  await pointAt(p, '[role=listitem]:has-text("L1 Triage Agent")');
  await wait(3600);

  await scrollTo(p, '[class*=work]', 70);
  await caption(p, 'L1 Triage Agent: 3 of 10 gates need action, including a gate nobody filed a ticket for.');
  await pointAt(p, 'details:has-text("Support runbook and training") summary');
  await wait(3800);

  await caption(p, 'Finding a risk is half the job. Draft an alert to each owner…');
  await click(p, 'button:has-text("Review 2 alerts")');
  await wait(3200);
  await caption(p, '…and nothing is sent until a person confirms.');
  await click(p, 'button:has-text("Send 2 alerts")');
  await wait(2200);

  await scrollTo(p, 'aside', 80);
  await caption(p, 'The readiness agent: Claude reads the tracker with read-only tools and writes the go/no-go brief.');
  await click(p, 'button:has-text("Run readiness agent")');
  await p.waitForSelector('[class*=checks]', { timeout: 60_000 });
  await wait(1200);
  await caption(p, 'Every brief is checked against the data: real issue IDs, and the same call as the rules engine.');
  await pointAt(p, '[class*=checks]');
  await wait(4200);
  await caption(p, 'Blocking risks with owners and issue IDs, then a three-line update for execs.');
  await scrollTo(p, 'aside h4:has-text("Exec update")', 380);
  await wait(3800);

  await scrollTo(p, '[class*=decision]', 150);
  await caption(p, 'A person makes the call. The decision is previewed, then posted as a status update.');
  await click(p, '[class*=decision] button:has-text("No-go")');
  await wait(3400);
  await click(p, 'button:has-text("Record decision")');
  await wait(1800);

  await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(900);
  await caption(p, 'One switch to live Linear data: same launches, real tickets.');
  await click(p, 'header button:has-text("Linear")');
  await p.waitForSelector('text=Live from Linear', { timeout: 15_000 });
  await wait(2600);
  await caption(p, 'The extra row is this project itself, scored by its own launch gates.');
  await pointAt(p, '[role=listitem]:has-text("Launch Control v1")');
  await wait(3600);

  await scrollTo(p, '[class*=hyg]', 110);
  await caption(p, 'Tracker data quality: fixes are proposed, a person reviews, then they are written to Linear.');
  await click(p, '[class*=hyg] button:has-text("Review")');
  await wait(4200);
  await click(p, '[class*=hyg] button:has-text("Cancel")');

  await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(900);
  await caption(p, 'Launch Control · built by Austin Watson · austinjw.vercel.app');
  await wait(3600);

  await ctx.close();
  await browser.close();
  const file = readdirSync(OUT).find((f) => f.endsWith('.webm'));
  if (!file) throw new Error('no video was recorded');
  renameSync(`${OUT}/${file}`, `${OUT}/walkthrough.webm`);
  console.log(`Recorded ${OUT}/walkthrough.webm`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

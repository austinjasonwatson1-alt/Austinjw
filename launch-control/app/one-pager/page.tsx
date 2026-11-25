import type { Metadata } from 'next';
import s from './onepager.module.css';
import PrintButton from './PrintButton';

export const metadata: Metadata = {
  title: 'Launch Control · One-pager',
  description: 'Launch Control in one page: the problem, what it does, how I know the AI is right, and how I would roll it out.',
};

const REPO = 'https://github.com/austinjasonwatson1-alt/Austinjw/tree/claude/pensive-curie-80dv7b/launch-control';

const STATS = [
  ['30/30', 'same go/no-go call as the rules engine'],
  ['0 of 152', 'issue IDs invented by the agent'],
  ['21/21', 'at-risk tickets cited in the brief'],
  ['5.3 s · 1.3¢', 'typical brief time and cost'],
];

export default function OnePager() {
  return (
    <main className={s.page}>
      <header className={s.head}>
        <div>
          <p className={s.kicker}>Launch readiness, automated</p>
          <h1 className={s.title}>Launch Control</h1>
        </div>
        <div className={s.by}>
          Austin Watson
          <br />
          <a href="/">austinjw.vercel.app</a>
        </div>
      </header>

      <p className={s.lede}>
        Before a tier 1 launch, product ops spends hours chasing status across R&amp;D, QA, docs, enablement, support and
        marketing to answer one question: <strong>are we ready?</strong> Launch Control answers it on one screen, and an AI
        agent writes the go/no-go brief from live tracker data, so the time goes into fixing risks instead of finding them.
      </p>

      <div className={s.grid}>
        <section className={s.sec}>
          <h2>What it does</h2>
          <ul>
            <li>
              <strong>Scores every launch against its readiness gates</strong> (10 for Tier 1, 7 for Tier 2, 3 for Tier 3). A
              gate is at risk if a ticket is blocked, overdue, due after go/no-go, or missing entirely.
            </li>
            <li>
              <strong>Writes the go/no-go brief:</strong> Claude with read-only tools reads the tracker and returns a
              recommendation, blocking risks with owners and issue IDs, and a three-line exec update.
            </li>
            <li>
              <strong>Closes the loop:</strong> drafts a risk alert to each owner and fixes tracker hygiene (owners, dates,
              stale tickets). A person reviews and confirms every change.
            </li>
            <li>
              <strong>Never stalls:</strong> a rules engine writes the same brief if Claude or the tracker is unavailable.
            </li>
          </ul>
        </section>
        <section className={s.sec}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={s.shot} src="/one-pager-shot.png" alt="Launch Control showing L1 Triage Agent at risk with 3 of 10 gates needing action, and the Claude go/no-go brief" />
          <p className={s.cap}>Live on Linear data or built-in demo data, one switch.</p>
        </section>

        <section className={`${s.sec} ${s.full}`}>
          <h2>How I know the AI is right</h2>
          <div className={s.stats}>
            {STATS.map(([v, l]) => (
              <div key={l} className={s.stat}>
                <b>{v}</b>
                <span>{l}</span>
              </div>
            ))}
          </div>
          <p className={s.cap}>
            Eval: 30 briefs over two scenarios (fresh data, and a week later with four launches at risk for different reasons),
            each checked against the data it read. The same check runs under every brief in the app.
          </p>
        </section>

        <section className={s.sec}>
          <h2>Built like a launch</h2>
          <ul>
            <li>PRD, six milestones and the build&apos;s own readiness gates tracked in Linear; the build shows on its own calendar.</li>
            <li>Every product and technical decision logged in one line with its reason.</li>
            <li>Guardrails: secrets server-side, AI output treated as untrusted, passcode and rate limit, every external call with a timeout and visible fallback.</li>
          </ul>
        </section>
        <section className={s.sec}>
          <h2>Impact, with the assumptions shown</h2>
          <p className={s.model}>
            A readiness sweep by hand ≈ <b>45 min</b>. At <b>5 launches a month</b>, swept weekly for the last <b>4 weeks</b>,
            that&apos;s <b>15 hours a month</b> of status-chasing, plus ~3 min per ticket chased or fixed by hand. The bigger win
            isn&apos;t the hours: it&apos;s risks found <em>before</em> the go/no-go meeting instead of in it.
          </p>
        </section>

        <section className={`${s.sec} ${s.full}`}>
          <h2>How I&apos;d roll it out</h2>
          <div className={s.plan}>
            <div>
              <b>Days 1–30 · Learn</b>
              <p>Sit in on two go/no-go reviews. Agree gate definitions and owners with R&amp;D, QA, Docs, PMM and Support. Connect the real tracker (one adapter file).</p>
            </div>
            <div>
              <b>Days 31–60 · Run in parallel</b>
              <p>Run alongside the manual process on two launches. Measure prep time and risks surfaced before the meeting. Post the exec update to Slack.</p>
            </div>
            <div>
              <b>Days 61–90 · Make it the default</b>
              <p>Default for every Tier 1 go/no-go. Add readiness trend over time and hygiene targets per team. Report the before/after numbers.</p>
            </div>
          </div>
        </section>
      </div>

      <nav className={s.links} aria-label="Links">
        <a href="/">Live demo</a>
        <a href={REPO}>Code</a>
        <a href={`${REPO}/docs/EVAL.md`}>Agent eval</a>
        <a href={`${REPO}/DECISIONS.md`}>Decisions log</a>
        <a href={`${REPO}/PRD.md`}>PRD</a>
        <PrintButton />
      </nav>
    </main>
  );
}

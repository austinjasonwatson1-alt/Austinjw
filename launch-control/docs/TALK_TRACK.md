# Launch Control: 2-minute talk track (draft)

Rehearse out loud; aim for 2:00. Clicks are in **bold**.

**0:00 — The problem (20 s)**
"Before a tier 1 launch, product ops spends hours chasing status across seven teams to answer one question: are we ready? The tracker has the answer, but half the tickets have no owner or date, and the riskiest gap is usually the ticket nobody filed. So I built the tool I'd want running launch readiness."

**0:20 — The finding (25 s)**
"The headline is the finding, not a dashboard title: *L1 Triage Agent is at risk, 3 of 10 gates need action, 16 days out.* Each bar runs from today to launch and is built from that launch's gates. Pink means blocked, overdue, due after go/no-go, or no ticket at all. **Click L1.** Support runbook has no ticket. That's the gap a status meeting misses."

**0:45 — The agent (30 s)**
"**Run readiness agent.** This is Claude with three read-only tools over the tracker. You can watch it call `get_gates` and `list_issues`, and it writes the go/no-go brief: recommendation, blocking risks with issue IDs and owners, and a three-line exec update. Under it, the app checks the brief against the data: every issue ID is real, and the call matches the rules engine. I measured that across 30 runs: 30 of 30 matched, zero invented IDs, about 5 seconds and a penny each. **Copy exec update.** That's the Slack message to leadership."

**1:15 — Live data and hygiene (30 s)**
"**Switch to Linear.** Same five launches, now from a real Linear workspace; the IDs open the real issues. One extra row: *Launch Control v1*. That's this project, scored by its own gates. Reporting is only as good as tracker hygiene, so: **Review fixes.** Assign the team lead, set due dates, nudge stale owners. Nothing is written until a human confirms. **Apply.** The log counts the manual work removed."

**1:45 — How I built it (15 s)**
"I ran it like a launch: a PRD, milestones, and the build's own readiness gates tracked in Linear. Every product and technical decision is in a one-line decisions log, for example why the agent can read but never write."

**2:00 — Stop.** Have ready: [DECISIONS.md](../DECISIONS.md) for follow-ups; the Linear "Launch Control v1" project if they ask about process.

## Before the call (Monday morning)
- `npm run seed:linear -- --restore --yes`: re-dates the Linear launches to today and resets fixes. **Without this, Linear shows different scores from the demo.**
- `npm run check:linear`: must print ✓ for all five launches.
- Mark build gates Done in Linear as they're truly met (LCH-8 deploy, LCH-9 QA, LCH-10 fallbacks, LCH-11 docs); the *Launch Control v1* row turns from pink to blue as you do.
- `npm run smoke -- <prod url> --passcode <p>`, which must pass.
- Enter the passcode once in the browser you'll present from, before the call.
- Backup if the network fails: the demo data works without Claude or Linear, and the prototype file works offline. Record a 2-minute screen video on the production URL as a last resort.
- Present from Chrome.

## Likely questions
- **How do you know the AI is right?** Every brief is checked against its data in the app, plus an eval: 30/30 same call as the rules engine, 0 invented IDs, 21/21 at-risk tickets cited ([EVAL.md](EVAL.md)).
- **Why keep a rules engine?** It's the floor that never goes down, and it's the benchmark the AI is measured against. The AI adds the judgment and the writing.
- **Why can't the agent write to Linear?** Accountability: a person confirms every tracker change; the server recomputes fixes and applies only confirmed ones.
- **What does it cost?** About a cent per brief, with a passcode, a rate limit and a spend cap on the public URL.
- **How would it scale to Jira or DevRev?** One adapter file behind the `TrackerSource` interface; the rules, agent and UI don't change.
- **What would you measure in production?** Hours of prep per go/no-go, the share of gates with an owner and a date, and how many risks are found before the meeting rather than in it.

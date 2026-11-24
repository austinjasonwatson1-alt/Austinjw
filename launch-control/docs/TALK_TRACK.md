# Launch Control: 2-minute talk track (draft)

Rehearse out loud; aim for 2:00. Clicks are in **bold**.

**0:00 — The problem (20 s)**
"Before a tier 1 launch, product ops spends hours chasing status across seven teams to answer one question: are we ready? The tracker has the answer, but half the tickets have no owner or date, and the riskiest gap is usually the ticket nobody filed. So I built the tool I'd want running launch readiness."

**0:20 — The finding (25 s)**
"The headline is the finding, not a dashboard title: *L1 Triage Agent is at risk, 3 of 10 gates need action, 16 days out.* Each bar runs from today to launch and is built from that launch's gates. Pink means blocked, overdue, due after go/no-go, or no ticket at all. **Click L1.** Support runbook has no ticket. That's the gap a status meeting misses."

**0:45 — The agent (30 s)**
"**Run readiness agent.** This is Claude with three read-only tools over the tracker. You can watch it call `get_gates` and `list_issues`, and it writes the go/no-go brief: recommendation, blocking risks with issue IDs and owners, and a three-line exec update. **Copy exec update.** That's the Slack message to leadership. If Claude is down, a rules engine writes the same brief from the same data, so the review never stalls."

**1:15 — Live data and hygiene (30 s)**
"**Switch to Linear.** Same scores, now from a real Linear workspace; the IDs open the real issues. Reporting is only as good as tracker hygiene, so: **Review fixes.** Assign the team lead, set due dates, nudge stale owners. Nothing is written until a human confirms. **Apply.** The log counts the manual work removed."

**1:45 — How I built it (15 s)**
"I ran it like a launch: a PRD, milestones, and the build's own readiness gates tracked in Linear. Every product and technical decision is in a one-line decisions log, for example why the agent can read but never write."

**2:00 — Stop.** Have ready: [DECISIONS.md](../DECISIONS.md) for follow-ups; the Linear "Launch Control v1" project if they ask about process.

## Before the call
- `npm run seed:linear -- --restore --yes`, so there are fixes to apply live.
- `npm run smoke -- <prod url> --passcode <p>`, which must pass.
- Enter the passcode once in the browser you'll present from, before the call.
- Backup if the network fails: the demo data works without Claude or Linear, and the prototype file works offline.

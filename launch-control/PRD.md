# Launch Control v1 — PRD

**Owner:** Austin Watson · **Status:** In build · **Target:** demo-ready Sat Nov 28, frozen Sun Nov 29 noon · **Used in:** BigPanda interview, Mon Nov 30

## 1. Problem

Before a tier 1 launch, someone in product ops spends hours chasing status across R&D, QA, docs, enablement, support and marketing to answer one question: are we ready? The answer lives in a tracker, but it's scattered, half the tickets are missing owners or dates, and the gaps that hurt most are the ones nobody filed. The go/no-go meeting runs on stale, hand-assembled status.

## 2. Goal

One place that shows every launch's readiness and lets an AI agent write the go/no-go brief from live tracker data, so a product ops manager spends their time fixing risks instead of finding them.

**v1 success criteria**
- Reads real launches and issues from a Linear workspace, with a one-click switch to built-in demo data
- Readiness agent (Claude API with tools) returns a brief in under 30 seconds, citing issue IDs and owners for every risk
- If Claude or Linear fails, the app keeps working (rules-engine brief, demo data) and says so on screen
- Deployed at a public URL; repo on GitHub with a clean README
- Looks and behaves like the approved prototype (`prototype/index.html`)

## 3. Users

- **Primary:** product ops manager running launch readiness (the demo persona)
- **Secondary:** PMs checking their launch; execs reading the status update

## 4. Scope

### In v1
1. **Launch calendar** — every launch as a bar from today to its date, built from gate segments (ready / in progress / at risk). Finding-as-headline at the top ("X is at risk: 3 of 10 gates need action, 16 days out") and 4 KPIs.
2. **Readiness gates** — gates scaled by tier (Tier 1: 10, Tier 2: 7, Tier 3: 3). A gate is **at risk** if any open ticket is blocked, overdue, or due after go/no-go (launch date − 2 days), or if the gate has no ticket. **Ready** when all its tickets are done. Otherwise **in progress**.
3. **Readiness agent** — server-side Claude call with three read-only tools (`list_launches`, `get_gates`, `list_issues`). Streams the brief and a live trace of tool calls to the UI. Fixed output format: Recommendation · Blocking risks · Before go/no-go · Exec update. "Copy exec update" button.
4. **Rules-engine brief** — same format, no AI; default view and automatic fallback.
5. **Tracker hygiene** — flags open tickets with no owner, no due date, no update in 14+ days, or no launch. Demo mode: auto-fix applies instantly. Linear mode: shows proposed fixes; "Apply" writes them to Linear after confirmation.
6. **Manual work removed** — log of automated actions and an estimated minutes-saved counter (45 min per readiness sweep, 3 min per ticket fix; labeled as estimates).
7. **Data source toggle** — Linear | Demo data. Demo data mirrors the prototype's sample org.
8. **Linear seed script** — populates a Linear workspace with the demo org (5 launch projects, ~40 issues, labels) so live mode looks like the demo.

### Not in v1
User accounts or multi-tenant auth · a database · DevRev integration · Slack posting (stretch) · the agent writing to Linear on its own (always a human click)

## 5. Linear data mapping

| Launch Control | Linear |
| --- | --- |
| Launch | Project (in team `LCH`) |
| Launch date | Project target date |
| Milestone (GA, Early access, Minor) | Project description first line, or project label |
| Tier | Project label `Tier 1` / `Tier 2` / `Tier 3` |
| PM | Project lead |
| Gate | Issue label in group `Gate` (`prd`, `eng`, `qa`, `flag`, `sec`, `docs`, `enable`, `support`, `price`, `comms`) |
| Issue status | Workflow state; **Blocked** = a state named Blocked or label `blocked` |
| Owner | Assignee |
| Due | Issue due date |
| Days since update | `updatedAt` |
| Team (for auto-assign) | Issue label in group `Function` (R&D, QA, Docs, PMM, Support, Sales Eng, Security, PM) |

## 6. Technical approach

- **Stack:** Next.js (App Router) + TypeScript, deployed on Vercel. No database.
- **Secrets:** `ANTHROPIC_API_KEY`, `LINEAR_API_KEY`, `LINEAR_TEAM_KEY`, `DEMO_PASSCODE` — server-only env vars, never sent to the browser.
- **Data layer:** one `TrackerSource` interface with two adapters (`demo`, `linear`). Gate scoring, hygiene and the rules brief are pure functions over that data, unit-tested.
- **Agent:** `/api/brief` runs the Claude tool-use loop server-side with `@anthropic-ai/sdk`, streams events (tool call, text delta, done, error) to the client over SSE. Model: `claude-sonnet-5-5`. Hard cap on tool turns and tokens.
- **Cost guard:** the agent button requires `DEMO_PASSCODE` once per browser session when the app is on a public URL; per-IP rate limit (e.g. 10 runs/hour).
- **Resilience:** Linear timeout (5s) → fall back to demo data with a visible banner. Claude error/timeout (45s) → rules brief with a visible note. Last good AI brief per launch cached in localStorage.

## 7. Milestones

| # | Milestone | Done when | Target |
| --- | --- | --- | --- |
| M0 | Setup | Repo on GitHub, skeleton live on Vercel, build project + tickets created in Linear | Mon Nov 23 |
| M1 | UI parity on demo data | All prototype screens work in Next.js from `demo` adapter; logic unit-tested | Tue Nov 24 |
| M2 | Readiness agent | `/api/brief` streams a real brief with tool trace; fallback works | Tue Nov 24 |
| M3 | Linear live | Seed script run; toggle switches sources; scoring matches demo | Wed Nov 25 |
| M4 | Hygiene in Linear | Proposed fixes + confirm-to-apply writes to Linear | Sat Nov 28 |
| M5 | Demo hardening | Passcode, rate limit, error states, README with screenshot, rehearsal on prod URL | Sat Nov 28 |
| — | Code freeze | No changes after this | Sun Nov 29, 12:00 |

## 8. Launch gates (for this build)

Dogfooding: this build runs through its own gates in Linear.
- **Engineering complete:** M0–M3 merged, deployed
- **QA:** full demo script run 3× on the production URL with no errors, on the interview laptop
- **Fallbacks verified:** Linear key removed → demo banner; Claude key removed → rules brief
- **Docs:** README explains the problem, how it works, how to run locally
- **Comms:** 2-minute talk track rehearsed

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Live demo fails on the call | Demo data default; fallbacks; the original artifact as backup |
| API cost from a public URL | Passcode + rate limit + $10 Anthropic spend limit |
| Scope creep before Monday | Anything not in §4 goes to a "v2" Linear label |
| Linear model doesn't map cleanly | Seed script owns the structure; mapping in one file |

## 10. Open questions
- Show the build's own Linear project in the demo as proof of process? (Leaning yes, 15 seconds.)
- Slack posting of the exec update: stretch only if M5 is done by Saturday.

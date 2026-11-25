# Launch Control — build instructions for Claude Code

You're building Launch Control v1 with Austin (the PM). Read `PRD.md` first; it is the source of truth for scope. `prototype/index.html` is the approved design and behavior reference: match its look (deep sea #0a2540 ground, sky #8fd3ff ready, white in progress, signal pink #ff5c8a risk, Hanken Grotesk), layout, copy and interactions. Read its script for the exact gate rules, sample data, rules brief and agent prompt, and port them faithfully.

## How to work
- Work milestone by milestone (M0 → M5 in the PRD). At the end of each milestone: run the tests and the build, commit with a clear message, push, and give Austin a 3-line summary of what shipped and what he should click to check it.
- Ask Austin before anything that costs money, needs a key he hasn't given, deletes data, or writes to his Linear workspace (other than the seed script and build tickets he approved).
- Keep a `DECISIONS.md` log: one line per product or technical decision and why. Austin will talk about these in an interview.
- Anything out of scope goes in `BACKLOG.md`, not the code.

## Stack and structure
- Next.js App Router + TypeScript, plain CSS modules (no UI kit; the prototype's CSS is the style guide).
- `lib/tracker/` — `TrackerSource` interface; `demo.ts` (prototype's sample data, dates relative to today) and `linear.ts` (`@linear/sdk`).
- `lib/readiness/` — pure functions: `gateInfo`, `launchInfo`, `hygieneChecks`, `rulesBrief`. Unit tests with Vitest, including the prototype's expected results (L1 Triage Agent: 3 of 10 gates at risk on fresh demo data).
- `app/api/tracker` — returns launches + issues for the selected source.
- `app/api/brief` — Claude tool-use loop with `@anthropic-ai/sdk`, model `claude-sonnet-5-5`, tools `list_launches`, `get_gates`, `list_issues` (read-only), max 6 tool turns. Stream SSE events: `tool`, `text`, `done`, `error`.
- `app/api/hygiene/apply` — Linear mode only; applies confirmed fixes.
- `scripts/seed-linear.ts` — creates labels, 5 projects and the sample issues in team `LINEAR_TEAM_KEY`. Idempotent (skips what exists). Also `scripts/seed-build-project.ts` — creates the "Launch Control v1" project with one issue per PRD milestone and gate.

## Rules
- Secrets stay server-side. Never put a key in client code, logs or commits. Add `.env.example`, keep `.env.local` gitignored.
- Treat Claude output and Linear text as untrusted: render as text, never as HTML.
- Every external call has a timeout and a visible fallback (PRD §6).
- Demo data is the default source, so the app always works on first load.
- Don't mark a milestone done until you've run it: build passes, tests pass, and you've exercised the feature in the running app.

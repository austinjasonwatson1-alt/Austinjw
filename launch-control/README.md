# Launch Control

One place that shows every launch's readiness and writes the go/no-go brief from live tracker data, so a product ops manager spends their time fixing risks instead of finding them. See [PRD.md](PRD.md) for scope and [DECISIONS.md](DECISIONS.md) for why things are built the way they are.

> Status: M3 (Linear live). Hygiene fixes in Linear (M4) are next. Full README with screenshot lands in M5.

## Run locally

```bash
cd launch-control
npm install
cp .env.example .env.local   # optional: with no keys the app runs on demo data and the rules-engine brief
npm run dev                  # http://localhost:3000
```

```bash
npm test          # Vitest: gate rules, hygiene, rules brief, parser
npm run build     # production build + type check
```

## How it works

- `lib/tracker/` — `TrackerSource` interface; `demo.ts` is the prototype's sample org with dates relative to today; `linear.ts` reads a Linear team; `linear-schema.ts` is the Launch Control ↔ Linear mapping.
- `lib/readiness/` — pure functions: `gateInfo`, `launchInfo`, `hygieneChecks`, `autofix`, `rulesBrief`, `boardSummary`.
- `app/api/tracker` — returns launches + issues for the selected source.
- `components/` — the UI, ported from `prototype/index.html` (the approved design).

**Gate rule:** a gate is *at risk* if it has no ticket, or any open ticket is blocked, overdue, or due after go/no-go (launch date − 2 days). *Ready* when all its tickets are done. Otherwise *in progress*. Tier 1 launches have 10 gates, Tier 2 have 7, Tier 3 have 3.

## Scripts

- `npm run seed:build` — dry run of the "Launch Control v1" build project for Linear (prints the plan). Add `-- --yes` to write it; needs `LINEAR_API_KEY` and `LINEAR_TEAM_KEY` in `.env.local`.

## Readiness agent

`POST /api/brief` runs Claude (`claude-sonnet-5-5`) server-side with three read-only tools — `list_launches`, `get_gates`, `list_issues` — for at most 6 tool turns, and streams Server-Sent Events: `tool` (one per tool call, shown as the live trace), `text`, `done`, `error`. Any failure or a 45 s timeout falls back to the rules-engine brief, and the trace says why. The last good AI brief per launch is cached in the browser and marked stale when tickets change.

## Linear (live mode)

Set `LINEAR_API_KEY` and `LINEAR_TEAM_KEY` in `.env.local`, then switch **Data source → Linear**. A launch is a project in the team with a `Tier 1/2/3` project label and a target date; gates are issue labels in the `Gate` group. See PRD §5 and `lib/tracker/linear-schema.ts`.

```bash
npm run seed:linear            # dry run: what would be created in the team
npm run seed:linear -- --yes   # create states, labels, 5 launch projects and 41 issues (skips what exists)
npm run check:linear           # load live data and compare readiness with the demo, launch by launch
```

If Linear is unreachable, unconfigured or slower than 5 s, the app shows the demo data with a banner saying why.

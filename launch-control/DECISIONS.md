# Decisions

One line per product or technical decision and why. Newest at the bottom.

| Date | Decision | Why |
| --- | --- | --- |
| Nov 24 | Build lives in `launch-control/` inside the `Austinjw` repo on branch `claude/sleepy-keller-uwwoh3`, not a new `launch-control` repo | The build session's GitHub access is scoped to that one repo and can't create repos. The folder is self-contained, so it can be moved to its own repo (or deployed from Vercel with Root Directory = `launch-control`) without changes. |
| Nov 24 | Next.js 16 App Router, React 19, TypeScript 5.9 (not 7) | Latest stable Next. TypeScript 7 (native compiler) is new enough that Next's type-check step is a risk; 5.9 is the safe choice for a demo build. |
| Nov 24 | All domain dates are ISO calendar dates (`YYYY-MM-DD`); scoring takes `asOf` as an input instead of reading the clock | Linear returns absolute dates, the prototype used day offsets. Calendar dates make the rules pure, timezone-free and testable on any date, and the same functions serve both adapters. |
| Nov 24 | The tracker API takes the browser's local date (`?today=`), trusted only within ±1 day of server UTC | The prototype's dates are relative to the viewer's today. A Vercel server runs in UTC, so in US evenings its "today" is tomorrow; without this the demo would shift a day. The clamp stops arbitrary dates. |
| Nov 24 | Every snapshot carries its own `asOf`; UI, rules brief and (later) agent all score against it | One source of "today" per load, so the headline, gates and brief can never disagree. |
| Nov 24 | Gate rule ported exactly: no ticket → blocked → overdue → due after go/no-go, first match is the reason shown; due *on* go/no-go day is not a risk | Matches the prototype and the PRD wording ("due after"). Covered by unit tests, including the L1 = 3 of 10 at risk expectation. |
| Nov 24 | Overdue means due date before today; due today is not overdue | Same as the prototype (`due < 0`). |
| Nov 24 | `rulesBrief`, `boardSummary`, `hygieneChecks`, `autofix` are pure functions returning new data | Lets the UI, the API and the agent's tools share one implementation and keeps tests trivial. |
| Nov 24 | Briefs are parsed into plain data and rendered as React text nodes; no `dangerouslySetInnerHTML` anywhere | CLAUDE.md: Claude output and Linear text are untrusted. The prototype escaped HTML by hand; React does it by construction. |
| Nov 24 | Copy exec update strips `**bold**` markers and stops at the next heading | Paste-ready text for Slack or email; the prototype copied raw Markdown. |
| Nov 24 | Default selected launch is the headline's at-risk launch (L1 on demo data), not a hard-coded `L1` | Same result on demo data, and still sensible on live Linear data where IDs differ. |
| Nov 24 | Tracker fetch has a 5 s timeout; if `/api/tracker` fails, the browser builds the demo snapshot itself and shows a banner | PRD §6: the app always works on first load and says when it fell back. |
| Nov 24 | Added a fallback banner style (pink-edged note) that the prototype didn't have | PRD requires a visible banner; styled with the prototype's risk colour so it reads as part of the same system. |
| Nov 24 | Calendar bars clamp at 0 days (past launch dates) as well as at the 35-day axis | Live Linear data can contain launches whose date has passed; the prototype never did. |
| Nov 24 | Hanken Grotesk via `next/font` (self-hosted at build) instead of a Google Fonts `<link>` | No runtime request to Google, no layout shift, works offline at the interview. |
| Nov 24 | CSS: element styles in `app/globals.css`, everything else copied from the prototype into one CSS module (`components/lc.module.css`) | CLAUDE.md asks for CSS modules with the prototype as the style guide; one file keeps it diffable against the prototype. |
| Nov 24 | In M1 the brief button reads "Run readiness check" and uses the rules engine with the prototype's "Claude is not available" trace | That is the prototype's own no-Claude behaviour; M2 swaps in the agent. |
| Nov 24 | `seed-build-project.ts` supports `--dry-run` and needs `--yes` to write | Writing to Linear needs Austin's go-ahead; the dry run shows exactly what would be created first. |
| Nov 24 | Build-project issues get Gate labels (eng/qa/docs/comms) if they exist, but no Tier label | Keeps the build project out of the launch calendar until we decide the PRD open question about showing it in the demo. |

---
name: betting-card
description: Produce today's sports betting card with betagent. Use when asked to run the daily card, research today's slate, make picks, or update betting research. Pulls and prices the slate, researches each game with web search, writes probability estimates, and (from stage 3) builds the card. Never places bets.
---

# Daily betting card

You are the researcher for `betagent`. The Python tool does odds, math, sizing and tracking; you do the
research and probability estimates. Nothing here places a bet.

## Steps

1. **Set up.** `pip install -r requirements.txt` if imports fail.
2. **Pull and price the slate:** `python -m betagent packet` (add `--date YYYY-MM-DD` or `--league MLB` if asked).
   This writes `data/research/<date>/packet.md` and `packet.json`.
3. **Read the method:** `prompts/research.md` (principles, checklist, probability conversions, output schema).
   Follow it exactly.
4. **Research every game in the packet** with WebSearch / WebFetch. Prioritise late news (lineups,
   starters, goalies, injuries, weather). Keep each fact's URL.
   - With many games (a Saturday college slate), research every game quickly for the key facts
     first. Then go deeper on the games where you found something the line may not reflect.
5. **Write** `data/research/<date>/estimates.json` in the schema from `prompts/research.md`.
6. **Check:** `python -m betagent evaluate`. Fix schema warnings. Revisit anything flagged `suspect`:
   justify it with verified facts, or move it toward the market.
7. **Card** (stage 3+): `python -m betagent card`. It prints the card and saves `cards/<date>.md`.
8. **Save your work:** commit `data/research/<date>/` (and `cards/<date>.md` once it exists) and push to
   the working branch.

## Rules

- Never fabricate facts, stats or sources. Unverified means no adjustment.
- Start from the market's fair price. Move only for specific, verified reasons, sized per `prompts/research.md`.
- Always produce estimates. The tool, not you, decides whether a bet clears the edge bar.
- Report the outcome plainly to the user: how many games were researched, the top edges, anything you couldn't verify.

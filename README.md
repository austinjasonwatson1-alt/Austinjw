# betagent: sports betting research agent

betagent reviews the day's NFL, college football, MLB and NHL slate. It prices every market, researches the games,
and hands you a **card** of its best picks with confidence levels and reasons. You place the bets yourself, on
Polymarket or anywhere else. **betagent never places a bet.** It only researches and recommends.

The repo also contains `mlb_predictor.py`, a standalone sabermetric MLB win-probability model. See
[MLB predictor](#mlb-predictor-mlb_predictorpy) below.

## Build status

| Stage | What it adds | Status |
|---|---|---|
| 1. Odds pipeline + math | Slate, odds from all sources, no-vig fair prices, line shopping, Kelly, tests | **done** |
| 2. Research | Research packet → Claude Code researches each game with web search → cited estimates → EV check | **done** |
| 3. Card | Edge filter, Kelly sizing, parlays, dated markdown card | next |
| 4. Tracking | SQLite log, auto-grading from final scores, record / units / ROI / calibration report, feedback into prompts | planned |

## How it works: the tool and the researcher

No Anthropic API key is needed. The research is done by a **Claude Code session**, running on your
Claude subscription and using its web search. The Python tool handles everything numeric. They
talk through files in `data/research/<date>/`:

```
betagent packet        ->  packet.md / packet.json    priced slate: fair %, best price + book, line movement
Claude Code researches ->  estimates.json             cited facts, judgment, a probability per bet
betagent evaluate      ->  our % vs fair, EV at the best price, EDGE / suspect flags
betagent card          ->  cards/<date>.md            (stage 3)
```

To run it, open Claude Code in this repo and say **"run today's betting card"**. The
`betting-card` skill (`.claude/skills/betting-card/SKILL.md`) walks the session through every step.
The research method (principles, checklist, how far to move off the market, the output schema) lives in
`prompts/research.md`. Edit that file to change how the agent thinks.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env        # optional: ODDS_API_KEY for more sportsbooks
python -m pytest -q tests
```

## Usage

```bash
python -m betagent packet                                 # write today's research packet
python -m betagent evaluate                               # check estimates.json against live prices
python -m betagent slate                                  # today's slate, all leagues, main lines
python -m betagent slate --league MLB --game yankees      # one league / one game
python -m betagent slate --date 2026-10-04 --league NFL
python -m betagent slate --all-lines                      # include alternate spreads / totals
python -m betagent slate --dry-run                        # no paid API calls (Odds API from cache only)
python -m betagent slate --refresh                        # ignore the cache
```

Each side shows:
- **fair**: the no-vig consensus win probability.
- **best**: the best price across books, and which book has it.
- **mktEV**: EV at that best price if the fair probability were exactly right.
- **open**: DraftKings' opening price, for line movement.
- The other books' prices.

## Data sources

| Source | Key? | Provides |
|---|---|---|
| ESPN scoreboard | no | Schedule, status, venue and indoor flag, final scores, DraftKings lines (opening and current) |
| Polymarket Gamma API | no | Moneyline / spread / total share prices on the market you bet into. Buy price = ask; fair = mid |
| The Odds API | `ODDS_API_KEY` (optional) | Many sportsbooks, for wider line shopping. About 12 credits per full daily run, and the cache makes reruns free |

- **If a source fails:** the run continues without it and lists the failure under *Notes*. If an earlier copy of that source's data is cached, the run uses it.
- **Caching:** results are cached under `data/cache/<date>/`. Free sources refresh every 15 minutes. The Odds API is fetched once per day.

## How the math works (`betagent/oddsmath.py`)

- **Implied probability** = 1 / decimal odds. A Polymarket share at price *p* has decimal odds 1/*p*.
- **Vig removal**: multiplicative (default), additive or power, set by `pricing.devig_method`.
  - For a prediction market, the midpoint between bid and ask is used as the vig-free probability.
- **Fair price**: the weighted average of each book's no-vig probability. Weights are set in `pricing.book_weights`.
  - Sharper markets such as Pinnacle and Polymarket count more.
- **Main line**: the spread or total that the most sportsbooks offer. Polymarket's alternate lines are still shown with `--all-lines`.
- **Kelly**: f* = (p·d − 1)/(d − 1). The stake is f* × `kelly_fraction` × `bankroll_units`, capped at `max_units_per_bet`.

## Configuration

Every threshold lives in `config.yaml`: leagues, bet types, unit size ($100), bankroll, Kelly fraction (¼),
per-bet cap, daily caps (off by default), minimum edge (3%), minimum picks per day, parlay settings, book
weights, source settings and cache TTLs.

## Project layout

```
betagent/
  oddsmath.py        odds conversions, vig removal, EV, Kelly, parlays, settlement
  market.py          group quotes by line, no-vig consensus, line shopping, main-line pick
  slate.py           build the day's priced slate from all sources
  sources/           espn.py, polymarket.py, oddsapi.py
  teams.py           cross-source team-name matching
  cache.py, http.py  on-disk cache, retrying HTTP session
  config.py          config.yaml + .env loading and validation
  research/          packet.py (packet for the researcher), estimates.py (schema, validation, EV)
  display.py, cli.py terminal output and commands
prompts/research.md  the researcher's method; edit to tune the agent
.claude/skills/betting-card/SKILL.md   daily workflow for a Claude Code session
data/research/<date>/  packets and estimates (committed, so there's a record of every call)
config.yaml
tests/               odds math, market pricing, source parsing, cache, end-to-end with mocked HTTP
```

---

## MLB predictor (`mlb_predictor.py`)

`mlb_predictor.py` predicts the winner of every game on an MLB slate. For each game it gives a win probability, an
80% uncertainty band and a one-line "Reason Why" backed by the stats.

```bash
python mlb_predictor.py                        # today's slate (ET); tries the live MLB Stats API, uses simulated data if unreachable
python mlb_predictor.py --date 2026-09-24
python mlb_predictor.py --source simulate      # offline demo slate
python mlb_predictor.py --train-csv history.csv --csv-out picks.csv
```

| Stage | What it does |
|---|---|
| **Ingestion** | Reads the schedule, probable starters, pitcher hand, pitcher season and last-30-day lines, team hitting splits vs LHP/RHP, bullpen or whole-staff pitching and home/road records from `statsapi.mlb.com`. Uses 12 parallel workers, retries and a cache. |
| **Features** | SP SIERA, SP xFIP, SP K-BB% over the last 30 days, park-adjusted wRC+ against the hand of the opposing starter, bullpen SIERA, home W% vs the opponent's road W%, team strength (Pythagorean W% from run differential), each starter's projected HR/9 in today's park, and the run park factor. Every rate is regressed toward league average by sample size and carries a standard error. |
| **Model** | 60/40 blend of a Logistic Regression and a monotonic-constrained `HistGradientBoostingClassifier`, then a small log-odds shift for playoff status. |
| **Output** | Pick, tier (STRONG / LEAN / TOSS-UP), win probability, and an 80% Monte Carlo band from stat sample-size error. |

**Caveats:**
- By default the model trains on a simulated *structural baseline*. For real validation, supply `--train-csv` with historical rows.
- SIERA and xFIP are estimated from groundOuts and airOuts.
- `LeagueConstants`, `PARK_FACTORS` and `HR_PARK_FACTORS` should be refreshed each season.

---

For research and entertainment only. Nothing here is betting advice, and no outcome is guaranteed. Bet only what you
can afford to lose. If gambling stops being fun, call 1-800-GAMBLER.

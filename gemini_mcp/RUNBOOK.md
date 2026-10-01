# Runbook

This is how to operate gemini_mcp day to day on a Mac. Run every command from the `gemini_mcp` folder. `py` below means `.venv/bin/python`.

## 1. First-time setup

1. **Python 3.10+**. The MCP SDK needs it; the test suite runs green on 3.10 to 3.13. macOS's Command Line Tools ship Python **3.9, which is too old**: `brew install python@3.12` (or use the python.org installer). Then clone the repo and `cd gemini_mcp`. `setup_mac.sh` finds a newer `python3.1x` on its own, or tells you exactly what to install.
2. Run `./setup_mac.sh`. It's idempotent, so you can re-run it any time. It does the following:
   - Creates `.venv` and installs the requirements.
   - Creates `.env` from `.env.example` only if `.env` doesn't exist. It never overwrites or prints `.env`.
   - Runs `chmod 600 .env` and `chmod 700 state/`.
   - Checks that `.env` is gitignored and that no key file is tracked.
   - Prints what preflight still needs.
3. **Gemini API key** (Gemini website → Settings → API):
   - Make it account-scoped, with time-based nonces.
   - Use the **Auditor** (read-only) role while in DRY_RUN. Switch to **Trader** only when going live.
   - **Never** give it the Fund Manager role, which can withdraw.
   - Leave "Requires Heartbeat" off.
   - Put the key and secret in `.env` with an editor. Add `ANTHROPIC_API_KEY` for research.
4. **`config.yaml`:**
   - `starting_balance_usd`: the balance you start trading with. The equity floor is measured from it.
   - `allowed_event_tickers`: exactly the events you mean to trade. A ticker containing deposit, withdraw, transfer, address, fund or bank is refused by the client.
   - Check `fee_per_contract` against Gemini's fee schedule, then set `fee_confirmed: true`.
   - Keep the caps tiny: `max_order_usd: 2`, `max_daily_spend_usd: 5`, `max_trades_per_day: 5` (buys). Exits have their own ceiling, `max_exits_per_day: 10`.
5. Run `py verify_auth.py`. It makes read-only signed calls and writes `state/verify_auth_ok.json`, which preflight requires in live mode (under 24 h old, same `GEMINI_ENV`).
6. Run `py -m pytest -q tests`. It's offline and should be all green.
7. Run `py preflight.py`. In DRY_RUN it lists what's missing for live, and it must print `OK` before you go live.
8. **Prediction-market terms:** accept them yourself on the Gemini website.

## 2. Daily operations (DRY_RUN)

- **Run once by hand:** `DRY_RUN=true py runner.py`. It reviews paper positions, then scans the allowlist. Each run's research budget is `max_research_per_run` calls (at most 20; above 5 it needs both `max_research_cost_usd_per_run` and `max_research_cost_usd_per_day`) and the dollar caps `max_research_cost_usd_per_run` / `_per_day`. `run_end` shows the run's estimated research cost. To limit a trial to a few markets, shrink `allowed_event_tickers` and `max_research_per_run`.
- **Scheduling (optional):** see section 6. It's DRY_RUN only.
- **Screening (optional, off by default):** set `screening_enabled: true` to put a cheap first pass before full research. A smaller model, `GEMINI_MCP_SCREEN_MODEL` in `.env` (default `claude-haiku-4-5`), makes a quick estimate with at most 1 web search. Only contracts whose screening estimate is at least `screen_min_edge` (0.08) away from the market mid get full research. The rest are logged as `no_trade` "screened out", with `screen_estimate`, `screen_market_mid`, `screen_model` and `screen_cost_usd`. A failed screen is never followed by full research. Both stages are logged as `research_cost`, with `stage` and `model`, and count toward the research cost caps. Screens don't use up `max_research_per_run`. Position reviews are never screened. Set `screen_input_usd_per_mtok` / `screen_output_usd_per_mtok` if you change the screening model. Check the RESEARCH ECONOMICS table to see whether screening pays for itself.
- **Look at it:** `py report.py --json > report.json`, then `py dashboard.py`, then open `dashboard.html`. Start with the **Needs attention** panel.
- **Daily checks:**
  - KILL file? Breaker trips?
  - Unknown orders? Follow section 5 for each one.
  - Today's spend and trade count against the limits.
  - Rejections you don't understand.
  - Theses whose sources look wrong or irrelevant.
- **Weekly:** `py report.py`. See section 7 for how to read it.

## 3. How to stop everything

Do these in order. Each step is enough on its own to stop new orders.

1. `touch KILL`. Every order tool (propose, confirm and cancel) refuses immediately, in every server process, and the runner won't start. The breakers also create `KILL` themselves when they trip. They're checked on every proposal and confirmation, and at the start of every runner run, before any research.
2. **Stop the schedule:**
   - `launchctl bootout gui/$(id -u)/com.gemini-mcp.dryrun`
   - `launchctl disable gui/$(id -u)/com.gemini-mcp.dryrun`, so it won't come back at login.
3. **Stop any server:** quit Claude Desktop, or remove the MCP server from Claude Code with `claude mcp remove gemini-pm`. Stop any running `runner.py` with Ctrl-C.
4. **Cancel resting orders on the Gemini website.** `cancel_order` is blocked while `KILL` exists, by design.
5. **If you suspect the key leaked, revoke it** on the Gemini website (Settings → API). Then rotate `ANTHROPIC_API_KEY` as well.

**To resume:** fix the cause first. Then `rm KILL`; the deletion is logged as `kill_deleted`. If a breaker created the KILL file:
- the drawdown peak restarts from current equity;
- the daily-loss baseline doesn't reset that day;
- the equity floor never resets. While equity is below it, every order trips it again.

If `state/risk_state.json` goes missing after trading, orders are refused rather than silently resetting the breakers. Restore it from a backup. If you really mean to start over, also delete `state/daily_spend.json`. Today's audit entries still set a minimum for today's spend.

## 4. What each `audit.log` event means

Each line of `audit.log` is one JSON record, with timestamps in UTC.

| Event | Meaning |
|---|---|
| `proposal` | `propose_order` passed every guardrail. It includes the token's hash prefix, the trade, the resolved event and the sizing. Nothing is placed. |
| `rejection` | A guardrail refused the action. `reason` says why. |
| `confirmation` | `confirm_order` re-checked everything with fresh data. Spend and the trade count were recorded just before this line. |
| `would_place` / `would_cancel` | DRY_RUN only: what would have been sent. Each `would_place` carries `paper_order_id` and `paper_filled`. |
| `order_intent` | Live only. Written and fsync'd **before** a placement or cancel is sent. It carries an `intent_id`. |
| `order_result` | Live only. It carries the same `intent_id`, and `result` is one of the values below. Like `confirmation` and `order_intent`, it records `contract_expiry` and `confirmed_by` (`hand` / `auto`), which preflight's fast-track gates count (section 9). |
| `circuit_breaker_trip` | The floor, drawdown or daily-loss breaker tripped and created `KILL`. It includes the equity, the thresholds and the open positions. |
| `breaker_reset` | `KILL` was deleted after a trip, and the drawdown peak was re-baselined. |
| `kill_detected` / `kill_deleted` | A KILL file appeared or was removed. Deletions are always manual. |
| `research_cost` | Runner only. One per research call (DRY_RUN or live, succeeded or failed): `stage` (`screen` or `full`), the `model`, the estimated cost (`research_cost_usd`) from token and search counts at that stage's config prices, plus the run's and the day's totals so far. Unknown usage is charged a conservative estimate (`usage_known: false`). |
| `decision` | Runner only. Every run decision is a `decision` event; its `kind` field is listed below. |

The `order_result` values:
- `placed`: a confirmed order id, with status open or filled.
- `failed`: Gemini definitely refused it (a 4xx), or it was refused before sending.
- `unconfirmed`: a timeout, a 5xx, or a reply that didn't confirm it. **The outcome is unknown.** See section 5.
- `cancelled`: the cancel was positively confirmed.
- `cancel_failed`: Gemini refused the cancel.

The decision `kind` values:
- `run_start` (with a risk snapshot) and `run_end`.
- `entry`, `exit`, `hold`.
- `skip`: held, or an order is already resting.
- `no_trade`: with the reason (spread, thin book, edge, sources, server rejection, no expiry, "outside expiry window": the contract expires sooner than `min_hours_to_expiry` or later than `max_days_to_expiry`; such contracts are never researched; "screened out" / "screening failed": see Screening in section 2).
- `entry_failed` / `exit_failed` / `review_failed` / `exit_rejected`.
- `proposed_not_confirmed`: live, with no terminal approval.
- `run_skipped`: KILL was present when the runner started.
- `research_budget_reached`: logged once per run when the next research call would pass `max_research_cost_usd_per_run` or `max_research_cost_usd_per_day` (projected at the costliest call seen today). No more research runs that run; later contracts are logged as `no_trade` and positions as `hold` ("research cost budget reached").
- `run_stopped`: the run-start breaker check (`check_circuit_breakers`) tripped a breaker (KILL created), found KILL, or couldn't complete (for example, balances unreadable). The run ends before any research or proposal.

## 5. An order shows "unknown, check Gemini"

The order was sent, but whether it exists is unknown: a timeout, a 5xx, or a reply without a usable order id. It may be live right now. Nothing is ever retried automatically, and its spend and trade count stay recorded.

1. **Don't propose the same trade again** until you know.
2. Find the order:
   - On the Gemini website, look in Orders (open and history). Match it on time (the `order_intent` timestamp is UTC), symbol, side, outcome, quantity and price. The dashboard and `report.py` show all of these.
   - Or, in Claude, use `list_open_orders`, or `get_order_status` if you have an order id.
3. **If it exists and is open,** decide to keep it or cancel it. If KILL is present, cancel on the website. The guardrails already count it: resting buys count toward exposure, and resting sells reserve the contracts.
4. **If it exists and filled,** it's a position now. The next runner review picks it up.
5. **If it doesn't exist,** nothing to do. The day's spend stays counted, which is conservative.
6. Write down what you found. The entry stays listed as unknown in the dashboard and report, because the log is append-only (see OVERNIGHT_NOTES.md, Q7).

## 6. Scheduling (DRY_RUN only)

```bash
mkdir -p ~/Library/Logs/gemini_mcp
cp launchd/com.gemini-mcp.dryrun.plist.template ~/Library/LaunchAgents/com.gemini-mcp.dryrun.plist
# edit it: replace /ABS/PATH and YOUR_USER; set <key>Disabled</key><false/> only when you mean to start it
.venv/bin/python launchd/validate_plist.py ~/Library/LaunchAgents/com.gemini-mcp.dryrun.plist   # must print OK
plutil -lint ~/Library/LaunchAgents/com.gemini-mcp.dryrun.plist                                  # macOS's own check
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gemini-mcp.dryrun.plist
launchctl enable gui/$(id -u)/com.gemini-mcp.dryrun
launchctl kickstart gui/$(id -u)/com.gemini-mcp.dryrun     # one run now, to test
```

The job sets `DRY_RUN=true` and `GEMINI_MCP_SCHEDULE=dry_run_only`. `runner.py` refuses to start, with exit code 3, if that marker is set while `DRY_RUN` isn't dry. Live scheduling would need all of these, and isn't provided: `--auto-confirm`, `runner_auto_confirm_live: true` in config, `DRY_RUN=false`, and removing the marker. See `launchd/README.md`.

## 7. Reading the report

`py report.py` prints realized vs expected return by **stated edge bucket**: under 5%, 5–10%, 10–20%, 20%+, plus "no estimate" and ALL. Use `--live` for live fills.

| Column | Meaning |
|---|---|
| `trades / closed / open` | Lots per bucket. A lot is closed when sold or settled. |
| `exp` / `exp(raw q)` | Mean expected return at entry, using the shrunk estimate `q_adj` (or the raw estimate), after fees. |
| `realized` | Mean realized return of closed lots, **after fees**: `fee_per_contract` is charged on entry and exit. |
| `P&L $`, `RoC` | Dollar P&L and return on cost of closed lots. |
| `win rate` vs `mean q_adj` | Calibration of the lots held to settlement. |
| `N`, `Brier me` / `Brier mkt` | Resolved contracts scored, and the Brier score of my estimate against the market's price at decision time. Lower is better. |
| `flag N<30` | Too few to conclude anything. |

The **ALL RESEARCHED CONTRACTS** line scores every estimate, traded or not, one per contract per day. It is the best test of whether the research beats the price at all.

**PAPER vs LIVE FILLS** (`--live` only). Every live order records, at confirm, the fill paper mode would have assumed at that same moment (`paper_assumed` in `confirmation`, `order_intent` and `order_result`): filled in full at the limit price if the limit was at or beyond the current price, plus `fee_per_contract`. The report compares that with the real fill in Gemini's order history, per contract, signed so that **positive = live worse**:

| Row | Meaning |
|---|---|
| `price gap $` | Buy: real average price − assumed price. Sell: assumed − real. |
| `fee gap $` | Real fee per contract − `fee_per_contract`. Shows n/a when order history has no fee field (the field is unverified; see `docs/real_response_check.md`). Check fees on Gemini's site by hand meanwhile. |
| `fill shortfall` | Contracts paper assumed filled that live did not fill. |

Each row shows N, the average and the worst. Orders still open, or placed before this was recorded, are counted under "not compared". With N ≥ 5, the report flags **LIVE FILLS CONSISTENTLY WORSE THAN PAPER ASSUMED** when at least 2 of 3 orders filled worse or the average gap is positive. Paper results then overstate live: stop scaling up and investigate (see Fast track).

**RESEARCH ECONOMICS** shows, for paper (DRY_RUN) and live separately, whether the research pays for itself. The research money is real in both modes.

| Row | Meaning |
|---|---|
| `research spend $` | Sum of the `research_cost` estimates in `audit.log`. |
| `trades entered` | Runner `entry` decisions. |
| `research $ per trade` | Research spend ÷ trades entered. |
| `avg stated edge` | Mean `edge` recorded at entry (after fee, per contract). |
| `expected edge value $/trade` | Stated edge × stake, computed as (q_adj − price) × quantity, averaged over entries. |
| `fee $/trade` | `fee_per_contract` × quantity. |
| `expected net edge $/trade` | Expected edge value − fee − research $ per trade. |
| `P&L after research $` | Realized P&L of closed lots − research spend. Live P&L needs `--live`. |

It flags **RESEARCH COSTS MORE PER TRADE THAN THE EXPECTED EDGE** when research $ per trade is more than the expected edge value after fees, or when research was spent and nothing was entered. Then the research is losing money before any trade does: lower `max_research_per_run` or the cost caps, turn on screening (`screening_enabled`), or narrow the allowlist.

## 8. Going-live criteria (all must hold)

**Failing any criterion means keep paper trading** on this track, with no partial credit. The only other route to live money is the **Fast track** (section 9), which has its own gates and stays at micro-live size until they are met.

| # | Criterion | Where to check it |
|---|---|---|
| 1 | **At least 4 weeks of paper trading** (DRY_RUN), with the runner running normally over that time. | `audit.log` dates, or the dashboard's equity chart. |
| 2 | **At least 30 settled trades**: paper trades whose contracts have resolved. | `py report.py`, ALL row: `N ≥ 30`, and no `N<30` flag. |
| 3 | **My Brier score beats the market's on the traded contracts.** | `py report.py`, ALL row: `Brier me` is lower than `Brier mkt`. The ALL RESEARCHED CONTRACTS line is useful context, but this criterion is about the contracts actually traded. |
| 4 | **A positive return after confirmed fees.** | First check `fee_per_contract` against Gemini's fee schedule and set `fee_confirmed: true`. Then, in `py report.py`, the ALL row's `P&L $` and `realized` are both above 0. Fees are charged on entry and exit. |
| 5 | **Paper drawdown never past half of `max_drawdown_pct`** at any point in the paper period (with the default 0.20, never deeper than 10%). | The dashboard's **Worst drawdown seen** tile, measured against a running peak over the whole history. The dashboard also raises a "needs attention" warning when it's past half. |

Before the first live order, also:
- `py preflight.py` with `DRY_RUN=false` must print OK. That covers `starting_balance_usd`, `fee_confirmed`, the allowlist, the risk bounds, untracked secrets, a fresh `verify_auth`, and the micro_live ceilings with `learning_budget_usd` set (section 9).
- Accept the prediction-market terms on the website.
- Use a key with the Trader role only (never Fund Manager).
- Run `py capture_samples.py` and fix any ABSENT or EMPTY required field. See `docs/real_response_check.md`.

**First live orders:**
- **Manual confirmation:** run the runner from a terminal and type `yes` for each order. No schedule, no `--auto-confirm`, and `runner_auto_confirm_live: false`.
- **Small size:** set `profile: micro_live` (section 9) and keep only a few events on the allowlist. Start in the sandbox if it works.
- **A human check of the fill against Gemini's site:** after each confirmed order, open the order on the Gemini website and check the side, outcome, quantity, price, status and fill. Compare them with the `order_result` line in `audit.log` and with the dashboard. Any mismatch: `touch KILL` and investigate before anything else.

## 9. Fast track

A shorter route to live money than section 8: start at micro-live size early, and earn each step up with live evidence instead of weeks of paper trading. **This track still keeps every breaker, cap, and the endpoint allowlist.** Nothing is switched off: KILL, the equity floor, drawdown and daily-loss breakers, the per-order, daily-spend, trade, exit and open-order caps, the event allowlist, the endpoint allowlist, the expiry window and the research cost caps all apply as usual. Scheduled (launchd) runs stay DRY_RUN only.

**micro_live** is the profile in `config.yaml` (`profile: micro_live`). Its ceilings are `max_order_usd 5`, `max_daily_spend_usd 15`, `max_trades_per_day 4`, `max_open_orders 2` and `runner_auto_confirm_live false`. Live mode also always needs `learning_budget_usd` set. The equity floor is then `starting_balance_usd - learning_budget_usd`, never below 40% of the starting balance: decide what you are prepared to lose while learning (for example 30 of a 100 balance gives a floor of 70).

Live preflight enforces the ceilings whatever profile is active, and **there is no override**: going above them is unlocked only by the history in `audit.log`, counted as described below. DRY_RUN preflight prints the same checks as notes.

**Gates (in order; each one must hold before the next step):**

1. **Micro-live may start after** all of these:
   - **A clean dry run:** a full `DRY_RUN=true py runner.py` pass with the same config (`profile: micro_live`) that ends with `run_end`, no `run_stopped`, `entry_failed`, `exit_failed` or `review_failed`, nothing on the dashboard's **Needs attention** panel, and no orders listed as unknown in `py report.py`.
   - **`py verify_auth.py`** succeeded for the `GEMINI_ENV` you will trade in, within the last 24 hours.
   - **`py capture_samples.py`** ran with no ABSENT or EMPTY required field (see `docs/real_response_check.md`).
   - `py preflight.py` with `DRY_RUN=false` prints OK, with `fee_confirmed: true` and `learning_budget_usd` set.
   Then trade live from a terminal, typing `yes` for each order, and check every fill against Gemini's site (section 8, "A human check of the fill").
2. **Scale up only after about 20 settled trades with no unexplained fill/fee differences.** Preflight refuses any live limit above the micro_live ceilings until `audit.log` shows **at least 20 settled live trades** (rule below). The judgement part is yours: `py report.py --live` shows no **LIVE FILLS CONSISTENTLY WORSE THAN PAPER ASSUMED** flag, every nonzero price or fee gap in the PAPER vs LIVE table has a reason you wrote down, and the fees you saw on Gemini's site match `fee_per_contract`. Then raise limits in small steps.
3. **Auto-confirm only after about 15 clean hand-confirmed live trades.** Preflight refuses `runner_auto_confirm_live: true` in live mode until `audit.log` shows **at least 15 hand-confirmed live trades** that ended "placed" since the last unconfirmed or unknown result (rule below). Each should also have been checked against Gemini's site with no mismatch. Auto-confirm still never runs from the launchd schedule.

**Exact counting rules** (`preflight.fast_track_counts`). Only entries for live orders in the current `GEMINI_ENV` count (their `mode` is that environment's live label, for example `LIVE (production): REAL MONEY`). Sandbox history never unlocks production. If `audit.log` is missing or unreadable, it counts as zero (both counts).

- **Settled live trade:** an `order_result` with `result "placed"`, `side "buy"`, placement `status "filled"`, and a recorded `contract_expiry` that is before now. Each order id counts once. Not counted:
  - orders that were resting (`open`) when placed, because `audit.log` has no evidence they filled later;
  - exits;
  - entries written before `contract_expiry` was recorded.
  Expiry passing is the closest stand-in for "resolved" that `audit.log` can show.
- **Hand-confirmed live trade:** an `order_result` with `result "placed"` and `confirmed_by "hand"`, whose runner decision (`order_ref` `live:<id>`) also says `confirmed_by "hand"`. Only the runner sends `"hand"`, and only after someone typed `yes` at the terminal. Entries and exits both count, and each order id counts once.
- **Clean:** walking the log in order, the hand-confirmed count restarts at 0 at:
  - every live `order_result` with `result "unconfirmed"`;
  - every live `order_intent` that never got an order_result (outcome unknown);
  - every line that is not valid JSON.
  A definite `failed` result doesn't restart it.

If a gate fails after you've passed it (a fill mismatch, an unknown order, the worse-fills flag, a breaker trip), go back a step: set `profile: micro_live` again (or `touch KILL`), and investigate before trading again. An unknown result restarts the auto-confirm count on its own.

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

- **Run once by hand:** `DRY_RUN=true py runner.py`. It reviews paper positions, then scans the allowlist. Each run's research budget is `max_research_per_run`. To limit a trial to a few markets, shrink `allowed_event_tickers` and `max_research_per_run`.
- **Scheduling (optional):** see section 6. It's DRY_RUN only.
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
| `order_result` | Live only. It carries the same `intent_id`, and `result` is one of the values below. |
| `circuit_breaker_trip` | The floor, drawdown or daily-loss breaker tripped and created `KILL`. It includes the equity, the thresholds and the open positions. |
| `breaker_reset` | `KILL` was deleted after a trip, and the drawdown peak was re-baselined. |
| `kill_detected` / `kill_deleted` | A KILL file appeared or was removed. Deletions are always manual. |
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
- `no_trade`: with the reason (spread, thin book, edge, sources, server rejection, no expiry).
- `entry_failed` / `exit_failed` / `review_failed` / `exit_rejected`.
- `proposed_not_confirmed`: live, with no terminal approval.
- `run_skipped`: KILL was present when the runner started.
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

## 8. Going-live criteria (all must hold)

**Failing any criterion means keep paper trading.** No exceptions, and no partial credit.

| # | Criterion | Where to check it |
|---|---|---|
| 1 | **At least 4 weeks of paper trading** (DRY_RUN), with the runner running normally over that time. | `audit.log` dates, or the dashboard's equity chart. |
| 2 | **At least 30 settled trades**: paper trades whose contracts have resolved. | `py report.py`, ALL row: `N ≥ 30`, and no `N<30` flag. |
| 3 | **My Brier score beats the market's on the traded contracts.** | `py report.py`, ALL row: `Brier me` is lower than `Brier mkt`. The ALL RESEARCHED CONTRACTS line is useful context, but this criterion is about the contracts actually traded. |
| 4 | **A positive return after confirmed fees.** | First check `fee_per_contract` against Gemini's fee schedule and set `fee_confirmed: true`. Then, in `py report.py`, the ALL row's `P&L $` and `realized` are both above 0. Fees are charged on entry and exit. |
| 5 | **Paper drawdown never past half of `max_drawdown_pct`** at any point in the paper period (with the default 0.20, never deeper than 10%). | The dashboard's **Worst drawdown seen** tile, measured against a running peak over the whole history. The dashboard also raises a "needs attention" warning when it's past half. |

Before the first live order, also:
- `py preflight.py` with `DRY_RUN=false` must print OK. That covers `starting_balance_usd`, `fee_confirmed`, the allowlist, the risk bounds, untracked secrets and a fresh `verify_auth`.
- Accept the prediction-market terms on the website.
- Use a key with the Trader role only (never Fund Manager).
- Run `py capture_samples.py` and fix any ABSENT or EMPTY required field. See `docs/real_response_check.md`.

**First live orders:**
- **Manual confirmation:** run the runner from a terminal and type `yes` for each order. No schedule, no `--auto-confirm`, and `runner_auto_confirm_live: false`.
- **Small size:** keep the tiny caps (`max_order_usd: 2`, `max_daily_spend_usd: 5`) and only a few events on the allowlist. Start in the sandbox if it works.
- **A human check of the fill against Gemini's site:** after each confirmed order, open the order on the Gemini website and check the side, outcome, quantity, price, status and fill. Compare them with the `order_result` line in `audit.log` and with the dashboard. Any mismatch: `touch KILL` and investigate before anything else.

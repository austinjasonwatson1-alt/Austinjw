# Gemini Prediction Markets MCP server and runner

This is a local MCP server for Gemini prediction markets. It lets Claude look up markets and place and manage **limit** orders. A research-driven runner sits on top of it.

It can move real money, so every limit is enforced in the server's code, not in prompts. The runner has no way to act except by calling the server's tools.

| File | Role |
|---|---|
| `gemini_client.py` | Gemini REST calls, plus the public WebSocket order-book snapshot. Contains a `ReadOnlyClient`, and a `TradingClient` that adds only *place limit order* and *cancel order*. There's nothing for withdrawals or transfers. |
| `guardrails.py` | Every check: limits, Kelly sizing (`size_position`), the order-book check (`check_book`), circuit breakers, tokens, the daily-spend ledger, the paper ledger, the kill switch and the audit log. |
| `server.py` | MCP tool definitions (FastMCP, stdio). |
| `runner.py` | Researches markets, decides entries and exits, and calls the server's tools. |
| `research.py` | Claude with web search: reads the resolution rules, then estimates P(YES). |
| `report.py` | Realized vs expected return by edge bucket, plus a summary of decisions. |
| `config.yaml` | Limits, sizing, breakers and runner settings. It's re-read on every propose and confirm. |
| `verify_auth.py` | Read-only check that request signing works. Writes `state/verify_auth_ok.json` on success. |
| `capture_samples.py` | Read-only: captures one positions and one open-orders response, redacted, into `samples/real/` (gitignored), and reports which documented fields were present, absent or empty. |
| `preflight.py` | Pre-flight checks (see the going-live checklist). Run at server and runner startup. |

Endpoints follow Gemini's docs: the [Prediction Markets API](https://developer.gemini.com/prediction-markets-spec), [WebSocket streams](https://developer.gemini.com/prediction-markets/websocket/streams) and [API key auth](https://developer.gemini.com/authentication/api-key).

## Tools

| Tool | Effect |
|---|---|
| `list_markets(search, status)` | Read-only. Events, contracts, best bid and ask, and whether each event is allowlisted. |
| `get_market(event_ticker)` | Read-only. Contract details, resolution text, terms links and child events. |
| `get_order_book(instrument_symbol)` | Read-only. A top-20 depth snapshot from Gemini's public WebSocket. Prices are in YES space. |
| `get_balances()` | Read-only. Balances, plus a risk summary: equity, peak, start-of-day equity, the daily limit and breaker status. Paper figures in DRY_RUN. |
| `get_positions()` | Read-only. Account positions. `review_positions` holds the paper positions in DRY_RUN. |
| `propose_order(instrument_symbol, outcome, side, limit_price, quantity?, my_probability?)` | Runs every guardrail and returns a preview and a one-time token. **Places nothing.** For a buy with `my_probability`, the server picks the quantity itself using Kelly sizing. A sell needs `quantity`. |
| `confirm_order(token)` | Uses up the token and re-checks every cap on the frozen order. Then it places the order, or in DRY_RUN records a paper order. |
| `cancel_order(order_id)` | Cancels an order. In DRY_RUN it only logs. |
| `get_order_status(order_id)` | Looks in open orders, then order history. Returns `not_found` rather than guessing. |
| `list_open_orders()` | Read-only. |

`limit_price` is the price of the outcome being traded, strictly between 0 and 1. A winning contract pays $1.00.

## Guardrails (server-enforced)

`propose_order` runs all of these, and `confirm_order` runs them again with fresh data:

1. **Kill switch.** If a `KILL` file exists, `propose_order`, `confirm_order` and `cancel_order` all refuse. It's checked once more right before the order is sent.
2. **Input.** `outcome` must be exactly `yes` or `no`, and `side` exactly `buy` or `sell`. Every order is a limit order, good-til-cancel. A missing price or `"market"` is rejected.
3. **Allowlist (exact match, fails closed).** The contract must belong directly to exactly one event in `allowed_event_tickers`. The resolved event ticker is logged with every proposal.
4. **Market state and grid.** The event and contract must be active and open. Price and quantity must fit the contract's own minimums and increments.
5. **Circuit breakers.** See below. A trip creates `KILL` automatically.
6. **Buys:**
   - the absolute dollar ceiling `max_order_usd`;
   - `max_order_pct_of_balance` of equity;
   - `max_market_pct_of_balance` per event, counting the existing position (the larger of cost basis and current value) and any resting buys;
   - optional per-category caps (`category_exposure_caps`, e.g. `{default: 0.30, sports: 0.20}`) as a share of equity, using Gemini's event `category`. Existing positions and resting buys in that category count;
   - the daily cap, which is the lower of `max_daily_spend_usd` and `max_daily_spend_pct` × start-of-day equity;
   - available cash.

   These apply whether the quantity came from Kelly sizing or was typed in. The runner can't exceed them.
7. **Sells.** You can only sell what you hold: Gemini positions when live, the paper ledger in DRY_RUN. If the positions lookup fails or returns anything odd, the sell is rejected. Sells of held quantity reduce exposure, so they don't count against the dollar caps or the daily budget.
8. **Open orders and trade count.** Rejected if the account already has `max_open_orders` or more, or if `max_trades_per_day` buys were already placed this UTC day. Sells of held quantity (exits) are exempt from that count and have their own ceiling, `max_exits_per_day` (default 10), so a used-up trade budget never blocks reducing a position. Both counts are kept per mode in `state/daily_spend.json` with the same protections, counted at confirm and never refunded, even if the send fails.
9. **Tokens.** Single-use, valid for 5 minutes, and used up before anything else runs. The stored order is hash-checked. At confirm the quantity is frozen: the order is never re-sized, only rejected if it no longer fits.

Credentials come only from environment variables (or `.env`). They're never logged or returned, and they're redacted from `audit.log`. Hosts are fixed, redirects aren't followed, every private path is allowlisted per client class, and nothing is retried automatically. If a placement fails or times out, check `list_open_orders` before trying again.

## Conviction sizing

This applies to buys only. For a buy with your probability `q` for the outcome, at price `p` for that outcome:

```
q_adj        = w*q + (1-w)*p                  w = estimate_weight (0.7)
edge         = q_adj - p - fee_per_contract   below min_edge -> no trade
kelly f      = edge / (1 - p)
kelly stake  = equity * f * kelly_multiplier  (0.25 = quarter Kelly)
stake        = min(kelly stake, 8% of equity, 15% of equity minus existing event exposure,
                   category cap minus existing category exposure (if configured),
                   remaining daily budget, max_order_usd, available cash)
quantity     = stake / (p + fee), rounded down to the contract's step; below the minimum -> no trade
```

Every proposal records `q`, `q_adj`, `p`, `edge`, `kelly_fraction`, every limit, `stake_usd`, and the limit that bound (`binding_limit`) in the audit log. `binding_limit` is `kelly` when no cap was hit.

Equity is cash plus positions at Gemini's mark. Gemini's `marketValue` is the current sell price, and a position with no live quote counts as $0. In DRY_RUN, equity is paper cash plus paper positions at the current sell price, and a settled paper position is worth $1 or $0.

## Circuit breakers

- **Max drawdown:** equity falls `max_drawdown_pct` (20%) below its peak.
- **Max daily loss:** equity falls `max_daily_loss_pct` (8%) below the start of the UTC day.
- **Absolute equity floor:** equity falls below `equity_floor_pct` (60%) of the starting balance. That's `starting_balance_usd` if you set it (required for live by preflight) (formerly initial_deposit_usd). The old name is still read, with a deprecation warning. Otherwise it's the first positive equity the server ever saw in live mode, or the paper bankroll in DRY_RUN. **Deleting `KILL` never resets the floor:** while equity stays below it, every order trips it again. Set `equity_floor_pct: 0` to disable it.

They're checked on every `propose_order` and `confirm_order`, for buys and sells.

On a trip, the server:
- creates `KILL` with the reason and figures (equity, peak, start of day, floor), plus **every open position** (quantity, cost basis, value, category). Positions with no live quote are marked `NO LIVE QUOTE (valued at $0)` and listed again under `positions_without_quote`;
- logs `circuit_breaker_trip`;
- rejects the order.

From then on, every order tool refuses until you delete `KILL` by hand.

**Every KILL deletion is logged** as `kill_deleted`, with what the file said, when it appeared and when the deletion was noticed. That covers files the breaker created and files you created yourself. Deletion happens outside the server, so it's noticed on the next order tool call, the next `get_balances`, or server startup. Each new KILL file is logged as `kill_detected`.

Deleting `KILL` resets the drawdown peak to current equity (logged as `breaker_reset`). The daily-loss baseline doesn't reset, so if you delete `KILL` on the same UTC day while still 8% down, it trips again. Deposits and withdrawals move equity too: a withdrawal can trip a breaker, and a deposit raises the peak.

If equity can't be fetched, the order is rejected but no `KILL` is created.

## Runner

```bash
python runner.py                 # one pass; schedule with cron if you want it recurring
python runner.py --auto-confirm  # live only, and only if config sets runner_auto_confirm_live: true
```

The runner starts `server.py` as an MCP subprocess and calls only its tools. Each run goes through two phases.

**1. Position review.** Each open position is researched again. In DRY_RUN those are paper positions. The previous thesis and its invalidation conditions go to the model. The position is sold, at the current bid for that outcome and for the full available quantity, if **any** of these holds:
- **`price_reached_estimate`:** the sell price is at or above the current `q_adj`. The value is gone.
- **`edge_gone`:** the estimate fell below its entry value, and the current edge (`q_adj − buy price − fee`) is ≤ 0.
- **`thesis_invalidated`:** the model reports the thesis invalidated by new information. Its reason is logged.
- **`near_expiry_not_winning`:** expiry is within `exit_hours_before_expiry` (24h), and the sell price is below `clearly_winning_price` (0.85).

Every condition that fired is logged. A contract exited this run isn't re-entered in the same run.

**2. Entry scan.** This runs for every open contract in an allowlisted event that you don't hold:
1. Skip contracts with no usable expiry date (contract or event); the near-expiry exit can't apply to them.
2. Fetch the order book. A spread above `max_spread`, or an empty side, means no trade. This check comes before research, so no research money is spent on it.
3. Research the contract. Fewer than `min_sources` sources means no trade.
4. Compute the edge for both YES (`p` = ask) and NO (`p` = 1 − YES bid), and take the better side. Below `min_edge` means no trade.
5. `propose_order(..., my_probability=q)`. The server sizes the order and applies every cap.
6. Depth check: there must be at least `min_depth_multiple` × quantity contracts at or better than the price. Otherwise no trade, and the proposal is left to expire.
7. Confirm. DRY_RUN confirms automatically. Live asks `Type 'yes'` on the terminal. It confirms without asking only with `--auto-confirm` **and** `runner_auto_confirm_live: true`. Under cron there's no terminal, so live proposals are logged as `proposed_not_confirmed`.

**Logging.** Every decision is written to `audit.log` as `{"event": "decision", "kind": ...}`, including `no_trade`, `hold`, `skip` and `review_failed`. Each entry carries the reason, the estimate, the thesis, the sources, both sides' edge math, the book, and the sizing. Every trade's research record is also stored in `paper_ledger.json` under `research`, keyed by the paper order id or `live:<order_id>`.

`max_research_per_run` (10) caps research calls per run. Position reviews go first.

### Research (`research.py`)

- **Model:** `research_model` (`claude-opus-5-5`), with the server-side web search and web fetch tools. Up to `research_max_searches` searches per contract.
- **Order:** it reads the contract's resolution text and terms link first, then estimates **P(this contract resolves YES under those rules)**. Market prices are deliberately left out of the prompt, so the estimate is independent; the shrinkage step blends in the price afterwards.
- **Model provenance:** every estimate records `research_model` (the model that produced the final answer), `research_model_requested`, `research_models_used` (every model that answered a turn) and `research_fallback_used`. These appear in each `decision` entry in `audit.log` and in each research record in `paper_ledger.json`.
- **Output:** a strict `submit_estimate` tool. Sources are taken from the actual search and fetch results, not from the model's text.
- **Refusals:** refusal fallback is on (`fallbacks: "default"`). A refusal, a malformed estimate or an API error becomes a logged `no_trade` or `hold`.
- **Untrusted web content:** the model is told to ignore instructions inside pages. Any one estimate can only do bounded damage, because of the shrinkage toward the market, quarter-Kelly and the server's caps.
- **Cost:** each research call costs model tokens plus web search usage. `max_research_per_run` caps it.
- **Key handling:** `ANTHROPIC_API_KEY` is read only by the runner. The Gemini server subprocess never receives it.

### Paper trading (DRY_RUN)

`paper_ledger.json` starts with `paper_bankroll_usd` ($100) of cash. Delete it to reset.

- A paper buy fills only if its limit is at or above the current ask, and it fills at the limit price. A paper sell fills only if its limit is at or below the current bid. Both subtract `fee_per_contract`. Unfilled paper orders are recorded with `filled: false`.
- Only the server writes fills and positions, so the runner can't invent holdings.
- DRY_RUN proposals still need a Gemini API key, because the open-order count is a signed read. A read-only key works.

## Report

```bash
python report.py          # paper trades + decisions
python report.py --live   # also fetches live fills from order history (read-only)
python report.py --json
```

**How trades are built.** Each buy fill is a lot. Later sells close lots first-in, first-out. Whatever is left settles at $1 or $0 once the contract resolves, using the public event data.

**Buckets.** Lots are grouped by the edge stated at entry: `<5%`, `5–10%`, `10–20%` and `20%+`. Each bucket shows:
- expected return, computed with q_adj and with raw q;
- realized return;
- P&L and return on cost;
- win rate against mean q_adj.

Each bucket also shows Brier scores, where lower is better:
- `Brier me` scores my raw estimate q. `brier_mine_q_adj` in `--json` scores the shrunk one.
- `Brier mkt` scores the market's probability on the same contracts: the book mid logged at decision time, falling back to the fill price.
- `N` is the number of resolved contracts scored. A contract counts once it resolves, even if the position was sold earlier.
- **Buckets with N < 30 are flagged `N<30`;** that's too few to conclude anything.
- `brier_skill` = 1 − mine/market. Above 0 means the estimates beat the price.

A second table scores **every researched contract, traded or not**: my P(YES) against the YES mid at the time, with one sample per contract per UTC day. It also counts estimates by model.

If realized return trails expected in the high-edge buckets, or my Brier score isn't below the market's, the stated edges aren't real. A decision summary (by kind, with the top reasons) follows the tables.

## Dashboard

```bash
python report.py --json > report.json   # optional; fills the calibration and Brier panels (read-only Gemini calls)
python dashboard.py                     # writes dashboard.html; open it in a browser
```

`dashboard.py` builds one self-contained HTML page from `audit.log`, `paper_ledger.json`, `state/`, `KILL`, `config.yaml` and `report.json`. The page shows:
- Equity and drawdown against the floor.
- Today's spend and trade count against the limits.
- Open positions.
- A filterable decision timeline.
- Each contract's thesis and sources.
- Calibration, and my Brier score against the market's, with N per bucket.
- A "needs attention" panel: KILL, breaker trips, unknown orders, thin-book skips, missing quotes.

It is read-only. It opens its inputs for reading only, never calls any API, refuses to write over its inputs or into `state/`, and the page's Content-Security-Policy blocks all network requests. Light and dark themes are included. `samples/dashboard_sample.html` is a sample built from simulated data by `samples/make_sample.py`.

## Modes

| `GEMINI_ENV` | `DRY_RUN` | What happens |
|---|---|---|
| unset / `sandbox` | unset / `true` | **Default.** Sandbox data, paper orders only. |
| `production` | unset / `true` | Real production market data, paper orders only. |
| `sandbox` | `false` | Real orders with sandbox test funds. |
| `production` | `false` | **Real money.** |

When `DRY_RUN` isn't exactly `false`, the server never creates a trading client, and a test checks this. Any other `DRY_RUN` value stops the server from starting.

> **Sandbox status (2026-09-30):** the sandbox's prediction-markets REST endpoint returned 503. Gemini's docs also disagree on the sandbox WebSocket host: the demo page says `ws.sandbox.gemini.com` and the prediction-markets page says `api.sandbox.gemini.com`. This code uses the former, and if no book comes back, the trade is skipped. Recheck the sandbox before going live.

## Setup

On a Mac, `./setup_mac.sh` does the steps below idempotently. It never overwrites `.env`. **[RUNBOOK.md](RUNBOOK.md)** covers first-time setup, daily operations, how to stop everything, what each audit event means, unknown orders, reading the report, and the going-live criteria. `launchd/` holds a DRY_RUN-only schedule template.

```bash
cd gemini_mcp
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env && chmod 600 .env    # Gemini key/secret; ANTHROPIC_API_KEY for the runner
python -m pytest -q tests                 # offline; no network, keys or API spend
```

**API key.** Create it in Gemini under **Settings → API**, as an account-scoped key with a time-based nonce.

- Use **Auditor** (read-only) while in DRY_RUN. If Auditor gets a 403 on prediction-market reads, use Trader with `DRY_RUN=true` instead.
- Use a **Trader-only** key to go live.
- **Never** assign Fund Manager, the role that can withdraw.
- Leave "Requires Heartbeat" off.

Then run `python verify_auth.py`. It makes read-only signed calls and stops at the first error, reporting it exactly.

**Terms.** Accept the prediction-market terms yourself on the Gemini website. The server never accepts them.

## Connecting to Claude

**Claude Code:**

```bash
claude mcp add --transport stdio --scope user gemini-pm \
  -- /ABS/PATH/gemini_mcp/.venv/bin/python /ABS/PATH/gemini_mcp/server.py
```

**Claude Desktop:** add the following to `claude_desktop_config.json`, then restart:

```json
{"mcpServers": {"gemini-pm": {"command": "/ABS/PATH/gemini_mcp/.venv/bin/python",
                              "args": ["/ABS/PATH/gemini_mcp/server.py"]}}}
```

The server loads `.env` from its own folder, so keep secrets out of Claude config files.

**claude.ai custom connectors** (Customize → Connectors) need a public remote URL. Anthropic's cloud connects to it, so a server on your laptop won't work as-is. The recommendation is not to expose this server; use Claude Code or Desktop. If you do host it, it needs code changes: the Streamable HTTP transport plus OAuth. Run it on a server you control, over TLS, with tiny caps. Never put it behind an unauthenticated tunnel. This build ships stdio only.

## Going live checklist

`python preflight.py` checks items 1–6 and exits non-zero, listing every failure. `server.py` and `runner.py` run the same checks at startup. In live mode (`DRY_RUN=false`, or any malformed `DRY_RUN`) they **refuse to start** on any failure. In DRY_RUN they print the failures as warnings and continue.

Checked by `preflight.py`:

1. **`starting_balance_usd`** is set in `config.yaml` to the account balance you start trading with (not commented out, not zero). The equity floor is measured from it.
2. **Fees:** you've checked `fee_per_contract` against Gemini's fee schedule and set **`fee_confirmed: true`**.
3. **Allowlist:** `allowed_event_tickers` lists exactly the events you mean to trade (not empty).
4. **Risk bounds:** `max_order_pct_of_balance` ≤ 0.15, `max_daily_spend_pct` ≤ 0.5, `max_drawdown_pct` ≤ 0.35, `equity_floor_pct` ≥ 0.4 (floor at least 40% of the starting balance), `kelly_multiplier` ≤ 0.5, `max_trades_per_day` ≤ 20, `max_exits_per_day` ≤ 30.
5. **Secrets:** `.env` and any key files (`.env.*` other than `.env.example`, `*.pem`, `*.key`, `*.p12`, `*.pfx`) are not tracked by git and are covered by `.gitignore`.
6. **Auth (live only):** `python verify_auth.py` succeeded for the same `GEMINI_ENV` in the last 24 hours. It writes `state/verify_auth_ok.json` on success.

Not checked by code, so do these yourself:

7. Recheck the sandbox. If it works, run the flow there with `DRY_RUN=false`.
8. Paper-trade first, and read `python report.py`. Do the high-edge buckets actually earn more?
9. Use a Trader-only key (never Fund Manager) and accept the prediction-market terms on the website.
10. Keep the caps tiny: `max_order_usd: 2`, `max_daily_spend_usd: 5`.
11. Run one server process per API key. Two processes (say, the runner plus Claude Desktop) now share caps safely, but time-based nonces can collide and fail requests.
12. Set `GEMINI_ENV=production` **and** `DRY_RUN=false`. Run the runner from a terminal and approve each order.

**Kill switch:** `touch gemini_mcp/KILL` stops every order tool immediately; `rm` it to resume. While it exists, `cancel_order` is blocked too, so cancel orders on the Gemini website.

## Audit log

`audit.log` is JSON lines with UTC timestamps. Both the server and the runner write to it, under a file lock. Event types:

- **Server:** `kill_detected`, `kill_deleted`, `proposal` and `confirmation` (both include `sizing`), `would_place` (with `paper_order_id` and `paper_filled`), `order_intent`, `order_result`, `rejection` (with `reason`, and `sizing` when relevant), `would_cancel`, `circuit_breaker_trip`, `breaker_reset`.
- **Live sends:** before any placement or cancel is sent, the server writes an `order_intent` entry (`intent_id`, `action` place/cancel, the order) and fsyncs it. If that write fails, nothing is sent. After the send it writes `order_result` with the same `intent_id` and `result`: `placed`, `failed`, `unconfirmed` (a 2xx with no order id; the order may or may not exist), `cancelled` or `cancel_failed`. If the result can't be written after a send, the tool returns `ok: false` with the `order_id` in the error. `report.py` lists every intent with no result (or an `unconfirmed` one) as "unknown, check Gemini".
- **Runner:** `decision`.

## Known limits

- **Fees:** the fee per contract is an estimate from config.
- **Open-order count:** only the first 100 open orders are read, so `max_open_orders` is capped at 100 in config.
- **State files:** if `state/risk_state.json` goes missing after trading, orders are refused rather than re-baselining the breakers. Restore it, or delete `state/daily_spend.json` as well to start over on purpose. `state/daily_spend.json` is refused if it's missing (once used), malformed, or shows less spend or fewer trades today than the `confirmation` entries in `audit.log`. Each propose and confirm reads today's lines of `audit.log`.
- **Exposure attribution:** positions and resting buys count toward an event when their event metadata matches *or* their symbol is one of that event's contracts.
- **`get_order_status`:** searches up to 1,000 open and 5,000 history orders.
- **Book filter scope:** the spread and depth check is applied by the runner only. Manual `propose_order` calls from a chat aren't filtered by it.
- **Self-reported probability:** `my_probability` comes from the caller. The server can't verify it, only cap what it does.
- **Nonces:** they're Unix seconds and strictly increasing, so signed requests are spaced at least a second apart. Don't share a key with another bot.
- **Report accuracy:** the report's live mode relies on audit placements plus order history. Fills of orders placed outside this tool aren't attributed to an estimate.

# Gemini Prediction Markets MCP server

A local MCP server that lets Claude look up Gemini prediction markets and place and manage **limit** orders. It can move real money, so every limit below is enforced in code, not in prompts.

| File | Role |
|---|---|
| `gemini_client.py` | Gemini REST calls. A `ReadOnlyClient`, plus a `TradingClient` that adds only *place limit order* and *cancel order*. Nothing for withdrawals or transfers. |
| `guardrails.py` | All limit checks, confirmation tokens, the daily-spend ledger, the kill switch and the audit log. |
| `server.py` | MCP tool definitions (FastMCP, stdio). |
| `config.yaml` | Limits and event allowlist. It's re-read on every propose and confirm. |
| `verify_auth.py` | Read-only check that request signing works. |

Endpoints follow Gemini's docs: the [Prediction Markets API](https://developer.gemini.com/prediction-markets-spec) and [API key authentication](https://developer.gemini.com/authentication/api-key).

## Tools

| Tool | Effect |
|---|---|
| `list_markets(search, status)` | Read-only. Events, contracts, best bid and ask, and whether each event is allowlisted. |
| `get_market(event_ticker)` | Read-only. Contract details, descriptions, the terms-and-conditions URL, and child events. |
| `get_balances()`, `get_positions()` | Read-only. |
| `propose_order(instrument_symbol, outcome, side, quantity, limit_price)` | Runs every guardrail. Returns a preview (e.g. `BUY NO @ 0.35`) and a one-time token. **Places nothing.** |
| `confirm_order(token)` | Uses up the token, re-runs every check, then places the order. In dry run it only logs. |
| `cancel_order(order_id)` | Cancels an order. In dry run it only logs. |
| `get_order_status(order_id)` | Looks in open orders, then order history. Returns `not_found` rather than guessing. |
| `list_open_orders()` | Read-only. |

`limit_price` is the price of the outcome you're trading, strictly between 0 and 1. A winning contract pays $1.00.

## Guardrails

`propose_order` runs these checks, and `confirm_order` runs them all again with fresh data:

1. **Kill switch.** If a file named `KILL` exists in this folder, `propose_order`, `confirm_order` and `cancel_order` all refuse. It's checked once more right before the order is sent.
2. **Input.** `outcome` must be exactly `yes` or `no`, and `side` exactly `buy` or `sell`. Quantity must be above 0, and price strictly between 0 and 1. A missing price or `"market"` is rejected. Orders are always limit and good-til-cancel; stop-limit, IOC and FOK aren't exposed.
3. **Allowlist (exact match, fails closed).** The symbol must be a direct contract of exactly one event in `allowed_event_tickers`. A game's child events must be listed by their own ticker. If any allowlisted event can't be fetched and the symbol wasn't found elsewhere, the order is rejected. If the symbol turns up in two events, it's rejected. The resolved event ticker is written to every proposal's audit entry.
4. **Market state.** The event and contract must be `active`, and the contract's `marketState` must be `open`.
5. **Price and quantity grid.** Both must fit the contract's own `priceMinimum`/`priceIncrement` and `quantityMinimum`/`quantityIncrement`. If those fields are missing, the order is rejected.
6. **Sells.** You can only sell up to the quantity you hold for that symbol and outcome (`totalQuantity` minus `quantityOnHold`). If the positions lookup fails or returns anything unexpected, the sell is rejected.
7. **Per-order cap.** The worst-case cost must be at most `max_order_usd`. For a buy that's `quantity × price`; for a sell it's `quantity × (1 − price)`.
8. **Daily cap.** Today's spend (UTC day) plus this order must be at most `max_daily_spend_usd`. Spend is saved in `state/daily_spend.json`, so restarting doesn't reset it. It's never refunded, even on cancel or a failed placement. Dry-run and live spending are tracked separately.
9. **Open orders.** Rejected if the account already has `max_open_orders` or more open orders, counted from Gemini's live list. If the count can't be fetched, the order is rejected.
10. **Tokens.** Tokens are random, single-use and expire after 5 minutes. They live in memory, so a restart cancels them all. A token is used up *before* anything else runs, so a failed confirm can't be retried with it. The stored order is hash-checked.

Other protections:
- **Credentials** are read only from environment variables (or `.env`, which is loaded into the environment). They're never logged, never returned and redacted from `audit.log`.
- **Hosts are fixed.** The only hosts are `api.sandbox.gemini.com` (default) and `api.gemini.com`, and redirects aren't followed.
- **Every private path is allowlisted per client class.** The read-only client can't reach the order endpoints at all.
- **No retries.** If a placement fails or times out, it isn't retried and the spend stays counted. Check `list_open_orders` before proposing again.

## Modes

| `GEMINI_ENV` | `DRY_RUN` | What happens |
|---|---|---|
| unset / `sandbox` | unset / `true` | **Default.** Sandbox data. Confirms and cancels only log. |
| `production` | unset / `true` | Real production market data, but confirms and cancels only log. |
| `sandbox` | `false` | Real orders with sandbox test funds. |
| `production` | `false` | **Real money.** |

When `DRY_RUN` isn't exactly `false`, the server never creates a trading client. The order-placement code path doesn't exist in that process, and a test checks this. Any `DRY_RUN` value other than `true` or `false` stops the server from starting.

Dry-run proposals still need an API key. The open-order count, and sell checks, use signed read calls, and without a key the proposal is rejected.

> **Sandbox status (2026-09-30):** the sandbox's prediction-markets endpoint returned `503 Service temporarily unavailable`, while its spot endpoints and production were fine. Until it recovers, use `GEMINI_ENV=production` with `DRY_RUN=true`. Recheck the sandbox before going live, and if it works, run the whole flow there first.

## Setup

```bash
cd gemini_mcp
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env && chmod 600 .env    # then fill in the key and secret
python -m pytest -q tests                 # offline; no network or keys needed
```

### Creating the API key

In the Gemini web app go to **Settings → API** ([production](https://exchange.gemini.com/settings/api), or [sandbox](https://exchange.sandbox.gemini.com/), which needs a separate account). Create an **account-scoped** key (prefix `account-`) with a **time-based nonce**.

Choose the role deliberately. Gemini's [roles](https://developer.gemini.com/roles) are Administrator, Trader, Fund Manager and Auditor:

- **For now (dry run): use Auditor.** It's read-only and can't be combined with other roles. Gemini's role table doesn't say whether Auditor can read prediction-market positions and orders. Run `python verify_auth.py`: if Auditor gets a 403 `MissingRole` on those calls, use a Trader key while `DRY_RUN=true` (the placement code isn't reachable then).
- **When you go live: use Trader only.** Trader can check balances, place and cancel orders, and read orders and positions.
- **Never assign Fund Manager.** That role can withdraw funds and move money between accounts. This server has no code for either, and the key shouldn't have the permission either.
- **Leave "Requires Heartbeat" off.** With it on, Gemini cancels every open order after 30 seconds without a request.

Put the key and secret in `.env`. Never commit it (it's gitignored) and never paste it into a chat.

### Verify signing (read-only)

```bash
python verify_auth.py
```

This signs balances, positions and open-orders requests (all reads), then checks that a `limit` parameter placed in the signed payload is respected. It stops at the first failure and prints Gemini's exact error. It never touches the order endpoints and never tries a different signing scheme. If it fails, send me the output rather than changing the code.

### Prediction-market terms

Orders fail with `TERMS_NOT_ACCEPTED` until you've accepted Gemini's prediction-market terms. The server never accepts them for you. Read and accept them yourself on the Gemini website.

## Running and connecting to Claude

```bash
python server.py     # stdio MCP server; logs go to stderr
```

The server loads `.env` from its own folder, so you don't need to put secrets in any Claude config file.

**Claude Code:**

```bash
claude mcp add --transport stdio --scope user gemini-pm \
  -- /ABS/PATH/gemini_mcp/.venv/bin/python /ABS/PATH/gemini_mcp/server.py
claude mcp list        # should show gemini-pm as Connected; or run /mcp inside a session
```

Prefer `.env` over `--env KEY=...`. Values passed with `--env` are stored in plain text in `~/.claude.json`.

**Claude Desktop:** edit `claude_desktop_config.json`. On macOS it's in `~/Library/Application Support/Claude/`; on Windows, `%APPDATA%\Claude\`. Then restart Claude Desktop:

```json
{
  "mcpServers": {
    "gemini-pm": {
      "command": "/ABS/PATH/gemini_mcp/.venv/bin/python",
      "args": ["/ABS/PATH/gemini_mcp/server.py"]
    }
  }
}
```

**claude.ai custom connectors** (Customize → Connectors → Add custom connector) need a **remote MCP server reachable over the public internet**. Anthropic's cloud connects to it, so a process on your laptop won't work as-is. The options:

1. **Recommended: don't expose it.** Use Claude Code or Claude Desktop, as above. Then the server, keys, kill switch and audit log stay on your machine.
2. **Host it behind HTTPS with real authentication.** This needs code changes: switch FastMCP to the Streamable HTTP transport, and add OAuth, which claude.ai supports via the connector's Advanced settings. Deploy it on a server you control with TLS, and ideally restrict inbound traffic to Anthropic's published IP ranges. Anyone who gets that URL and credential could propose and confirm orders within the caps. Treat it like an exposed trading bot: keep caps tiny, and keep the kill switch and audit log where you can reach them.
3. **Tunnels (ngrok, Cloudflare Tunnel).** These make a local server reachable quickly. Without the authentication in option 2, anyone who finds the URL can call your tools. Don't do this with a trading key.

This build only ships the stdio transport. I haven't added HTTP or OAuth, on purpose.

## Going live checklist

1. Recheck the sandbox. If its prediction-markets endpoint works, run the whole flow there with `DRY_RUN=false`.
2. Swap in a **Trader-only** production key, run `python verify_auth.py`, and make sure the terms are accepted on the website.
3. Keep `config.yaml` caps low for the first order. It ships with `max_order_usd: 2` and `max_daily_spend_usd: 5`. Add only the event ticker you mean to trade to `allowed_event_tickers`.
4. Set `GEMINI_ENV=production` **and** `DRY_RUN=false`, then restart the server. The mode is shown in every preview (`LIVE (production): REAL MONEY`).
5. Propose, read the preview (the action line, the cost and the resolved event), confirm, then check `list_open_orders`.
6. Raise the limits later only by editing `config.yaml`.

**Kill switch:** `touch gemini_mcp/KILL` stops all order tools immediately, with no restart needed. `rm gemini_mcp/KILL` turns trading back on. It blocks `cancel_order` too, so while it's on, cancel open orders on the Gemini website.

## Audit log

`audit.log` is JSON lines with UTC timestamps. The event types are `proposal`, `confirmation`, `would_place`, `placement`, `placement_failed`, `rejection` (with its `reason`), `cancel`, `would_cancel` and `cancel_failed`. Example:

```json
{"ts": "2026-09-30T23:45:56.265+00:00", "event": "rejection", "action": "propose_order", "reason": "allowlist is empty: add event tickers to allowed_event_tickers in config.yaml", "mode": "DRY RUN (production): nothing will be placed", "request": {"instrument_symbol": "GEMI-X", "outcome": "yes", "side": "buy", "quantity": "1", "limit_price": "0.5"}}
```

## Known limits

- **Fees aren't included** in the worst-case cost. Gemini's order endpoint doesn't document a fee field, so leave some headroom in your caps.
- **The open-order count uses the first 100** open orders. That's only a problem if your cap is above 100.
- **`get_order_status` searches** up to 1,000 open orders and 5,000 history orders. An order can fill or be cancelled between the two lookups.
- **The terms status isn't checked by the server.** `GET /terms/status` needs authentication, and Gemini only documents signing for POST requests. A rejected order will report `TERMS_NOT_ACCEPTED`.
- **Nonces are Unix seconds, strictly increasing.** Signed requests are spaced at least a second apart. Don't share one key between this server and another bot.

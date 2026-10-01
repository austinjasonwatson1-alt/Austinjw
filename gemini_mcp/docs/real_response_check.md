# Real-response check: which Gemini fields the code reads

The guardrails were tested against fake responses whose field names come from Gemini's docs. Nobody has yet compared them with a real response from your account. This page lists every field the code reads from the responses that decide money, so you can check each one against a real response.

## How to get real responses (read-only)

- **Positions and open orders:** in Claude Code with this server connected, call `get_positions` and `list_open_orders`. Both are read-only. `get_positions` shows the raw Gemini response at the top level, plus the server's normalized `review_positions`. You need at least one open position and one resting order (buy *and* sell, ideally) for the check to mean anything.
- **Placement and cancel:** these responses only exist once an order is sent. Do it in the sandbox if it works, or with one minimum-size order. `confirm_order` returns Gemini's raw reply as `response`, and `cancel_order` does the same. `audit.log` stores the raw reply in `order_result` only for `unconfirmed`, `cancelled` and `cancel_failed`. For `placed` it stores only `order_id` and `status`.

For each field below, confirm the **exact name and casing**, the **type** (string vs number), and whether it is **always present**. "Fail closed" means the order is refused and the reason is logged.

## Positions: `POST /v1/prediction-markets/positions`

Read in `guardrails.py` `Guardrails._live_context()`. It sets live equity, per-event and per-category exposure, and how much you can sell.

| Field | Used for | If absent or malformed |
|---|---|---|
| top-level `positions` (list) | the position list | Fail closed: "positions lookup returned an unexpected shape". |
| `positions[].symbol` (string) | matching sells to holdings; attributing exposure to an event by symbol | Fail closed ("unexpected entry"). |
| `positions[].outcome` (exactly `"yes"` / `"no"`, lowercase) | which side is held | Any other value, including `"YES"`, fails closed. If Gemini uses uppercase, **every order is blocked** until the code is changed. |
| `positions[].totalQuantity` | quantity held; cost basis; sellable quantity | Fail closed if missing, non-numeric or negative. |
| `positions[].quantityOnHold` | quantity reserved by resting sells | Treated as 0. Sellable = `totalQuantity − max(quantityOnHold, resting sell quantity from open orders)`, so a resting sell still reserves contracts if Gemini also reports the order. |
| `positions[].avgPrice` | cost basis (`totalQuantity × avgPrice`) for exposure | Treated as 0, so exposure falls back to `marketValue` only. Negative or > 1 fails closed. |
| `positions[].marketValue` | position value in equity and exposure | Treated as **$0** ("no live quote"). That lowers equity, so breakers trip earlier (conservative). It's listed in `positions_without_quote` and in the KILL file. |
| `positions[].contractMetadata.eventTicker` | per-event exposure cap | Treated as `""`. The position still counts toward an event if its `symbol` is one of that event's contracts (fix F2). Only positions in **other**, non-allowlisted events become unattributed, and those can't affect an allowlisted event's cap. |
| `positions[].contractMetadata.category` | per-category cap (`category_exposure_caps`) | Treated as `"unknown"`. A position in the event being traded still counts toward that event's category through its symbol. A position in another event with a missing category counts only toward the `unknown` / `default` cap. |
| `positions[].contractMetadata.expiryDate` | carried into `review_positions` only | Not used for decisions. The runner takes expiry from `get_market` (contract `expiryDate`, else event `expiryDate`). |
| duplicate `(symbol, outcome)` entries | — | Fail closed. |

## Open orders: `POST /v1/prediction-markets/orders/active`

Read in `Guardrails._active_orders()` and `_live_context()`, and in `server.find_order()` for `get_order_status`. The guardrails read only the first page (`limit=100`). That's why `max_open_orders` is capped at 100. `get_order_status` pages further.

| Field | Used for | If absent or malformed |
|---|---|---|
| top-level `orders` (list) | counting open orders (`max_open_orders`); exposure; resting sells | Fail closed: "open orders lookup returned an unexpected shape". |
| `orders[]` entry not an object | — | Skipped. It still counts toward `max_open_orders`. |
| `orders[].side` (exactly `"buy"`) | buy → counts toward exposure; **anything else** → treated as a resting sell | If Gemini uses `"BUY"` or another casing, buys are treated as sells. Exposure from resting buys is then **not counted**, and the quantity is wrongly reserved from sells. **Check this one carefully.** |
| `orders[].remainingQuantity` | resting quantity | Falls back to `orders[].quantity`, then 0. A numeric `0` (not `"0"`) also falls back to `quantity` (over-counts, which is conservative). Negative fails closed. |
| `orders[].quantity` | fallback for the above | — |
| `orders[].price` (buys only) | resting buy dollars (`remaining × price`) | Fail closed if missing, non-numeric, or outside 0..1. |
| `orders[].symbol` | event attribution of resting buys; which position a resting sell reserves | Treated as `""`. A resting **buy** then counts only through `contractMetadata.eventTicker`. A resting **sell** reserves nothing, so a second sell can be proposed against the same contracts. Gemini should still reject it, but check that this field exists. |
| `orders[].outcome` (sells) | which outcome a resting sell reserves | If missing or not `"yes"`/`"no"`, the sell reserves **both** outcomes (conservative). |
| `orders[].contractMetadata.eventTicker` / `.category` (buys) | event and category attribution | As for positions: falls back to symbol attribution for the traded event. |
| `orders[].orderId` | `get_order_status` lookup | Orders without a parseable id are never matched (`not_found`). |

## Placement: `POST /v1/prediction-markets/order`

Read in `Guardrails._confirm_locked()`.

| Field | Used for | If absent or malformed |
|---|---|---|
| response is a JSON object | — | Anything else gets `order_result` `unconfirmed`, and the tool returns `ok: false` ("may or may not exist"). |
| `orderId` | the placed order's id: returned to the caller, stored in `order_result`, used by `report.py --live` to find fills in order history | `unconfirmed`, `ok: false`. The spend and trade count stay recorded. |
| `result == "error"` (Gemini's error body) | detecting an error with a 2xx status | `unconfirmed`, `ok: false`. Non-2xx statuses are always errors (`failed`). |
| `status` | logged and returned only | Not used for decisions. |

The request is fixed in `gemini_client.TradingClient.place_limit_order`: `symbol`, `orderType: "limit"`, `side`, `quantity`, `price` (decimal strings), `outcome`, `timeInForce: "good-til-cancel"`. Compare these names with the docs, too.

## Cancel: `POST /v1/prediction-markets/order/cancel` (request field `orderId`)

Read in `Guardrails.cancel()`.

| Field | Used for | If absent or malformed |
|---|---|---|
| response is a JSON object | — | Otherwise `cancel_failed`, `ok: false`. |
| `result == "error"` | detecting an error with a 2xx status | `cancel_failed`, `ok: false`. |
| anything else | — | Any other object is treated as **cancelled**. If Gemini signals failure differently (for example `{"result": "ok", "cancelled": false}`), this would wrongly report success. Check a real failed cancel, such as cancelling an already-filled order. |

## Also money-relevant (for completeness)

| Response | Field | Used for | If absent or malformed |
|---|---|---|---|
| balances `POST /v1/balances` | list of objects; entry with `currency == "USD"` (case-insensitive) | live cash and equity | No USD entry: cash = equity base = **0**, so nothing can be bought. Non-list fails closed. |
| balances | `amount` (equity base), `available` (cash cap) | equity; cash check | Fail closed if missing or non-numeric. |
| order history `POST /v1/prediction-markets/orders/history` | `orders[].orderId`, `filledQuantity`, `avgExecutionPrice` | `report.py --live` fills only | The order is left out of the report. |
| events `GET /v1/prediction-markets/events/{ticker}` | `ticker`, `status`, `category`, `contracts[].instrumentSymbol`, `.status`, `.marketState`, `.priceMinimum`, `.priceIncrement`, `.quantityMinimum`, `.quantityIncrement`, `.prices.buy/sell.{yes,no}`, `.expiryDate`, `.resolutionSide` | allowlist resolution, grid, paper fills and valuation, runner expiry | Allowlist and grid fail closed. Bad quotes count as "no quote" (fix F10). No expiry means the runner doesn't enter. |

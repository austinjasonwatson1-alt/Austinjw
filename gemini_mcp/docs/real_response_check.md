# Real-response check: which Gemini fields the code reads

The guardrails were tested against fake responses built from Gemini's documented shapes ([trading](https://developer.gemini.com/prediction-markets-spec/trading), [positions & orders](https://developer.gemini.com/prediction-markets-spec/positions), checked 2026-10-01). Nobody has yet compared them with a real response from your account. This page lists every field the code reads from the responses that decide money, so you can check each one against a real response.

**Rule:** for orders, exposure, holdings and balances, an absent or unexpected field **refuses** the proposal and logs why. It is never guessed. The one deliberate exception is `marketValue` (below). So if a real response lacks a field this page marks "required", every order will be refused until the code is changed. That's the intended failure mode; tell me which field is missing.

## How to get real responses (read-only)

- **Positions and open orders:** in Claude Code with this server connected, call `get_positions` and `list_open_orders`. Both are read-only. `get_positions` shows the raw Gemini response at the top level, plus the server's normalized `review_positions`. You need at least one open position and one resting order (buy *and* sell, ideally) for the check to mean anything.
- **Placement and cancel:** these responses only exist once an order is sent. Do it in the sandbox if it works, or with one minimum-size order. `confirm_order` and `cancel_order` return Gemini's raw reply as `response` (or in the error text). `audit.log` stores the raw reply in `order_result` for `unconfirmed`, `cancelled` and `cancel_failed`. For `placed` it stores `order_id` and `status`.

For each field, confirm the **exact name and casing**, the **type**, and that it is **always present**.

## Positions: `POST /v1/prediction-markets/positions`

Read in `guardrails.py` `Guardrails._live_context()`. It sets live equity, per-event and per-category exposure, and how much you can sell.

| Field | Used for | If absent or unexpected |
|---|---|---|
| top-level `positions` (list) | the position list | **Refused.** |
| `positions[].symbol` (string) | matching sells to holdings; event attribution | **Refused.** |
| `positions[].outcome` (exactly `"yes"` / `"no"`) | which side is held | **Refused**, including `"YES"`. Documented as lowercase. |
| `positions[].totalQuantity` | quantity held; cost basis | **Refused** if missing, non-numeric or negative. |
| `positions[].quantityOnHold` | quantity reserved by resting sells | **Refused** if missing (it used to be assumed 0). Sellable = `totalQuantity − max(quantityOnHold, resting sells in open orders)`. |
| `positions[].avgPrice` | cost basis for exposure | **Refused** if missing (it used to be assumed 0). Also refused if negative or > 1. |
| `positions[].marketValue` | position value in equity and exposure | **Kept: valued at $0** and flagged in `positions_without_quote` and the KILL file. $0 is conservative for every cap and breaker. Refusing would block all trading, including exits, whenever one position lacks a quote. |
| `positions[].contractMetadata` (object) with non-empty `eventTicker` and `category` | per-event and per-category caps | **Refused** if either is missing. A position also counts toward an event if its `symbol` is one of that event's contracts. |
| `positions[].contractMetadata.expiryDate` | carried into `review_positions` only | Not used for decisions. The runner uses the contract or event `expiryDate` from `get_market` and won't enter without one. |
| duplicate `(symbol, outcome)` entries | — | **Refused.** |

## Open orders: `POST /v1/prediction-markets/orders/active`

Read in `Guardrails._active_orders()` and `_live_context()`. The guardrails read only the first page (`limit=100`). That's why `max_open_orders` is capped at 100. `get_order_status` (`server.find_order()`) pages further.

| Field | Used for | If absent or unexpected |
|---|---|---|
| top-level `orders` (list) | open-order count; exposure; resting sells | **Refused.** |
| each entry is an object | — | **Refused.** |
| `orders[].side` | buy → exposure; sell → reserves holdings | Case-normalized (`"BUY"` works). Anything other than buy/sell → **refused**. |
| `orders[].outcome` | which outcome a resting sell reserves | Case-normalized. Anything other than yes/no → **refused**. |
| `orders[].symbol` (non-empty string) | event attribution; which position a sell reserves | **Refused.** |
| `orders[].remainingQuantity` | resting quantity | **Refused** if missing, non-numeric or negative. There's no fallback to `quantity`. |
| `orders[].price` (buys) | resting buy dollars | **Refused** if missing, non-numeric, or outside 0..1. Not read for sells. |
| `orders[].contractMetadata` with non-empty `eventTicker` and `category` | event and category attribution | **Refused.** |
| `orders[].orderId` | `get_order_status` lookup only | The order isn't matched (`not_found`). Doesn't affect orders or caps. |

## Placement: `POST /v1/prediction-markets/order`

Read in `Guardrails._confirm_locked()` through `_placement_problem()`. Documented reply: the order object (`orderId`, `status: "open"`, `symbol`, `side`, `outcome`, `quantity`, `price`, ...).

| Field | Rule | Otherwise |
|---|---|---|
| reply is an object, not `result: "error"` | required | `order_result` **unconfirmed**; `ok: false`. |
| `orderId` | required | **Unconfirmed.** |
| `status` | must be `open` or `filled` (case-insensitive) | **Unconfirmed**, including `cancelled`/`rejected` or a missing status. If Gemini uses another value for partly filled resting orders, those show up as unconfirmed; check `report.py` and Gemini. |
| `symbol`, `side`, `outcome`, `quantity`, `price` | if present, must match the request | **Unconfirmed.** If absent, they aren't required: `orderId` and status already confirm an order exists. |

Unconfirmed always returns `ok: false` with the order id when there is one. Spend and the trade count stay recorded, and `report.py` lists it as "unknown, check Gemini".

The request is fixed in `gemini_client.TradingClient.place_limit_order`: `symbol`, `orderType: "limit"`, `side`, `quantity`, `price` (decimal strings), `outcome`, `timeInForce: "good-til-cancel"`.

## Cancel: `POST /v1/prediction-markets/order/cancel` (request `{"orderId": N}`)

Read in `Guardrails.cancel()` through `_cancel_confirmed()`. Documented success reply: `{"result": "ok", "message": "Order N cancelled successfully"}`. The docs show no `cancelled`/`is_cancelled` field.

| Reply | Result |
|---|---|
| `result: "ok"` (case-insensitive), or `is_cancelled: true`, or `status: "cancelled"` | **cancelled** |
| `result: "error"` | **cancel_failed** |
| a different `orderId`, `is_cancelled: false`, or anything else (including `{}`, non-objects, `"pending"`) | **unconfirmed**: `ok: false` with the order id; `report.py` lists it as unknown |

## Balances: `POST /v1/balances`

| Field | Rule | Otherwise |
|---|---|---|
| list of objects | required | **Refused.** |
| exactly one entry with `currency` `USD` (case-insensitive) | required | **Refused** for none or several. This used to become equity 0 and trip a breaker. |
| `amount` (equity base), `available` (cash cap) | required, numeric | **Refused.** |

## Events: `GET /v1/prediction-markets/events/{ticker}`

| Field | Rule | Otherwise |
|---|---|---|
| `ticker` matches the allowlisted ticker; `contracts` list; `status == "active"` | required | **Refused.** |
| `contracts[].instrumentSymbol`, `.status == "active"`, `.marketState == "open"` | required | **Refused.** |
| `.priceMinimum`, `.priceIncrement`, `.quantityMinimum`, `.quantityIncrement` | finite; increments > 0 | **Refused.** |
| event `category` | required **only when** `category_exposure_caps` is set | **Refused** then. Without caps, it's unused. |
| `.prices.buy/sell.{yes,no}` | paper fills and paper valuation only | Out of range or missing → no quote / not filled. |
| `.expiryDate` (or event `expiryDate`) | runner entry | No parseable expiry → the runner doesn't enter. |
| `.resolutionSide` | paper valuation of settled contracts | Missing → valued from the sell quote. |

## Not money-affecting (left as is)

- **Order history** `orders[].orderId`, `filledQuantity`, `avgExecutionPrice`: used only by `report.py --live`. Missing means the order is left out of the report.
- **Open order `orderId`:** used only by `get_order_status`.

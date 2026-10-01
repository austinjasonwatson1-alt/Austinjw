# Overnight notes

This is a working log for the autonomous run on `review/gemini-mcp`. Each task section lists what was done, the commits, and anything that needs your decision. Open questions are collected at the end.

Ground rules followed:
- Work stayed inside `gemini_mcp/`. Pushes went only to `origin/review/gemini-mcp`, with no force-push.
- No network calls to Gemini or Anthropic, and no real keys.
- The runner and order tools ran only against mocks.
- Every bug fix started with a failing test.
- Where something was ambiguous, I took the safer option and logged it here.

## Task 1: fail-open fixes

This was already done in the previous session, with tests written first, and pushed before this run started:

| Item | Commit | Tests |
|---|---|---|
| Order side casing normalized; any other side rejects the proposal, logged | `83714ba` | `tests/test_strict_side.py` |
| Cancel counts only on positive confirmation (`result: "ok"`, `is_cancelled: true`, `status: "cancelled"` for the same id); anything else is `unconfirmed` | `057c63f` | `tests/test_cancel_confirmation.py` |
| Audit of `docs/real_response_check.md`: absent or unexpected fields in open orders, positions, balances, event category (with caps) and placement status now refuse | `74aa0ab`, `75fa351` | `tests/test_strict_fields.py` |

At the start of this run, `HEAD == origin/review/gemini-mcp == 75fa351` and 410 tests passed.

Deliberate exception: a position with no `marketValue` is still valued at $0. That's conservative for every cap and breaker; refusing instead would block exits. See Q1.

## Task 2: endpoint allowlist and rename

**Allowlist (`1e573f6`).** `gemini_client.ALLOWED_ENDPOINTS` lists exactly eight method+path pairs:
- `GET` events list, and `GET` one event by ticker.
- `POST` balances, positions, active orders, order history, place order, and cancel order.

Any path containing `deposit|withdraw|transfer|address|fund|bank` is refused, case-insensitive and after percent-decoding, as is any `..` segment. The check runs twice: when the request is built, and again in an httpx request hook on the final URL. The hook also verifies the scheme, host and port, so code that bypasses the helpers is still refused. Refusals are logged to `gemini_mcp.client`. The order-book WebSocket stream must match `<symbol>@depth(5|10|20)`. The per-class split still applies: the read-only client can't place or cancel.

- **Real bug found:** `get_event("..")` was normalized by httpx to `GET /v1/prediction-markets`, which is outside the events path. Tickers such as `../../v1/withdraw` were sent percent-encoded. Tickers are now limited to `[A-Za-z0-9][A-Za-z0-9._-]{0,119}`.
- **Proof:** `tests/test_endpoint_allowlist.py` covers 97 cases. It includes a live run and a DRY_RUN run of the real runner plus every MCP tool against `tests/fake_gemini.py`. Every request that reached the fake was allowlisted, and the live run touched every allowlisted endpoint, so the check covers all of them.
- **Side effect (Q2):** an event whose ticker contains one of the refused words, such as a hypothetical `FEDFUNDS`, can't be read or traded. I kept the strict rule you asked for.

**Rename (`starting_balance_usd`).** `initial_deposit_usd` is still read, with a `DeprecationWarning`. Preflight prints the warning as a note, so it's visible. Setting both keys is a `ConfigError`. Updated: config.yaml, preflight, README and tests.

## Task 3: realistic fake Gemini and end-to-end runs

**`tests/fake_gemini.py`** is a stateful local fake of the API, using the documented response shapes. It plugs in through `httpx.MockTransport` and a fake `ws_connect`, so the real signing, allowlist, parsing and guardrails all run against it.
- **Auth:** it checks the HMAC-SHA384 signature, that the payload's `request` equals the path, and that nonces strictly increase per key.
- **Orders:** orders rest, fill, or partially fill. Positions, `quantityOnHold`, cash and reserved cash update the way an exchange would. Cancel returns the documented `{"result": "ok", ...}`.
- **Faults:** 503 or any status code, a timeout before or *after* the request is applied, malformed JSON, missing or overwritten fields, and an order book that never answers.
- **Shared state:** state can live in a locked JSON file, so several processes can share one fake.

**`tests/test_e2e_fake.py`** has 30 scenarios that run the real runner and MCP tools, live and DRY_RUN:
- Trading flow: entry, resting order, partial fill, full entry → fill → exit → fill cycle, and a partially filled exit.
- Safety stops: circuit breaker trip, KILL created mid-run, restart mid-position.
- Failures: outages during confirm and cancel, corrupted reads, order-book timeout, research failure.
- Reporting: live fills read by `report.py` through the real client.

Real bugs it found, each fixed after a failing test:
1. **`50af55d`: send outcome misclassified.** A placement that timed out after Gemini accepted it, or got a 5xx or an unparseable 2xx, was logged as `failed`. `report.py` never flagged it as "unknown, check Gemini", although the order was live. Now only a refusal before sending, or a 4xx answer, counts as `failed`. Everything else is `unconfirmed`. Cancels work the same way.
2. **`a8a8391`: stacked entries.** An unfilled buy from an earlier run isn't a position, so every live run proposed another entry on the same contract, limited only by the caps. In live mode the runner now reads open orders first and skips contracts with any resting order. If it can't read open orders, it enters nothing that run.

Observed and safe, not changed:
- **Restart reusing a nonce.** A restarted process whose nonce clock didn't move past the last nonce got `InvalidNonce` from the fake, the way Gemini would. Everything was refused, so it failed closed. Real restarts take more than 1 s, so the wall-clock nonces move on. Two processes sharing one key can still collide (Q3).
- **Breakers fire only on a proposal.** They're evaluated on propose and confirm only. If equity drops while the runner proposes nothing (everything is held or resting), no KILL is created until the next proposal. `run_start` does log `breaker_would_trip` (Q4).
- **DRY_RUN still reads the account.** In DRY_RUN, the `get_balances`/`get_positions` tools still make read-only signed account calls to show real balances next to the paper figures. That's by design; nothing is placed.

## Task 4: property tests, fuzzing and concurrency

**Property tests** (`tests/test_properties.py`, hypothesis; added to requirements.txt):
- **`size_position`:** across random balances, prices, estimates, fees, caps, grids and minimums, the stake is never negative or NaN. It always equals qty × p and sits on the grid at or above the minimum. qty × (p + fee) never exceeds any cap: Kelly, dollar ceiling, order %, market %, category %, daily, or cash.
- **Guardrails, propose → confirm, live and DRY_RUN:** every order that gets through respects `max_order_usd`, order %, market %, the daily cap (dollar and %), cash, the trade count, the price and quantity grids, and held quantity in DRY_RUN. Garbage inputs are always a clean, logged rejection with nothing placed.
- **Not vacuous:** I checked with hypothesis statistics. The first version placed **zero** orders in every example, so it proved nothing. After restructuring, about 20% of examples place one or more orders.

**Fuzzing responses** (`tests/test_fuzz_responses.py`): random missing, extra, wrongly-typed and extreme fields in positions, open orders, balances, events and contracts. A bad required field always rejects both a buy and a sell, logged. Extra fields change nothing. Nothing crashes. Real bugs found and fixed in `20b73a8`:
1. A USD balance of `-1` was accepted.
2. A contract `priceIncrement` of `1e-400` was accepted, which made the price grid meaningless.
3. A position with an empty `symbol` was accepted.

Every number read from Gemini is now finite, non-negative and at most 1e12 (prices at most 1), no tinier than 1e-12, and at most 30 digits. Increments must fall within plausible ranges.

**Multi-process stress** (`tests/test_stress_multiprocess.py`): six processes, each with its own key, share one file-backed fake and one state directory. Spend (at the fake and in the ledger), trade count, `max_order_usd`, and the open-order high-water mark at the exchange all stay within the caps. Every intent has a result. **I verified the test catches a violation:** with the cross-process orders lock disabled, all three trials reached 5 open orders against a cap of 4.

Observed, not changed:
- **Live double sell depends on Gemini's own view (Q5).** Two sells of the same holding are refused at the second confirm only because the exchange's open orders already show the first one; the stateful fake proves this. If Gemini's open-orders or positions view lags just after a placement, a second sell proposed in that window could pass the guardrails, and Gemini's own holding check would be the last line of defense.
- **DRY_RUN counts real open orders.** In DRY_RUN, `max_open_orders` counts the *real account's* open orders, because paper orders never rest. This only ever blocks paper trading, never allows extra, so I left it.

**Process slip, fixed.** The push after Task 4 (`dc11f02`) went out while one property test was failing. My command piped pytest into `tail`, which hid its exit code. The failure was a **test** bug: the property counted unfilled paper sells as sold, so no code was at fault. It was fixed and pinned as an `@example` in `bdb4b8e`. Since then every push is gated on pytest's own exit status.

## Task 5: read-only dashboard

**What it is.** `python dashboard.py` writes `dashboard.html`. The optional `python report.py --json > report.json` beforehand fills the calibration and Brier panels.

The page shows:
- Equity, peak and drawdown against the floor, with trips marked.
- Today's spend and trade count against the limits, plus drawdown and daily-loss meters against the breaker thresholds.
- Open positions. Paper positions come from the ledger. Live positions come from the last run's position review only, so a sold position doesn't linger.
- A filterable decision timeline, and each contract's thesis, invalidation conditions and sources.
- Calibration: my estimates and the market price against observed outcomes, with N per bin.
- My Brier score against the market's, per edge bucket, with N and a low-N flag.
- A **Needs attention** panel: KILL contents, a tripped breaker, unknown orders, breaker trips, KILL detected or deleted, failed decisions, thin-book skip counts, missing quotes, and "a breaker would trip on the next order".

**Safety, all tested in `tests/test_dashboard.py`.**
- Inputs are opened read-only. A byte-for-byte snapshot of every file is unchanged except the new `dashboard.html`.
- Sockets are blocked during generation, and it imports no HTTP client.
- It refuses to write over any input or inside `state/`.
- A CSP with `default-src 'none'; connect-src 'none'` blocks all network requests.
- Every log string is escaped. Script tags, `javascript:` and `data:` links, and `</script>` breakouts are neutralized; only http(s) source links are rendered, with `rel="noopener noreferrer nofollow"`.

**Design.** It uses the validated dataviz palette, with blue for me and equity and orange for the market; both modes pass the CVD and contrast checks. Status colors appear only for bad states, always with an icon and a label. Lines are 2px, gridlines are hairline, every chart has a legend and a table view, and native tooltips plus an equity crosshair cover hover. Light, dark and auto themes are selectable. I rendered it in Chromium at 1300px, light and dark, and at 390px (phone). There's no horizontal overflow, no console errors, and no network requests.

**Sample.** `samples/dashboard_sample.html` is built by `samples/make_sample.py`. It simulates two weeks of the real runner and server against the fake exchange: 24 contracts, a timed-out placement that shows up as an unknown order, and a drawdown that trips the breaker and creates KILL. Contracts are resolved with a seeded coin flip, and `report.py`'s own functions build `report.json`. `dashboard.html` and `report.json` are gitignored because they hold account data.

**Two things found while building it, both fixed test-first:**
- `report.unknown_orders` said "Gemini returned no order id" for every unconfirmed result, including timeouts. It now shows the real error (`3319a0f`). The same commit added the `points` field the calibration chart uses.
- **Q6:** the simulation showed `max_trades_per_day` blocking risk-reducing **exits** once the day's count was used up. That's as you specified ("counting placed orders"), so I didn't change it.

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

## Task 6: Mac setup and runbook

- **`setup_mac.sh`:** idempotent and secret-free.
  - It checks for Python 3.11+, creates `.venv` and installs the requirements.
  - It creates `.env` from the example **only if it's missing**. It never overwrites or prints `.env`, and refuses a symlinked one.
  - It runs `chmod 600 .env` and `chmod 700 state/`, checks that `.env` is gitignored and no key file is tracked, then shows DRY_RUN preflight.
  - Tested in `tests/test_setup_mac.py` on Linux bash. **It has never run on a real Mac (Q9).**
- **`launchd/com.gemini-mcp.dryrun.plist.template`:**
  - It ships **disabled**, holds no secrets, and runs three times a day.
  - It sets `DRY_RUN=true` plus a new marker, `GEMINI_MCP_SCHEDULE=dry_run_only`. `runner.py` now refuses to start (exit 3) if that marker is set while DRY_RUN isn't dry, so an edited schedule can't go live.
  - `launchd/README.md` explains what live scheduling would need: `--auto-confirm`, `runner_auto_confirm_live: true`, and `DRY_RUN=false`. It also explains how to stop the schedule.
  - The plist parses as valid XML. It is **not** validated with `plutil`, which isn't available on Linux.
- **`RUNBOOK.md`:** first-time setup, daily operations, stopping everything, every audit event, `order_result` value and decision kind, what to do with an unknown order, reading the report, and **going-live criteria (Q8)**:
  - N ≥ 30 scored trades in every bucket traded;
  - Brier mine < market with N ≥ 100;
  - after-fee realized return > 0 in every traded bucket, and at least half of expected;
  - 4 clean weeks of DRY_RUN, preflight OK, terms accepted, a Trader-only key.

  `tests/test_runbook.py` fails if the code emits an event or kind the runbook doesn't document.

## Task 7: final self-review

### Did anything loosen a limit or weaken a check?

**No.** I re-read every removed or changed line in the non-test code and config since `origin/claude/stoic-archimedes-iacegx` (`git diff -U0 … | grep '^-'`). Each removal was replaced by an equal or stricter check:

| Removed or changed | Replaced by |
|---|---|
| `max_open_orders` with no upper bound | ≤ 100, the page size that's actually read |
| `SpendLedger.add` | `record_trade`: same spend math, plus a trade count, with amounts validated (finite, ≥ 0, strings only) |
| `RiskState.read`/`update` | `_entry`: the same reads, plus validation of the mode entry and its numbers |
| `_dec_field`: finite only | finite, ≥ 0, ≤ 1e12 (prices ≤ 1), not tinier than 1e-12, at most 30 digits |
| Balances: no USD entry meant 0 | exactly one USD entry is required, or refuse |
| Positions/orders: `or "0"` fallbacks for `quantityOnHold`, `avgPrice`, `remainingQuantity`; missing metadata became `""` | all required, or refuse. Side and outcome case-normalized; anything unknown refuses |
| Exposure keyed only by event ticker | event ticker **or** symbol (a superset) |
| Paper quotes trusted unchecked | out-of-range or garbage quotes count as no quote / not filled |
| Contract increments: finite and > 0 | plausible ranges, logged rejection |
| Confirm body | moved into `_confirm_locked` under a cross-process lock. Re-checked: the token is still burned first; KILL is checked at the start **and** right before the real send (`guardrails.py`, "Last-moment kill check"); spend is still recorded before sending |
| `placement` / `placement_failed` / `cancel` / `cancel_failed` events | `order_intent` (fsync'd, written **before** sending) plus `order_result`. A send counts as `placed`/`cancelled` only on positive confirmation; timeouts and 5xx are `unconfirmed`, never `failed` |
| `_public_get`: path-prefix check | method+path allowlist, plus a forbidden-word check, plus an httpx hook on the final URL |
| Runner `prior_for`: any record | the current mode's records only |

**Edits to tests that already existed at the base:** only fake-response fixtures gained the fields Gemini documents (same numbers), the rename, and new event names. The event-name test also got stricter: it now checks `result`. No assertion was relaxed.

**Edits to tests I wrote this session:**
- The F2 tests were rewritten, because missing metadata now refuses outright.
- One property-test assertion (open orders) moved to the multi-process test, which can actually observe it. The live `sold <= held` check moved to the stateful end-to-end test, `test_two_sells_of_the_same_holding_cannot_both_be_placed`.
- A timeout now asserts `unconfirmed` instead of `failed`, which is stricter.

### Each guardrail and a test that proves it's still enforced

| Guardrail | Test (in `tests/`) |
|---|---|
| Only `DRY_RUN=false` is live; any other value is an error | `test_guardrails.py::test_dry_run_parsing` |
| DRY_RUN never builds a trading client, never sends orders | `test_guardrails.py::test_dry_run_guardrails_refuse_a_trading_client`, `test_gemini_client.py::test_dry_run_never_sends_order_or_cancel_requests`, `test_e2e_fake.py::test_dry_run_entry_is_paper_only` |
| KILL blocks propose, confirm and cancel, including KILL created mid-confirm or mid-run | `test_guardrails.py::test_kill_switch_blocks_all_order_tools`, `::test_kill_switch_created_mid_confirmation_blocks_placement`, `test_e2e_fake.py::test_kill_created_mid_run_stops_the_rest` |
| `max_order_usd` | `test_guardrails.py::test_over_limit_order_rejected`, `test_sizing.py::test_dollar_ceiling_overrides_percentage`, `test_properties.py::test_guardrails_never_place_an_order_that_breaks_a_cap` |
| Order %, market %, category %, cash | `test_sizing.py::test_server_percentage_caps_apply_to_manual_quantity`, `test_safety_additions.py::test_server_category_cap_rejects_and_clamps`, `test_adv_f2_exposure_attribution.py::*`, `test_properties.py::*` |
| Daily spend cap: persists, resets at UTC midnight, re-checked at confirm | `test_guardrails.py::test_daily_cap_accumulates`, `::test_daily_cap_persists_across_restart_and_resets_next_utc_day`, `::test_daily_cap_checked_again_at_confirm`, `test_sizing.py::test_daily_pct_cap` |
| `max_trades_per_day` at propose and confirm | `test_trades_per_day.py::test_limit_enforced_at_propose_and_resets_next_utc_day`, `::test_limit_enforced_again_at_confirm` |
| `max_open_orders` (≤ 100) | `test_guardrails.py::test_max_open_orders`, `test_adv_f12_open_orders_page.py::test_max_open_orders_above_page_size_is_rejected` |
| Caps hold across concurrent processes | `test_adv_f1_cross_process_race.py::*`, `test_stress_multiprocess.py::test_concurrent_processes_never_exceed_caps` |
| Allowlist: exact, fails closed, no child events, unique | `test_guardrails.py::test_non_allowlisted_market_rejected`, `::test_empty_allowlist_blocks_everything`, `::test_allowlist_fails_closed_when_event_lookup_fails`, `::test_allowlist_ignores_nested_child_events`, `::test_allowlist_rejects_symbol_found_in_two_events` |
| Price and quantity grid, minimum size, input validation | `test_guardrails.py::test_off_grid_price_and_quantity_rejected`, `::test_market_orders_and_bad_prices_rejected`, `::test_outcome_must_be_exactly_yes_or_no`, `test_sizing.py::test_below_minimum_order_size_skips`, `test_adv_f13_huge_numbers.py::*`, `test_adv_f9_contract_increments.py::*` |
| Tokens: single-use, expiring, untampered, concurrent | `test_guardrails.py::test_reused_token_rejected`, `::test_expired_token_rejected`, `::test_tampered_pending_order_rejected`, `::test_unknown_token_rejected` |
| Sells never exceed holdings, including resting sells | `test_guardrails.py::test_sell_more_than_held_rejected`, `test_adv_f4_resting_sells.py::*`, `test_e2e_fake.py::test_two_sells_of_the_same_holding_cannot_both_be_placed` |
| Paper and live never mixed | `test_guardrails.py::test_dry_run_spend_does_not_consume_live_budget`, `test_adv_f8_runner_mode_mixing.py::*` |
| Floor, drawdown and daily-loss breakers; deleting KILL doesn't reset the floor | `test_breakers_and_book.py::test_drawdown_trip_creates_kill`, `::test_daily_loss_trip_creates_kill`, `::test_daily_loss_retrips_same_day_after_manual_delete`, `test_safety_additions.py::test_floor_trips_and_deleting_kill_does_not_reset_it`, `test_e2e_fake.py::test_circuit_breaker_trip_creates_kill_and_stops_orders` |
| Missing or corrupt state files fail closed | `test_adv_f5_state_reset.py::test_deleted_risk_state_after_trading_fails_closed`, `test_adv_f11_corrupt_risk_values.py::*`, `test_ledger_vs_audit.py::*`, `test_trades_per_day.py::test_missing_ledger_after_first_use_fails_closed` |
| Gemini fields absent or unexpected → refuse | `test_strict_fields.py::*`, `test_strict_side.py::*`, `test_fuzz_responses.py::test_bad_required_field_always_rejects`, `test_e2e_fake.py::test_bad_reads_reject_every_proposal` |
| Placement or cancel counted only on positive confirmation; unknown outcomes surfaced | `test_strict_fields.py::test_placement_not_positively_confirmed_is_unconfirmed`, `test_cancel_confirmation.py::*`, `test_e2e_fake.py::test_outage_during_confirm_is_unknown_not_failed_and_never_retried`, `test_order_audit.py::*` |
| Endpoint allowlist; no withdraw, deposit, transfer or similar path | `test_endpoint_allowlist.py::*`, `test_gemini_client.py::test_trading_client_has_no_withdraw_or_transfer_paths` |
| Credentials never logged or printed | `test_guardrails.py::test_audit_log_redacts_secrets`, `test_gemini_client.py::test_errors_and_repr_never_contain_secret`, `test_adv_f6_verify_auth_key_leak.py::*` |
| Preflight blocks live startup | `test_preflight.py::test_server_refuses_to_start_live_when_preflight_fails`, `::test_runner_refuses_to_start_live_when_preflight_fails`, `::test_each_config_failure` |
| Scheduled runs can't be live | `test_schedule_interlock.py::test_schedule_marker_refuses_anything_but_dry_run` |
| Runner doesn't stack entries; enters nothing if open orders can't be read; skips contracts with no expiry | `test_e2e_fake.py::test_live_entry_rests_and_is_not_restacked_next_run`, `::test_live_runner_enters_nothing_when_open_orders_cant_be_read`, `test_runner_expiry.py::test_no_expiry_is_skipped_before_research_and_logged` |
| Dashboard is read-only and offline | `test_dashboard.py::test_never_writes_inputs_and_never_touches_the_network`, `::test_refuses_to_write_over_inputs_or_into_state` |

### Skipped or not done, and why

- **No real Gemini or Anthropic calls**, by your rules. The sandbox, the WebSocket host and real response shapes are **unverified** (see below).
- **No real Mac.** `setup_mac.sh` was tested under Linux bash. The plist parses as valid XML (Python `plistlib`) but wasn't checked with `plutil` or loaded with `launchctl`.
- **The fake doesn't model** contract settlement (`resolutionSide`) in live mode, rate limits (429), or history pagination beyond what the tests use. Resolution in the dashboard sample is a seeded coin flip.
- **No new features** beyond what the tasks asked, plus one safety interlock (`GEMINI_MCP_SCHEDULE=dry_run_only`), which makes the DRY_RUN-only schedule enforceable.

### Open questions (I took the safer option in each case)

- **Q1.** A position with no `marketValue` is valued at $0, which is conservative for every cap and breaker, and not refused. Refusing would block exits whenever a quote is missing. Keep it that way?
- **Q2.** Event tickers containing deposit, withdraw, transfer, address, fund or bank (e.g. a hypothetical `FEDFUNDS`) are refused by the endpoint allowlist, as you specified. Keep it strict, or allow those words inside the ticker segment only?
- **Q3.** Two processes sharing one API key (runner plus Claude Desktop) can send the same time-based nonce. Gemini rejects one request: a fail-safe error, not a wrong order. Use one key per process, or add a shared nonce file?
- **Q4.** Breakers are evaluated only on propose and confirm. If equity drops while nothing is proposed (everything held or resting), KILL isn't created until the next proposal; `run_start` does log `breaker_would_trip`. Should the runner create KILL and stop at `run_start` when `breaker_would_trip` is set?
- **Q5.** The live double-sell guard relies on Gemini's open orders and positions reflecting a sell immediately after it's placed; Gemini's own holding check is the backstop. Add a local reservation for in-flight sells?
- **Q6.** `max_trades_per_day` also blocks risk-reducing exits once the day's count is used up (seen in the simulation). Exempt sells?
- **Q7.** Unknown orders stay listed in the report and dashboard forever, because the log is append-only. Add an acknowledgement file the report and dashboard honor?
- **Q8.** Going-live criteria in RUNBOOK §8 are my proposal:
  - N ≥ 30 scored trades in each bucket you trade;
  - Brier mine < market with N ≥ 100;
  - realized return after fees > 0 and at least half of expected;
  - 4 clean weeks of DRY_RUN.

  Confirm or change the thresholds.
- **Q9.** Please run `./setup_mac.sh` once on the Mac, and `plutil -lint` on the plist.
- **Q10.** In DRY_RUN, `max_open_orders` counts the real account's open orders, because paper orders don't rest. That only ever blocks paper trading. Fine?

### Verify against a real Gemini response before going live

Use `get_positions`, `list_open_orders` and one minimum-size order in the sandbox, then compare with `docs/real_response_check.md`:
1. **Positions:** every entry has `symbol`, lowercase `outcome`, and `totalQuantity`, `quantityOnHold`, `avgPrice` (≤ 1), `marketValue`, plus `contractMetadata.eventTicker` and `.category`. **Any field that's missing makes every order refuse.**
2. **Open orders:** `side` and `outcome` (any case), `symbol`, `remainingQuantity`, `price`, and `contractMetadata.eventTicker` and `.category`.
3. **Placement reply:** `orderId`, and `status` exactly `open` or `filled` (case-insensitive). Check which status a **partly filled** resting order uses. Anything else becomes `unconfirmed`.
4. **Cancel reply:** `{"result": "ok", ...}`, as documented. Anything else becomes `unconfirmed`.
5. **Balances:** exactly one USD entry, with `amount` and `available`.
6. **Events:** the `category` field is present if you use `category_exposure_caps`.
7. **Sandbox WebSocket host:** `wss://ws.sandbox.gemini.com` (the docs disagree); also check that order books arrive at all.
8. **Gemini oversell check:** Gemini itself rejects a sell beyond holdings (the backstop for Q5).

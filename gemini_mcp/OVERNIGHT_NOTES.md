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

## Final state

`git log --oneline origin/claude/stoic-archimedes-iacegx..HEAD` (45 commits, plus the commit that adds this section):

```
b518d83 gemini_mcp: overnight notes for task 7 (self-review, guardrail -> test map, open questions)
3bd2111 gemini_mcp: overnight notes for task 6
aef5b7b gemini_mcp: setup_mac.sh and RUNBOOK.md
eb7eb90 gemini_mcp: launchd template for DRY_RUN-only schedules, with an interlock
a2b03a8 gemini_mcp: overnight notes for task 5 (and the push slip)
2f35172 gemini_mcp: read-only dashboard (dashboard.py) with a sample
3319a0f gemini_mcp: unknown-order status names the real cause
bdb4b8e gemini_mcp: fix property test counting unfilled paper sells as sold
dc11f02 gemini_mcp: overnight notes for task 4
bf68184 gemini_mcp: multi-process stress test against the shared fake exchange
20b73a8 gemini_mcp: bound every number read from Gemini; refuse empty symbols
182d6dc gemini_mcp: property tests for sizing and the guardrails (hypothesis)
cf56e25 gemini_mcp: overnight notes for task 3
1c1a748 gemini_mcp: e2e fake scenarios for partial exits, live report fills, dry exits
a8a8391 gemini_mcp: runner never stacks entries on a contract with a resting order
50af55d gemini_mcp: a send whose outcome is unknown is 'unconfirmed', not 'failed'
6e55ecc gemini_mcp: overnight notes for task 2
1e43ffc gemini_mcp: rename initial_deposit_usd to starting_balance_usd
1e573f6 gemini_mcp: explicit method+path endpoint allowlist, enforced twice
cd8b074 gemini_mcp: start OVERNIGHT_NOTES.md (task 1 already complete)
75fa351 gemini_mcp: update real_response_check.md for the refuse-on-absent rules
74aa0ab gemini_mcp: refuse instead of guessing on absent or unexpected Gemini fields
057c63f gemini_mcp: count a cancel only when Gemini positively confirms it
83714ba gemini_mcp: normalize open-order side case; unknown side fails closed
b3e99d6 gemini_mcp: document the Gemini response fields the code reads
178c344 gemini_mcp: runner skips entering contracts with no expiry date
dd0e20e gemini_mcp: fsync'd order_intent before every live send, order_result after
7b971f4 gemini_mcp: refuse when daily_spend.json is malformed or below audit.log
cbeff73 gemini_mcp: add max_trades_per_day (default 5), checked at propose and confirm
6d659a6 gemini_mcp: README going-live checklist matches preflight checks
25952f3 gemini_mcp: add preflight.py, enforced at server and runner startup
2afd63c gemini_mcp: add fee_confirmed flag; verify_auth writes a success marker
01ba48c gemini_mcp: bound magnitude/precision of order inputs; clip audit echo
58614ad gemini_mcp: cap max_open_orders at the 100-order page that is read
c09cf19 gemini_mcp: fail closed (and log) on corrupt risk-state values
14c36ac gemini_mcp: validate quotes used for paper valuation and fills
cc10a85 gemini_mcp: reject NaN/inf/non-positive contract increments cleanly
7e97f76 gemini_mcp: runner never mixes paper and live research records
545cf09 gemini_mcp: don't report placement/cancel as ok without proof
f2d019a gemini_mcp: verify_auth never prints a key without a known prefix
c7abacc gemini_mcp: refuse to trade when risk state is missing after trading
6a12b49 gemini_mcp: subtract resting sells from sellable quantity
0062aba gemini_mcp: attribute exposure by symbol as well as event metadata
b657e6f gemini_mcp: reject negative or out-of-range position and order values
ad2ab87 gemini_mcp: serialize confirm across processes with a file lock
```

Full test suite, `python -m pytest -q` in `gemini_mcp/`:

```
........................................................................ [ 12%]
........................................................................ [ 24%]
........................................................................ [ 36%]
........................................................................ [ 48%]
........................................................................ [ 60%]
........................................................................ [ 72%]
........................................................................ [ 84%]
........................................................................ [ 96%]
........................                                                 [100%]
600 passed in 40.94s
```

---

# Follow-up session (after `697f8ca`)

## Answered by you this session

- **Q4: breakers at run start.** Done in `e383778`. The runner calls the new read-only MCP tool `check_circuit_breakers` right after `run_start`, before any review, research or proposal.
- **Q6: exits.** Done in `adb37af`. Exits are exempt from `max_trades_per_day` and have their own `max_exits_per_day`.
- **Q8: going-live criteria.** Replaced in RUNBOOK §8 with your criteria (Task 5 below).
- **Q9: macOS.** Partly addressed in Task 6 below: bash 3.2, the Python minimum, and plistlib validation. It still hasn't run on a real Mac.

## Defaults taken (questions you didn't answer: I kept the safer option)

| Q | Default | Effect |
|---|---|---|
| Q1 | A position without `marketValue` is still **valued at $0**, not refused. | $0 is the conservative value for every cap and breaker (lower equity means tighter caps and earlier trips). Refusing instead would block exits whenever one quote is missing. |
| Q2 | **Strict endpoint word filter.** Event tickers containing deposit, withdraw, transfer, address, fund or bank can't be read or traded. | Some legitimate events (a hypothetical `FEDFUNDS`) are unavailable. Nothing can reach a sensitive path. |
| Q3 | **One API key per process.** No shared nonce file. A nonce collision makes Gemini reject that one request; that's a visible error, never a wrong order. | Run only one server process per key (the runner's own server, *or* Claude Desktop/Code, not both on one key). RUNBOOK §1 and the going-live checklist already say so. |
| Q5 | **Changed to the safer option** (`0d9caea`). Live sells confirmed in the last 120 s stay reserved against the holding, even if Gemini's positions or open orders don't show them yet. The reservation is read from `audit.log`, so every process sees it. | It uses `max()` with what Gemini reports, so a reflected sell isn't double-counted. A sell that already *filled* within 120 s can briefly block a second, legitimate sell of the remainder. That errs on the side of refusing. Tests: `tests/test_recent_sell_reservation.py`. |
| Q7 | **Unknown orders stay listed** in the report and dashboard; there's no acknowledgement mechanism. | Each one stays visible until the log rotates. That's annoying, but nothing unknown is ever hidden. |
| Q10 | In DRY_RUN, `max_open_orders` keeps counting the **real account's** open orders. | It can only block paper trading, never allow more. |

## This session's work

Every change started with a failing test. Before every push the full suite ran, and the push was gated on pytest's own exit code (`$?`, never piped). Pushes went only to `origin/review/gemini-mcp`.

| Task | Commit | What changed | Tests |
|---|---|---|---|
| 1. Breakers at run start | `e383778` | New read-only MCP tool `check_circuit_breakers` runs the guardrails' own floor, drawdown and daily-loss evaluation, creating KILL on a trip. `runner.py` calls it right after `run_start`, before any position review, research or proposal. It stops the run (decision `run_stopped`) if a breaker trips, KILL exists, or the check can't complete (e.g. balances unreadable). It works on paper equity in DRY_RUN too. | `tests/test_run_start_breakers.py` (8) |
| 2. Exits | `adb37af` | `max_trades_per_day` now counts **buys only**. Sells of held quantity count against a new `max_exits_per_day` (default 10), checked at propose and at confirm. The exit count lives in `state/daily_spend.json` (version 2, `exits` section) with the same protections as the trade count. After first use, a missing file or mode entry is refused, a malformed count is refused, and a count below today's audit sells is refused. Version-1 files are upgraded in place; a version-2 file without `exits` is refused. Preflight fails above 30. Preview, risk summary and dashboard show both counts. | `tests/test_exits_per_day.py` (25), `test_preflight.py::test_max_exits_per_day_bound` |
| 3. Defaults taken | `0d9caea`, `f829f68` | See "Defaults taken" above. Q5 got the safer behavior in code: live sells confirmed in the last 120 s stay reserved against the holding. | `tests/test_recent_sell_reservation.py` (6) |
| 4. `capture_samples.py` | `3eef11d` | See below. | `tests/test_capture_samples.py` (18) |
| 5. Going-live criteria | `d484e57` | RUNBOOK §8 is now exactly your five criteria, plus "failing any criterion means keep paper trading". First live orders need manual confirmation, small size, and a human check of the fill against Gemini's site. To make criterion 5 checkable, the dashboard shows **Worst drawdown seen** (running peak over the whole history) and warns when it's past half of `max_drawdown_pct`. | `test_runbook.py::test_going_live_criteria_are_the_agreed_ones`, `test_dashboard.py::test_worst_drawdown_seen_over_the_whole_history` |
| 6. macOS | `dfb20b5` | See below. | `tests/test_setup_mac.py` (19, half of them under bash 3.2), `tests/test_validate_plist.py` (20) |

### Task 4: `capture_samples.py`

- **Calls:** read-only. It makes **exactly two calls**, positions and active orders, through the allowlisted, signing `ReadOnlyClient`. The tests count the requests at the fake exchange.
- **Secret check:** before writing anything, it refuses (exit code 2) if any value looks like a secret: the configured keys, Gemini `account-`/`master-` keys, `sk-ant-` keys, private keys, JWTs, or long opaque tokens. It prints only the field path, never the value.
- **Redaction:** values are redacted by field name (account, email, name, address, key, secret, token, password, signature, phone, user, owner), and email addresses are redacted anywhere. Every field **name**, the nesting and each value's **type** are kept (`"REDACTED"`, `0`, `0.0`, `false`).
- **Output:** files are written 0600 into `samples/real/`, which is now in `.gitignore`. It refuses an output directory that git would track.
- **Errors:** an API error prints only the HTTP status, never the body or any credential.
- **Report:** it then prints, for every field in `docs/real_response_check.md`, whether it was present, ABSENT or EMPTY, with the note that **an empty list proves nothing about field names**. A sync test keeps the script's field list equal to the doc's.

### Task 6: macOS

- **bash 3.2.** I built the real **bash 3.2.57** (the version macOS ships) from ftp.gnu.org. Every `setup_mac.sh` test runs under it as well as under modern bash; set `BASH32=/path/to/bash` to include those cases, otherwise they skip. The script already worked under 3.2. A static test now bans bash-4-only syntax: associative arrays, `mapfile`, `${x,,}`, `|&`, `&>>`, `coproc`, `[[ -v ]]`, negative indexes, and so on.
- **Python minimum is 3.10, not 3.11**, and I verified it both ways:
  - `mcp>=1.20` (the MCP SDK) declares `Requires-Python >=3.10`, and `vermin` reports the code itself needs ≥ 3.9.
  - **The full suite passes on Python 3.10.20** (690/690, bash 3.2 cases included).
  - On Python 3.9.23, `pip`/`uv` can't resolve the requirements at all.
- **`setup_mac.sh`** requires 3.10. If `python3` is too old (the macOS Command Line Tools' 3.9), it looks for `python3.13`…`python3.10` and Homebrew's `python3`. Otherwise it prints exactly what to install (`brew install python@3.12` or the python.org installer) and how to rerun it with `PYTHON=`.
- **`launchd/validate_plist.py`** validates the job with `plistlib`, since `plutil` isn't available here. It checks:
  - launchd's structure rules for every key used, with types and calendar ranges;
  - the DRY_RUN-only rules;
  - that there's no `--auto-confirm`, no `KeepAlive` and no secrets;
  - for an installed copy, that the placeholders are replaced and the paths exist.

  RUNBOOK §6 runs it, then `plutil -lint` on the Mac, before `launchctl bootstrap`. Writing its tests caught a bug in it: malformed XML raised `ExpatError` instead of being reported. Fixed before commit.

### Bugs found this session

- **`max_trades_per_day` blocked risk-reducing exits** (Q6). Fixed by Task 2.
- **Breakers didn't fire while nothing was proposed** (Q4). Fixed by Task 1.
- **The dashboard didn't detect the mode** from runner-only logs, so it showed no equity history. Fixed in `d484e57`.

### Still open

- **No real Mac run yet.** Run `./setup_mac.sh` and `plutil -lint` once on your Mac.
- **No real Gemini response yet.** Run `python capture_samples.py` while holding a position with a resting buy and sell, and fix any ABSENT or EMPTY required field before live.

### Nothing outside `gemini_mcp/` changed

`git diff --stat origin/claude/stoic-archimedes-iacegx -- . ':!gemini_mcp'` is empty. The bash 3.2 build and the Python 3.10/3.9 environments live in the session scratchpad, not in the repo.

### Final state of this session

`git log --oneline 697f8ca..HEAD` (7 commits, plus the commit that adds this section):

```
dfb20b5 gemini_mcp: macOS compatibility: bash 3.2, Python minimum, plist validation
d484e57 gemini_mcp: RUNBOOK going-live criteria as agreed; dashboard worst drawdown
3eef11d gemini_mcp: capture_samples.py: read-only, redacted capture of real responses
f829f68 gemini_mcp: overnight notes: answered questions and defaults taken
0d9caea gemini_mcp: reserve recently confirmed live sells against the holding (Q5)
adb37af gemini_mcp: exits exempt from max_trades_per_day; own ceiling max_exits_per_day
e383778 gemini_mcp: evaluate circuit breakers at the start of every runner run
```

Full test suite, `BASH32=<bash 3.2.57> python -m pytest -q` in `gemini_mcp/` (Python 3.11.15; the same 690 also pass on Python 3.10.20):

```
........................................................................ [ 10%]
........................................................................ [ 20%]
........................................................................ [ 31%]
........................................................................ [ 41%]
........................................................................ [ 52%]
........................................................................ [ 62%]
........................................................................ [ 73%]
........................................................................ [ 83%]
........................................................................ [ 93%]
..........................................                               [100%]
690 passed in 93.98s (0:01:33)
```

# Fast-track session (after `7c5dabf`)

Five tasks, each test-first, each pushed only after the full suite passed (pytest exit code checked directly).

## What changed

1. **Short-dated focus.** `max_days_to_expiry` (7) and `min_hours_to_expiry` (6). The runner researches and enters only contracts inside that window. Others are logged as `no_trade` "outside expiry window" before any book fetch or research. Position review ignores the window, so held positions are always reviewed. An empty window is a `ConfigError`. Preflight *notes* (doesn't fail) `max_days_to_expiry` > 30. The test fixtures' expiry moved from 2027-01-31 to 2026-09-24, inside the window.
2. **Research budget.**
   - Every research call writes a `research_cost` audit entry, failed calls included. The estimate comes from tokens and searches at config prices: by default Opus 5.5 list prices ($4 / $20 per million input / output tokens) and $0.01 per web search ($10 per 1,000).
   - The runner stops, logging `research_budget_reached` once, when the next call would pass `max_research_cost_usd_per_run` or `_per_day`. The next call is projected at the costliest call seen today.
   - The day total is read from `audit.log` and counts DRY_RUN and live together, because research costs real money in both.
   - `max_research_per_run` may go up to 20, but above 5 `load_config` requires the per-run cap.
3. **micro_live profile.**
   - `profile: <name>` applies `profiles.<name>` over the base keys. Every profile is validated even when it isn't selected.
   - `learning_budget_usd` sets the floor to start − budget, never below 40% of the start. In paper mode the bankroll stands in for the start.
   - Live preflight fails above the micro_live ceilings (5 / 15 / 4 / 2, auto-confirm off) or with `learning_budget_usd` unset, unless `allow_above_micro_live: true`. That flag is always printed as a note.
4. **Paper vs live.**
   - Each order records `paper_assumed` at confirm, in `confirmation`, `order_intent`, `order_result` and `would_place`.
   - `report.py --live` prints the PAPER vs LIVE FILLS table (price gap, fee gap, fill shortfall; N, average, worst) and the "consistently worse" flag.
5. **RUNBOOK §9 Fast track.** It sets the agreed gates. §8 now points to it instead of saying "no exceptions", and its "small size" line now says `profile: micro_live` instead of the old $2 / $5 caps.

## Defaults taken (pick the safer option, flag it here)

- **The ceilings apply to live mode whatever profile is active,** not only when `profile: micro_live` is selected. Otherwise a live config with no profile and big base limits would slip through. Going above them always needs `allow_above_micro_live: true`.
- **Live preflight requires `learning_budget_usd`** (unless overridden). The shipped micro_live profile leaves it `null`, so you must choose it. When set, it **replaces** `equity_floor_pct`, per your formula, even when that floor is lower than the 60% default.
- **Shipped research caps: $3 per run, $10 per day,** with `max_research_per_run: 10`. The config default for `max_research_per_run` dropped from 10 to 5, so a config that omits it still loads without a cost cap.
- **Unknown research usage** (an API error, for example) is charged as 200k input tokens + 16k output tokens + every search, about $1.17. That over-counts rather than under-counts.
- **A refusal fallback to another model** may cost more than the Opus 5.5 prices used in the estimate. Set the prices in `config.yaml` to the dearest model you expect.
- **"Side by side" means the paper assumption for the same order at the same moment,** not a separate paper run. That is the only apples-to-apples comparison. A parallel DRY_RUN process still works as before.
- **Fee gap:** Gemini's order history has no documented fee field. The report looks for `fee` / `fees` / `totalFee` / `feeAmount` and shows n/a, never zero, when none is present. This is added to `docs/real_response_check.md` to verify with a real response.
- **The worse-fills flag** needs N ≥ 5, and then either ≥ 2/3 of orders worse (price, fee or a shortfall) or a positive average gap.
- **A min-hours entry (6 h) is inside `exit_hours_before_expiry` (24 h).** Such an entry is sold on the next run unless it is clearly winning. I left both values as you set them and documented this in `config.yaml`.

## Open questions

- Should `max_research_cost_usd_per_day` also be *required* above some run count? Right now only the per-run cap is required, as you asked.
- Should the fast-track gate counts ("about 20", "about 15") be machine-checked, for example by preflight refusing `allow_above_micro_live` until `report.py` sees 20 settled live trades? For now they are documented, human-checked gates.

## Nothing outside `gemini_mcp/` changed

`git diff --stat 7c5dabf..HEAD -- . ':!gemini_mcp'` is empty.

# Gates-and-economics session (after `8b4c300`)

This session supersedes the fast-track session's `allow_above_micro_live` override flag: it is removed, and a config that still sets it is refused with an explanation.

## What changed

1. **Windows.** `load_config` refuses `min_hours_to_expiry < exit_hours_before_expiry`. The defaults and shipped values are 12 h and 6 h. A test enters a contract exactly 12 h out and checks that the next run (11 h left) holds it without any `near_expiry` reason.
2. **Research caps.** Above 5 research calls per run, both `max_research_cost_usd_per_run` and `_per_day` are required. The shipped values are $1 per run and $2 per day.
3. **Fast-track gates in preflight** (`preflight.fast_track_counts`; the rules are in RUNBOOK §9). Limits above micro_live need 20 settled live trades. Live auto-confirm needs 15 clean hand-confirmed live trades. A missing or unreadable `audit.log` counts as zero. To make this countable, confirmations now record `contract_expiry` and `confirmed_by`.
4. **RESEARCH ECONOMICS** table in `report.py`, per mode, with the flag.
5. **Optional screening stage** (`screening_enabled: false` by default). `GEMINI_MCP_SCREEN_MODEL` sets the model (default `claude-haiku-4-5`), with at most 1 web search and `screen_min_edge` 0.08.

## Interpretations taken (the safer reading in each case)

- **"Settled live trade"** has to be decided from `audit.log` alone, with no network. It is a live **buy** whose `order_result` is `placed` with status **`filled`** at placement, and whose recorded `contract_expiry` has passed. This deliberately under-counts:
  - an order that rested and filled later doesn't count, because `audit.log` has no evidence of the fill;
  - an order placed before this session doesn't count, because no expiry was recorded.
  The runner buys at the ask, so most entries fill at placement.
- **"Hand-confirmed"** is reported by the client: the runner sends `confirmed_by: "hand"` only after a terminal `yes`. To count, both the `order_result` and the runner's own decision must say `"hand"`. An MCP client could still claim "hand" falsely. The gate guards against process mistakes, not against a hostile client.
- **"No unconfirmed/unknown results"** is read as a **clean streak**. The 15 are counted since the last live `unconfirmed` result, the last intent without a result, or the last corrupt line. A definite `failed` doesn't reset it. That way one old unknown doesn't block auto-confirm forever (the log is append-only), but any new one starts the count again.
- **Sandbox history never unlocks production:** the counts are per `GEMINI_ENV`.
- **The ceilings** are now unlocked by history only. `learning_budget_usd` stays mandatory in live mode with no exception.
- **Research economics.** "Edge × stake" is computed as (q_adj − price) × quantity, which is the stated edge as a return on stake times the stake. The fee is subtracted once. The flag compares research cost per trade with the expected edge value **after fees**. It also flags research spent with no entries.
- **Screening.**
  - The screener sees the same rules and info as full research, without prices, so it isn't anchored to the market. It is compared with the market **mid**, in either direction.
  - The request is a plain `messages.create` with the basic `web_search_20250305` tool. Haiku 4.5 rejects the newer tool version and the effort, thinking and fallback settings that full research uses.
  - A failed screen never falls through to full research.
  - Screens count toward the dollar caps but not toward `max_research_per_run`.
  - The screen prices default to Haiku 4.5 list prices ($1 / $5 per million tokens). Change them if you change the model.
- **With the shipped $1 per-run cap,** one failed call with unknown usage (charged about $1.17) ends that run's research. A typical full call is estimated at roughly $0.4–0.6, so expect about 1–2 full researches per run unless screening filters first.

## Open questions

- Should a resting order that fills later count as settled? That would mean recording fills, for example by having the runner log an order-status check, so preflight could see them in `audit.log`.
- Should hand-confirmations through other MCP clients (a person approving in a chat) count? Today only the runner's terminal `yes` does.
- Should screening also apply to position reviews to save money? I left reviews on full research, because exits are risk control.

## Nothing outside `gemini_mcp/` changed

`git diff --stat 8b4c300..HEAD -- . ':!gemini_mcp'` is empty.

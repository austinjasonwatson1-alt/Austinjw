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

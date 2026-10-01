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

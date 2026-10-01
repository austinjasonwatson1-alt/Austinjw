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

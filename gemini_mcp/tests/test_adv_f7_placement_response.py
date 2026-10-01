"""F7: a 2xx placement or cancel response that isn't a real order (Gemini error body, no orderId) was
reported as ok: True, so the runner recorded a trade that doesn't exist."""

import pytest

from conftest import SYMBOL


@pytest.mark.parametrize("resp", [{"result": "error", "reason": "InsufficientFunds", "message": "x"},
                                  {}, None, "ok", {"status": "open"}])
def test_placement_without_order_id_is_not_reported_as_placed(env, resp):
    g = env.guard()
    env.trader.place_limit_order = lambda *a: resp
    r = g.confirm(g.propose(SYMBOL, "yes", "buy", "16", "0.50")["confirmation_token"])
    assert not r["ok"], r
    assert g.ledger.spent_on(g._today()) == 8  # spend still counted (outcome unknown)
    results = [e["result"] for e in env.audit() if e["event"] == "order_result"]
    assert results == ["unconfirmed"]


def test_cancel_error_body_is_not_reported_as_cancelled(env):
    env.trader.cancel_order = lambda oid: {"result": "error", "reason": "OrderNotFound"}
    r = env.guard().cancel(5)
    assert not r["ok"], r
    assert [e["result"] for e in env.audit() if e["event"] == "order_result"] == ["cancel_failed"]

"""A cancel counts as done only when Gemini's reply positively confirms it. Documented success reply
(developer.gemini.com/prediction-markets-spec/trading): {"result": "ok", "message": "Order N cancelled successfully"}."""

import pytest

import report


def results(env):
    return [e for e in env.audit() if e["event"] == "order_result"]


@pytest.mark.parametrize("resp", [
    {"result": "ok", "message": "Order 42 cancelled successfully"},
    {"result": "OK"},
    {"is_cancelled": True},
    {"orderId": 42, "status": "cancelled"},
    {"orderId": 42, "status": "Cancelled", "cancelledAt": "2026-09-21T00:00:00Z"},
])
def test_positive_confirmation_counts(env, resp):
    env.trader.cancel_order = lambda oid: resp
    r = env.guard().cancel(42)
    assert r["ok"] is True, r
    assert results(env)[0]["result"] == "cancelled"


@pytest.mark.parametrize("resp", [
    {}, {"message": "cancelled"}, {"result": "pending"}, {"status": "open"}, {"is_cancelled": "true"},
    {"result": "ok", "is_cancelled": False}, {"orderId": 99, "status": "cancelled"}, None, "ok", [],
])
def test_anything_else_is_unconfirmed(env, resp):
    env.trader.cancel_order = lambda oid: resp
    r = env.guard().cancel(42)
    assert r["ok"] is False and r["order_id"] == 42 and "unconfirmed" in r["error"], r
    assert results(env)[0]["result"] == "unconfirmed"
    unknown = report.unknown_orders(env.audit())
    assert len(unknown) == 1 and unknown[0]["action"] == "cancel" and "check Gemini" in unknown[0]["status"]


def test_explicit_error_is_cancel_failed(env):
    env.trader.cancel_order = lambda oid: {"result": "error", "reason": "OrderNotFound"}
    r = env.guard().cancel(42)
    assert r["ok"] is False
    assert results(env)[0]["result"] == "cancel_failed"

"""order_intent is written (and fsync'd) before any placement or cancel is sent; order_result after.
An intent with no result is reported as 'unknown, check Gemini'."""

import os

import pytest

import guardrails
import report
from conftest import SYMBOL


def events(env, name=None):
    return [e for e in env.audit() if name is None or e["event"] == name]


def propose(g, qty="4", price="0.50"):
    r = g.propose(SYMBOL, "yes", "buy", qty, price)
    assert r["ok"], r
    return r["confirmation_token"]


@pytest.fixture
def trace(env, monkeypatch):
    """Records fsyncs and sends in order."""
    seq = []
    real_fsync = os.fsync
    monkeypatch.setattr(guardrails.os, "fsync", lambda fd: (seq.append("fsync"), real_fsync(fd))[1])
    place, cancel = env.trader.place_limit_order, env.trader.cancel_order

    def traced_place(*a):
        seq.append(("send", events(env)[-1]["event"]))
        return place(*a)

    def traced_cancel(*a):
        seq.append(("send", events(env)[-1]["event"]))
        return cancel(*a)

    env.trader.place_limit_order, env.trader.cancel_order = traced_place, traced_cancel
    return seq


def test_placement_intent_is_fsynced_before_send_and_result_after(env, trace):
    g = env.guard()
    tok = propose(g)
    trace.clear()
    r = g.confirm(tok)
    assert r["ok"] and r["order_id"] == 1001
    send = trace.index(("send", "order_intent"))  # last audit entry at send time was the intent
    assert "fsync" in trace[:send] and "fsync" in trace[send + 1:]
    intent, result = events(env, "order_intent")[0], events(env, "order_result")[0]
    assert intent["action"] == "place" and intent["intent_id"] == result["intent_id"]
    assert intent["instrument_symbol"] == SYMBOL and intent["quantity"] == "4"
    assert result["result"] == "placed" and result["order_id"] == 1001


def test_cancel_intent_is_fsynced_before_send_and_result_after(env, trace):
    r = env.guard().cancel(42)
    assert r["ok"]
    send = trace.index(("send", "order_intent"))
    assert "fsync" in trace[:send] and "fsync" in trace[send + 1:]
    intent, result = events(env, "order_intent")[0], events(env, "order_result")[0]
    assert intent["action"] == "cancel" and intent["order_id"] == 42
    assert result["result"] == "cancelled" and result["intent_id"] == intent["intent_id"]


def test_result_write_failure_after_successful_send_returns_order_id(env, monkeypatch):
    g = env.guard()
    tok = propose(g)
    real = g.audit.write

    def flaky(event, **f):
        if event == "order_result":
            raise OSError("disk full")
        return real(event, **f)

    monkeypatch.setattr(g.audit, "write", flaky)
    r = g.confirm(tok)
    assert r["ok"] is False and r["order_id"] == 1001 and "1001" in r["error"], r
    assert len(env.trader.placed) == 1


def test_cancel_result_write_failure_returns_order_id(env, monkeypatch):
    g = env.guard()
    real = g.audit.write
    monkeypatch.setattr(g.audit, "write", lambda e, **f: (_ for _ in ()).throw(OSError("disk full"))
                        if e == "order_result" else real(e, **f))
    r = g.cancel(42)
    assert r["ok"] is False and r["order_id"] == 42 and "42" in r["error"], r
    assert env.trader.cancelled == [42]


def test_intent_write_failure_sends_nothing(env, monkeypatch):
    g = env.guard()
    tok = propose(g)
    real = g.audit.write
    monkeypatch.setattr(g.audit, "write", lambda e, **f: (_ for _ in ()).throw(OSError("disk full"))
                        if e == "order_intent" else real(e, **f))
    r = g.confirm(tok)
    assert r["ok"] is False and "NOT sent" in r["error"]
    assert g.cancel(5)["ok"] is False
    assert env.trader.placed == [] and env.trader.cancelled == []


@pytest.mark.parametrize("resp,result", [
    (RuntimeError("timeout"), "unconfirmed"),  # outcome unknown: the order may exist
    (__import__("gemini_client").GeminiAPIError("/v1/prediction-markets/order", 400, '{"result":"error"}'), "failed"),
    (__import__("gemini_client").GeminiAPIError("/v1/prediction-markets/order", 503, "unavailable"), "unconfirmed"),
    ({"result": "error"}, "unconfirmed")])
def test_failed_or_unconfirmed_send_gets_a_result(env, resp, result):
    g = env.guard()

    def place(*a):
        if isinstance(resp, Exception):
            raise resp
        return resp

    env.trader.place_limit_order = place
    assert not g.confirm(propose(g))["ok"]
    assert events(env, "order_result")[0]["result"] == result


def test_dry_run_writes_no_intent(env):
    d = env.guard(dry_run=True)
    d.confirm(d.propose(SYMBOL, "no", "buy", "2", "0.36")["confirmation_token"])
    d.cancel(5)
    assert events(env, "order_intent") == [] and events(env, "order_result") == []


# --------------------------------------------------------------- report


def intent(iid, action="place", **f):
    return {"ts": "2026-09-21T10:00:00+00:00", "event": "order_intent", "intent_id": iid, "action": action,
            "instrument_symbol": SYMBOL, "side": "buy", "outcome": "yes", "quantity": "4", "limit_price": "0.5", **f}


def result(iid, res, **f):
    return {"ts": "2026-09-21T10:00:01+00:00", "event": "order_result", "intent_id": iid, "result": res, **f}


def test_report_flags_intent_without_result_as_unknown():
    audit = [intent("a"), result("a", "placed", order_id=1), intent("b"), intent("c", action="cancel", order_id=9),
             intent("d"), result("d", "unconfirmed")]
    unknown = report.unknown_orders(audit)
    assert [u["intent_id"] for u in unknown] == ["b", "c", "d"]
    assert all(u["status"].startswith("unknown") and "check Gemini" in u["status"] for u in unknown)
    text = report.format_report([], {"by_kind": {}, "top_reasons": []}, unknown=unknown)
    assert "unknown, check Gemini" in text and "b" in text


def test_report_live_fills_read_order_results():
    class Client:
        def list_order_history(self, limit, offset):
            return {"orders": [{"orderId": 1, "filledQuantity": "4", "avgExecutionPrice": "0.5"},
                               {"orderId": 2, "filledQuantity": "2", "avgExecutionPrice": "0.4"}]}

    audit = [{**intent("a"), **result("a", "placed", order_id=1)},
             {"event": "placement", "order_id": 2, "instrument_symbol": SYMBOL, "outcome": "yes", "side": "buy"}]
    fills = report.live_fills(audit, Client(), guardrails.Decimal("0.02"))
    assert sorted(f.ref for f in fills) == ["live:1", "live:2"]


def test_unknown_order_status_names_the_real_cause():
    audit = [intent("t"), result("t", "unconfirmed", error="read timed out after the request was applied"),
             intent("n"), result("n", "unconfirmed", response={"result": "error"})]
    by_id = {u["intent_id"]: u["status"] for u in report.unknown_orders(audit)}
    assert "timed out" in by_id["t"] and "no order id" not in by_id["t"]
    assert by_id["n"].startswith("unknown, check Gemini")

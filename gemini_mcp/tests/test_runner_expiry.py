"""Runner entries: a contract with no usable expiry date is never entered (the near-expiry exit can't work)."""

from conftest import EVENT, make_contract, make_event
from test_runner import by_kind, run


def market(env, contract_expiry=None, event_expiry=None):
    c = make_contract(prices={"buy": {"yes": "0.62", "no": "0.40"}, "sell": {"yes": "0.60", "no": "0.38"},
                              "bestBid": "0.60", "bestAsk": "0.62"})
    if contract_expiry is not None:
        c["expiryDate"] = contract_expiry
    ev = make_event(contracts=[c])
    if event_expiry is not None:
        ev["expiryDate"] = event_expiry
    env.market.events[EVENT] = ev
    env.market.book = {"bids": [["0.60", "500"]], "asks": [["0.62", "500"]]}


def test_no_expiry_is_skipped_before_research_and_logged(env):
    market(env)
    decisions, tools, calls, _ = run(env)
    nt = by_kind(decisions, "no_trade")
    assert nt and "no expiry date" in nt[0]["reason"]
    assert calls == [] and "propose_order" not in tools.calls and "get_order_book" not in tools.calls
    logged = [e for e in env.audit() if e["event"] == "decision" and e.get("kind") == "no_trade"]
    assert "no expiry date" in logged[0]["reason"]


def test_unparseable_expiry_is_skipped(env):
    market(env, contract_expiry="soon")
    decisions, _, calls, _ = run(env)
    assert "no expiry date" in by_kind(decisions, "no_trade")[0]["reason"] and calls == []


def test_event_level_expiry_is_enough(env):
    market(env, event_expiry="2026-09-24T00:00:00Z")
    decisions, _, calls, _ = run(env)
    assert calls and by_kind(decisions, "entry")


def test_contract_expiry_entry_still_works(env):
    market(env, contract_expiry="2026-09-24T00:00:00Z")
    decisions, _, _, _ = run(env)
    assert by_kind(decisions, "entry")

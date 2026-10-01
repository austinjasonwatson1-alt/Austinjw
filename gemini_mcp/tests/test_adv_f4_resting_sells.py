"""F4: when the positions API omits quantityOnHold, quantity already committed to resting sell orders
was treated as available, so a second sell could exceed holdings."""

from conftest import SYMBOL


def resting_sell(qty, outcome="yes"):
    return {"orderId": 7, "symbol": SYMBOL, "outcome": outcome, "side": "sell", "remainingQuantity": qty,
            "price": "0.70"}


def test_resting_sell_reduces_available_when_on_hold_missing(env):
    env.market.positions = {"positions": [{"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "10"}]}
    env.market.active = {"orders": [resting_sell("10")]}
    r = env.guard().propose(SYMBOL, "yes", "sell", "10", "0.70")
    assert not r["ok"] and "exceeds" in r["reason"], r


def test_partial_resting_sell(env):
    env.market.positions = {"positions": [{"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "10"}]}
    env.market.active = {"orders": [resting_sell("4")]}
    g = env.guard()
    assert not g.propose(SYMBOL, "yes", "sell", "7", "0.70")["ok"]
    assert g.propose(SYMBOL, "yes", "sell", "6", "0.70")["ok"]


def test_on_hold_and_resting_sells_are_not_double_subtracted(env):
    env.market.positions = {"positions": [
        {"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "10", "quantityOnHold": "4"}]}
    env.market.active = {"orders": [resting_sell("4")]}
    assert env.guard().propose(SYMBOL, "yes", "sell", "6", "0.70")["ok"]


def test_resting_sell_of_other_outcome_does_not_reduce(env):
    env.market.positions = {"positions": [{"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "10"}]}
    env.market.active = {"orders": [resting_sell("10", outcome="no")]}
    assert env.guard().propose(SYMBOL, "yes", "sell", "10", "0.70")["ok"]

"""F4: quantity committed to resting sell orders must not be sellable again, even when the positions API's
quantityOnHold lags (reports less than the resting sells)."""

from conftest import SYMBOL, make_order, make_position


def resting_sell(qty, outcome="yes"):
    return make_order(7, side="sell", outcome=outcome, remaining=qty, price="0.70")


def test_resting_sell_reduces_available_when_on_hold_lags(env):
    env.market.positions = {"positions": [make_position(total="10")]}
    env.market.active = {"orders": [resting_sell("10")]}
    r = env.guard().propose(SYMBOL, "yes", "sell", "10", "0.70")
    assert not r["ok"] and "exceeds" in r["reason"], r


def test_partial_resting_sell(env):
    env.market.positions = {"positions": [make_position(total="10")]}
    env.market.active = {"orders": [resting_sell("4")]}
    g = env.guard()
    assert not g.propose(SYMBOL, "yes", "sell", "7", "0.70")["ok"]
    assert g.propose(SYMBOL, "yes", "sell", "6", "0.70")["ok"]


def test_on_hold_and_resting_sells_are_not_double_subtracted(env):
    env.market.positions = {"positions": [make_position(total="10", on_hold="4")]}
    env.market.active = {"orders": [resting_sell("4")]}
    assert env.guard().propose(SYMBOL, "yes", "sell", "6", "0.70")["ok"]


def test_resting_sell_of_other_outcome_does_not_reduce(env):
    env.market.positions = {"positions": [make_position(total="10")]}
    env.market.active = {"orders": [resting_sell("10", outcome="no")]}
    assert env.guard().propose(SYMBOL, "yes", "sell", "10", "0.70")["ok"]

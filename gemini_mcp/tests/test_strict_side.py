"""Open-order side: case is normalized; any other value makes the whole exposure read fail closed."""

import pytest

from conftest import EVENT, SYMBOL

NEAR_CAP_BUY = {"orderId": 1, "symbol": SYMBOL, "outcome": "yes", "remainingQuantity": "240", "price": "0.70",
                "contractMetadata": {"eventTicker": EVENT, "category": "economics"}}


@pytest.mark.parametrize("side", ["BUY", "Buy", "buy"])
def test_buy_side_any_case_counts_toward_exposure(env, side):
    env.market.active = {"orders": [{**NEAR_CAP_BUY, "side": side}]}  # $168 resting > 15% cap after +$10
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert not r["ok"] and "max_market_pct_of_balance" in r["reason"], r


@pytest.mark.parametrize("side", ["SELL", "Sell"])
def test_sell_side_any_case_reserves_holdings(env, side):
    env.market.positions = {"positions": [{"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "10",
                                           "quantityOnHold": "0", "avgPrice": "0.5", "marketValue": "5",
                                           "contractMetadata": {"eventTicker": EVENT, "category": "economics"}}]}
    env.market.active = {"orders": [{**NEAR_CAP_BUY, "side": side, "remainingQuantity": "10"}]}
    r = env.guard().propose(SYMBOL, "yes", "sell", "10", "0.70")
    assert not r["ok"] and "exceeds" in r["reason"], r


@pytest.mark.parametrize("side", ["short", "", None, 1, "bid", " buy"])
def test_unknown_side_fails_the_exposure_read(env, side):
    env.market.active = {"orders": [{**NEAR_CAP_BUY, "remainingQuantity": "1", "side": side}]}
    g = env.guard()
    for r in (g.propose(SYMBOL, "yes", "buy", "2", "0.50"), g.propose(SYMBOL, "yes", "sell", "1", "0.70")):
        assert not r["ok"] and "side" in r["reason"], r
    rej = [e for e in env.audit() if e["event"] == "rejection"]
    assert len(rej) == 2 and all("side" in e["reason"] for e in rej)
    assert env.trader.placed == []

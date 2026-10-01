"""F3: negative quantities, prices or values from the positions / open-orders API reduced counted
exposure (max(cost, value) of a negative position is negative), letting a buy past the market cap."""

import pytest

from conftest import EVENT, SYMBOL

NEAR_CAP = {"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "240", "avgPrice": "0.70", "marketValue": "168",
            "contractMetadata": {"eventTicker": EVENT}}


@pytest.mark.parametrize("bad", [
    {"totalQuantity": "-1000", "avgPrice": "0.5", "marketValue": "-500"},
    {"totalQuantity": "10", "avgPrice": "-50", "marketValue": "1"},
    {"totalQuantity": "10", "avgPrice": "0.5", "marketValue": "-500"},
    {"totalQuantity": "10", "quantityOnHold": "-5", "avgPrice": "0.5", "marketValue": "5"},
])
def test_negative_position_fields_fail_closed(env, bad):
    other = {"symbol": "GEMI-FEDJAN26-OTHER", "outcome": "no", "contractMetadata": {"eventTicker": EVENT}, **bad}
    env.market.positions = {"positions": [NEAR_CAP, other]}
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert not r["ok"] and "invalid" in r["reason"], r


@pytest.mark.parametrize("bad", [{"remainingQuantity": "-1000", "price": "0.5"},
                                 {"remainingQuantity": "10", "price": "-50"},
                                 {"remainingQuantity": "10", "price": "7"}])
def test_negative_or_out_of_range_open_order_fails_closed(env, bad):
    env.market.positions = {"positions": [NEAR_CAP]}
    env.market.active = {"orders": [{"orderId": 9, "symbol": "GEMI-FEDJAN26-OTHER", "outcome": "no", "side": "buy",
                                     "contractMetadata": {"eventTicker": EVENT}, **bad}]}
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert not r["ok"] and "invalid" in r["reason"], r

"""F9: NaN / infinite / non-positive increments from the event API raised decimal.InvalidOperation out of
propose (no audit entry) instead of a clean, logged rejection."""

import pytest

from conftest import EVENT, SYMBOL, make_contract, make_event


@pytest.mark.parametrize("field,value", [("priceIncrement", "NaN"), ("priceIncrement", "Infinity"),
                                         ("priceIncrement", "0"), ("quantityIncrement", "NaN"),
                                         ("quantityIncrement", "-1"), ("priceMinimum", "NaN"),
                                         ("quantityMinimum", "sNaN"), ("priceIncrement", None)])
def test_bad_increments_are_logged_rejections(env, field, value):
    env.market.events[EVENT] = make_event(contracts=[make_contract(**{field: value})])
    r = env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")
    assert r["ok"] is False and r["rejected"], r
    assert env.audit()[-1]["event"] == "rejection"

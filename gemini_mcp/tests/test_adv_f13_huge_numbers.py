"""F13: absurd magnitudes ("1e999999") passed input parsing, became million-digit strings, and then raised
decimal.InvalidOperation out of propose (unaudited) instead of a small, logged rejection."""

import pytest

from conftest import SYMBOL


@pytest.mark.parametrize("qty,price,prob", [("1e999999", "0.5", None), ("1e30", "0.5", None),
                                            ("4", "1e-999999", None), ("4", "0.5000000000000000000000000001", None),
                                            (None, "0.5", "1e-999999")])
def test_absurd_magnitudes_are_small_logged_rejections(env, qty, price, prob):
    r = env.guard().propose(SYMBOL, "yes", "buy", qty, price, prob)
    assert r["ok"] is False and r["rejected"], r
    assert env.audit_path.stat().st_size < 10_000

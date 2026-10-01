"""Circuit breakers (auto-KILL) and the order-book quality check (wide spread / thin book)."""

import json
from decimal import Decimal as D

import pytest

from conftest import EVENT, SYMBOL, write_config
from guardrails import check_book, evaluate_breakers


def events_of(env, name):
    return [e for e in env.audit() if e["event"] == name]


def set_equity(env, amount):
    env.market.balances[0]["amount"] = env.market.balances[0]["available"] = str(amount)


# --------------------------------------------------------------- pure breaker math


def test_evaluate_breakers():
    assert evaluate_breakers(D("1000"), D("1000"), D("1000"), D("0.2"), D("0.08")) is None
    assert "max drawdown" in evaluate_breakers(D("790"), D("1000"), D("790"), D("0.2"), D("0.08"))
    assert "max daily loss" in evaluate_breakers(D("910"), D("1000"), D("1000"), D("0.2"), D("0.08"))
    assert evaluate_breakers(D("921"), D("1000"), D("1000"), D("0.2"), D("0.08")) is None
    assert evaluate_breakers(D("0"), D("0"), D("0"), D("0.2"), D("0.08")) is None  # unfunded


# --------------------------------------------------------------- breaker trips create KILL


def test_drawdown_trip_creates_kill(env):
    g = env.guard()
    assert g.propose(SYMBOL, "yes", "buy", "1", "0.40")["ok"]  # day 1: peak = 1000
    env.clock.t += 86400  # next UTC day: start-of-day equity resets, peak doesn't
    set_equity(env, 790)  # 21% below peak, 0% daily loss
    r = g.propose(SYMBOL, "yes", "buy", "1", "0.40")
    assert not r["ok"] and "circuit breaker tripped" in r["reason"] and "max drawdown" in r["reason"]
    assert env.kill_path.exists()
    kill = json.loads(env.kill_path.read_text())
    assert kill["created_by"] == "circuit_breaker" and kill["peak"] == "1000"
    trip = events_of(env, "circuit_breaker_trip")
    assert len(trip) == 1 and "max drawdown" in trip[0]["reason"]
    # Everything is blocked now, until the file is deleted by hand.
    r = g.propose(SYMBOL, "yes", "buy", "1", "0.40")
    assert not r["ok"] and "kill switch is active" in r["reason"]


def test_daily_loss_trip_creates_kill(env):
    g = env.guard()
    assert g.propose(SYMBOL, "yes", "buy", "1", "0.40")["ok"]
    set_equity(env, 910)  # 9% down today
    r = g.propose(SYMBOL, "yes", "buy", "1", "0.40")
    assert not r["ok"] and "max daily loss" in r["reason"] and env.kill_path.exists()


def test_breakers_checked_on_confirm_too(env):
    g = env.guard()
    token = g.propose(SYMBOL, "yes", "buy", "1", "0.40")["confirmation_token"]
    set_equity(env, 500)
    r = g.confirm(token)
    assert not r["ok"] and "circuit breaker" in r["reason"] and env.kill_path.exists()
    assert env.trader.placed == []


def test_sells_also_blocked_after_trip(env):
    g = env.guard()
    g.propose(SYMBOL, "yes", "buy", "1", "0.40")
    set_equity(env, 500)
    env.market.positions = {"positions": [{"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "5"}]}
    r = g.propose(SYMBOL, "yes", "sell", "5", "0.40")
    assert not r["ok"] and "circuit breaker" in r["reason"]


def test_deleting_kill_rebaselines_drawdown_peak(env):
    g = env.guard()
    g.propose(SYMBOL, "yes", "buy", "1", "0.40")
    env.clock.t += 86400
    set_equity(env, 790)
    assert not g.propose(SYMBOL, "yes", "buy", "1", "0.40")["ok"] and env.kill_path.exists()
    env.kill_path.unlink()  # manual acknowledgement
    assert g.propose(SYMBOL, "yes", "buy", "1", "0.40")["ok"]
    assert events_of(env, "breaker_reset")[0]["equity"] == "790"


def test_daily_loss_retrips_same_day_after_manual_delete(env):
    g = env.guard()
    g.propose(SYMBOL, "yes", "buy", "1", "0.40")
    set_equity(env, 900)
    assert not g.propose(SYMBOL, "yes", "buy", "1", "0.40")["ok"]
    env.kill_path.unlink()
    r = g.propose(SYMBOL, "yes", "buy", "1", "0.40")
    assert not r["ok"] and "max daily loss" in r["reason"] and env.kill_path.exists()


def test_equity_lookup_failure_rejects_without_tripping(env):
    env.market.balances_error = RuntimeError("HTTP 500")
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", "0.40")
    assert not r["ok"] and "balances lookup failed" in r["reason"]
    assert not env.kill_path.exists()


def test_position_value_missing_counts_as_zero(env):
    env.market.positions = {"positions": [
        {"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "100", "avgPrice": "0.5"}]}  # no marketValue
    s = env.guard().risk_summary()
    assert s["equity_usd"] == "1000.00" and s["event_exposure_usd"]  # exposure counts cost basis $50


def test_paper_breaker_uses_paper_equity(env):
    write_config(env.config_path, max_drawdown_pct=0.05)
    g = env.guard(dry_run=True)
    g.propose(SYMBOL, "yes", "buy", "1", "0.40")
    # Paper buy that fills (limit at the REST ask 0.66), then the bid collapses to 0.01.
    t = g.propose(SYMBOL, "yes", "buy", "11", "0.66")["confirmation_token"]
    assert g.confirm(t)["paper_filled"] is True
    env.market.events[EVENT]["contracts"][0]["prices"]["sell"]["yes"] = "0.01"
    s = g.risk_summary()
    assert s["source"] == "paper" and D(s["equity_usd"]) < 100
    r = g.propose(SYMBOL, "yes", "buy", "1", "0.40")
    assert not r["ok"] and "max drawdown" in r["reason"] and env.kill_path.exists()


# --------------------------------------------------------------- order book: wide spread / thin book


BOOK = {"bids": [["0.60", "100"], ["0.59", "400"]], "asks": [["0.62", "100"], ["0.63", "300"]]}


def test_tight_deep_book_passes():
    c = check_book(BOOK, "yes", max_spread=D("0.04"), limit_price=D("0.62"), quantity=D("50"))
    assert c.ok and c.spread == D("0.02") and c.buy_price == D("0.62") and c.sell_price == D("0.60")
    assert c.depth_contracts == D("100")


def test_wide_spread_rejected():
    book = {"bids": [["0.02", "157"]], "asks": [["0.99", "100"]]}  # seen live on a Fed contract
    c = check_book(book, "yes", max_spread=D("0.04"))
    assert not c.ok and "wide spread" in c.reason and c.spread == D("0.97")


def test_spread_exactly_at_limit_passes():
    book = {"bids": [["0.60", "10"]], "asks": [["0.64", "10"]]}
    assert check_book(book, "yes", max_spread=D("0.04")).ok


@pytest.mark.parametrize("book,needle", [
    ({"bids": [], "asks": [["0.62", "10"]]}, "no bids"),
    ({"bids": [["0.60", "10"]], "asks": []}, "no asks"),
    ({"bids": [["0.60", "0"]], "asks": [["0.62", "10"]]}, "no bids"),  # zero-size level ignored
])
def test_empty_side_is_thin(book, needle):
    c = check_book(book, "yes", max_spread=D("0.04"))
    assert not c.ok and "thin book" in c.reason and needle in c.reason


def test_thin_book_when_depth_below_order_size():
    c = check_book(BOOK, "yes", max_spread=D("0.04"), limit_price=D("0.62"), quantity=D("150"))
    assert not c.ok and "thin book" in c.reason and c.depth_contracts == D("100")
    # Raising the limit reaches the next level.
    assert check_book(BOOK, "yes", max_spread=D("0.04"), limit_price=D("0.63"), quantity=D("150")).ok


def test_depth_multiple():
    c = check_book(BOOK, "yes", max_spread=D("0.04"), limit_price=D("0.62"), quantity=D("60"),
                   min_depth_multiple=D("2"))
    assert not c.ok and "need 120" in c.reason


def test_no_side_depth_uses_yes_bids():
    # Buying NO at 0.40 = selling YES at 0.60: fills against YES bids >= 0.60 (100 contracts).
    c = check_book(BOOK, "no", max_spread=D("0.04"), limit_price=D("0.40"), quantity=D("100"))
    assert c.ok and c.buy_price == D("0.40") and c.sell_price == D("0.38")
    c = check_book(BOOK, "no", max_spread=D("0.04"), limit_price=D("0.40"), quantity=D("101"))
    assert not c.ok and "thin book" in c.reason
    c = check_book(BOOK, "no", max_spread=D("0.04"), limit_price=D("0.41"), quantity=D("500"))
    assert c.ok  # 0.59 and 0.60 bids


@pytest.mark.parametrize("book", [None, {}, {"bids": "x", "asks": []}, {"bids": [["a", "1"]], "asks": [["0.6", "1"]]},
                                  {"bids": [["0.6"]], "asks": [["0.62", "1"]]}])
def test_unparseable_book_rejected(book):
    c = check_book(book, "yes", max_spread=D("0.04"))
    assert not c.ok

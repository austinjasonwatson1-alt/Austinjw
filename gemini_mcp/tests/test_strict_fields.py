"""Item 3: every Gemini field that feeds orders, exposure, holdings or balances must be present and valid.
An absent or unexpected value rejects the proposal (logged) instead of being guessed."""

import pytest

from conftest import EVENT, SYMBOL, make_contract, make_event, make_order, make_position, write_config


def refused(env, needle, side="buy"):
    g = env.guard()
    r = (g.propose(SYMBOL, "yes", "buy", "2", "0.50") if side == "buy"
         else g.propose(SYMBOL, "yes", "sell", "1", "0.70"))
    assert not r["ok"] and needle in r["reason"], r
    assert env.audit()[-1]["event"] == "rejection"
    assert env.trader.placed == []


def drop(d, *path):
    cur = d
    for k in path[:-1]:
        cur = cur[k]
    cur.pop(path[-1])
    return d


# --------------------------------------------------------------- open orders


def test_complete_order_is_accepted(env):
    env.market.active = {"orders": [make_order(side="SELL", outcome="YES", remaining="1")]}
    env.market.positions = {"positions": [make_position()]}
    assert env.guard().propose(SYMBOL, "yes", "sell", "9", "0.70")["ok"]


@pytest.mark.parametrize("entry", [None, "x", 5, []])
def test_order_entry_not_an_object(env, entry):
    env.market.active = {"orders": [entry]}
    refused(env, "open orders")


@pytest.mark.parametrize("path", [("symbol",), ("outcome",), ("remainingQuantity",),
                                  ("contractMetadata",), ("contractMetadata", "eventTicker"),
                                  ("contractMetadata", "category")])
@pytest.mark.parametrize("side", ["buy", "sell"])
def test_order_missing_field(env, path, side):
    env.market.active = {"orders": [drop(make_order(side=side), *path)]}
    refused(env, "open orders")


@pytest.mark.parametrize("field,value", [("symbol", ""), ("symbol", 7), ("outcome", "maybe"), ("outcome", None),
                                         ("remainingQuantity", None), ("remainingQuantity", "abc")])
def test_order_bad_field(env, field, value):
    env.market.active = {"orders": [make_order(side="sell", **{field: value})]}
    refused(env, "open orders")


def test_numeric_zero_remaining_is_zero_not_quantity(env):
    env.market.positions = {"positions": [make_position(total="10")]}
    env.market.active = {"orders": [make_order(side="sell", remaining="10", remainingQuantity=0)]}
    assert env.guard().propose(SYMBOL, "yes", "sell", "10", "0.70")["ok"]


# --------------------------------------------------------------- positions


@pytest.mark.parametrize("path", [("quantityOnHold",), ("avgPrice",), ("contractMetadata",),
                                  ("contractMetadata", "eventTicker"), ("contractMetadata", "category")])
@pytest.mark.parametrize("side", ["buy", "sell"])
def test_position_missing_field(env, path, side):
    env.market.positions = {"positions": [drop(make_position(), *path)]}
    refused(env, "positions lookup", side)


@pytest.mark.parametrize("field,value", [("quantityOnHold", None), ("avgPrice", None),
                                         ("contractMetadata", "x")])
def test_position_bad_field(env, field, value):
    env.market.positions = {"positions": [make_position(**{field: value})]}
    refused(env, "positions lookup")


def test_position_without_market_value_is_still_valued_at_zero(env):
    # Kept on purpose: $0 is conservative for every cap and breaker; refusing would block exits.
    env.market.positions = {"positions": [drop(make_position(), "marketValue")]}
    assert env.guard().propose(SYMBOL, "yes", "sell", "1", "0.70")["ok"]


# --------------------------------------------------------------- balances


@pytest.mark.parametrize("balances,needle", [
    ([{"currency": "BTC", "amount": "1", "available": "1"}], "USD"),
    ([], "USD"),
    ([{"currency": "USD", "amount": "1000", "available": "1000"},
      {"currency": "usd", "amount": "5", "available": "5"}], "USD"),
    ([{"currency": "USD", "amount": "1000", "available": "1000"}, "junk"], "balances"),
])
def test_balances_must_have_exactly_one_usd_entry(env, balances, needle):
    env.market.balances = balances
    refused(env, needle)
    assert not env.kill_path.exists()  # a malformed response must not trip a breaker


# --------------------------------------------------------------- event category vs category caps


def test_missing_event_category_with_caps_configured_is_refused(env):
    write_config(env.config_path, category_exposure_caps={"sports": 0.2})  # no default
    env.market.events[EVENT] = make_event()  # no category
    refused(env, "category")


def test_missing_event_category_without_caps_is_fine(env):
    env.market.events[EVENT] = make_event()
    assert env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")["ok"]


# --------------------------------------------------------------- placement status


@pytest.mark.parametrize("status", ["open", "OPEN", "filled", "Filled"])
def test_placement_open_or_filled_is_placed(env, status):
    env.trader.place_limit_order = lambda *a: {"orderId": 5, "status": status}
    g = env.guard()
    assert g.confirm(g.propose(SYMBOL, "yes", "buy", "2", "0.50")["confirmation_token"])["ok"]


@pytest.mark.parametrize("resp", [{"orderId": 5, "status": "cancelled"}, {"orderId": 5, "status": "rejected"},
                                  {"orderId": 5}, {"orderId": 5, "status": None},
                                  {"orderId": 5, "status": "open", "symbol": "GEMI-OTHER"},
                                  {"orderId": 5, "status": "open", "side": "sell"},
                                  {"orderId": 5, "status": "open", "outcome": "no"},
                                  {"orderId": 5, "status": "open", "quantity": "999"},
                                  {"orderId": 5, "status": "open", "price": "0.99"}])
def test_placement_not_positively_confirmed_is_unconfirmed(env, resp):
    env.trader.place_limit_order = lambda *a: resp
    g = env.guard()
    r = g.confirm(g.propose(SYMBOL, "yes", "buy", "2", "0.50")["confirmation_token"])
    assert r["ok"] is False and r["order_id"] == 5, r
    assert [e["result"] for e in env.audit() if e["event"] == "order_result"] == ["unconfirmed"]


def test_placement_echo_matching_request_is_placed(env):
    env.trader.place_limit_order = lambda *a: {"orderId": 5, "status": "open", "symbol": SYMBOL, "side": "BUY",
                                               "outcome": "yes", "quantity": "2", "price": "0.5"}
    g = env.guard()
    assert g.confirm(g.propose(SYMBOL, "yes", "buy", "2", "0.50")["confirmation_token"])["ok"]


def test_contract_fixture_untouched():
    assert make_contract()["instrumentSymbol"] == SYMBOL

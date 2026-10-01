"""Conviction sizing: pure size_position() plus the server enforcing it through propose_order."""

from decimal import Decimal as D

import pytest

from conftest import EVENT, SYMBOL, make_contract, make_event, write_config
from guardrails import shrink, size_position

BASE = dict(
    outcome="yes", balance=D("1000"), p=D("0.40"), q=D("0.60"), fee=D("0.02"),
    estimate_weight=D("0.7"), min_edge=D("0.05"), kelly_multiplier=D("0.25"),
    max_order_pct=D("0.08"), max_market_pct=D("0.15"), existing_market_exposure=D("0"),
    daily_budget_remaining=D("1000"), dollar_ceiling=D("1000"), available_cash=D("1000"),
    quantity_increment=D("1"), quantity_minimum=D("1"),
)


def size(**over):
    return size_position(**{**BASE, **over})


def test_shrinkage_formula():
    assert shrink(D("0.60"), D("0.40"), D("0.7")) == D("0.540")
    assert shrink(D("0.60"), D("0.40"), D("1")) == D("0.60")  # trust estimate fully
    assert shrink(D("0.60"), D("0.40"), D("0")) == D("0.40")  # trust market fully
    r = size()
    assert r.q_adj == D("0.540")
    assert r.edge == D("0.540") - D("0.40") - D("0.02")  # 0.12


def test_kelly_math_unclamped():
    r = size()
    # f = 0.12 / 0.60 = 0.2 ; stake = 1000 * 0.2 * 0.25 = 50 (< 8% = 80)
    assert r.kelly_fraction == D("0.2")
    assert r.binding_limit == "kelly"
    assert r.limits["kelly"] == D("50.000")
    assert r.quantity == D("119")  # floor(50 / (0.40 + 0.02))
    assert r.stake_usd == D("119") * D("0.40")


def test_sizing_scales_with_edge():
    stakes = [size(q=D(q), dollar_ceiling=D("10000"), max_order_pct=D("1"), max_market_pct=D("1")).stake_usd
              for q in ("0.55", "0.65", "0.75", "0.85")]
    assert stakes == sorted(stakes) and len(set(stakes)) == 4


def test_zero_size_under_min_edge():
    r = size(q=D("0.50"))  # q_adj 0.47, edge 0.05 - ... = 0.47-0.40-0.02 = 0.05 -> exactly min is allowed
    assert r.quantity > 0
    r = size(q=D("0.49"))  # q_adj 0.463 -> edge 0.043 < 0.05
    assert r.quantity == 0 and r.stake_usd == 0 and "below min_edge" in r.skip_reason


@pytest.mark.parametrize("over,binding", [
    ({"max_order_pct": D("0.01")}, "order_pct"),                                   # $10
    ({"existing_market_exposure": D("145")}, "market_pct"),                       # 150 - 145 = $5
    ({"daily_budget_remaining": D("7")}, "daily_budget"),
    ({"dollar_ceiling": D("3")}, "dollar_ceiling"),
    ({"available_cash": D("4")}, "cash"),
])
def test_each_clamp_applies(over, binding):
    r = size(**over)
    assert r.binding_limit == binding
    cap = r.limits[binding]
    assert cap < r.limits["kelly"]
    assert r.quantity * (r.p + r.fee) <= cap
    assert r.stake_usd <= cap


def test_market_pct_counts_existing_position():
    assert size(existing_market_exposure=D("0")).binding_limit == "kelly"
    r = size(existing_market_exposure=D("150"))  # already at 15% of 1000
    assert r.limits["market_pct"] == 0 and r.quantity == 0


def test_dollar_ceiling_overrides_percentage():
    r = size(balance=D("100000"), q=D("0.95"), dollar_ceiling=D("2"))  # 8% would be $8000
    assert r.limits["order_pct"] == D("8000")
    assert r.binding_limit == "dollar_ceiling"
    assert r.quantity * r.p <= D("2") and r.quantity == D("4")  # floor(2 / 0.42)


def test_below_minimum_order_size_skips():
    r = size(dollar_ceiling=D("0.30"))  # 0.30 / 0.42 < 1 contract
    assert r.quantity == 0 and "below the minimum order size" in r.skip_reason
    r = size(dollar_ceiling=D("5"), quantity_minimum=D("20"))  # 11 contracts < 20 minimum
    assert r.quantity == 0 and "below the minimum order size" in r.skip_reason


def test_rounds_down_to_increment():
    r = size(dollar_ceiling=D("1"), quantity_increment=D("0.01"), quantity_minimum=D("0.01"))
    assert r.quantity == D("2.38")  # 1 / 0.42 = 2.38095...


def test_no_side_sizing_uses_its_own_price():
    r = size(outcome="no", p=D("0.30"), q=D("0.55"))
    assert r.q_adj == D("0.7") * D("0.55") + D("0.3") * D("0.30")
    assert r.kelly_fraction == r.edge / (1 - D("0.30"))


def test_bad_inputs_raise():
    for over in ({"p": D("0")}, {"p": D("1")}, {"q": D("1.2")}, {"quantity_increment": D("0")}):
        with pytest.raises(ValueError):
            size(**over)


# --------------------------------------------------------------- server-side sizing via propose_order


def test_propose_with_probability_sizes_and_logs(env):
    write_config(env.config_path, max_order_usd=1000, max_daily_spend_usd=1000)
    g = env.guard()  # equity $1000 (FakeMarket balances)
    r = g.propose(SYMBOL, "yes", "buy", None, "0.40", my_probability="0.60")
    assert r["ok"], r
    sz = r["preview"]["sizing"]
    assert sz["binding_limit"] == "kelly" and sz["quantity"] == "119" and r["preview"]["quantity"] == "119"
    for k in ("q", "q_adj", "p", "edge", "kelly_fraction", "stake_usd", "binding_limit"):
        assert sz[k] is not None
    prop = [e for e in env.audit() if e["event"] == "proposal"][-1]
    assert prop["sizing"]["kelly_fraction"] == "0.2000"


def test_server_ceiling_clamps_sizing(env):
    g = env.guard()  # shipped test config: max_order_usd 10
    r = g.propose(SYMBOL, "yes", "buy", None, "0.40", my_probability="0.95")
    assert r["ok"] and r["preview"]["sizing"]["binding_limit"] == "dollar_ceiling"
    assert D(r["preview"]["worst_case_cost_usd"]) <= 10


def test_sizing_no_trade_is_rejected_with_details(env):
    r = env.guard().propose(SYMBOL, "yes", "buy", None, "0.40", my_probability="0.45")
    assert not r["ok"] and r["reason"].startswith("no trade:") and "below min_edge" in r["reason"]
    assert r["sizing"]["edge"] is not None
    rej = [e for e in env.audit() if e["event"] == "rejection"][-1]
    assert rej["sizing"]["q_adj"] is not None


def test_confirm_does_not_resize_and_rechecks_caps(env):
    write_config(env.config_path, max_order_usd=1000, max_daily_spend_usd=1000)
    g = env.guard()
    r = g.propose(SYMBOL, "yes", "buy", None, "0.40", my_probability="0.60")
    assert r["preview"]["quantity"] == "119"
    write_config(env.config_path, max_order_usd=1000, max_daily_spend_usd=1000, max_order_pct_of_balance=0.04)
    c = g.confirm(r["confirmation_token"])
    # 119 x 0.40 = $47.60 > 4% of 1000 = $40 -> rejected rather than silently resized
    assert not c["ok"] and "max_order_pct_of_balance" in c["reason"]
    assert env.trader.placed == []


def test_quantity_is_upper_bound_with_probability(env):
    write_config(env.config_path, max_order_usd=1000, max_daily_spend_usd=1000)
    r = env.guard().propose(SYMBOL, "yes", "buy", "7", "0.40", my_probability="0.60")
    assert r["ok"] and r["preview"]["quantity"] == "7"


def test_probability_not_allowed_on_sells(env):
    r = env.guard().propose(SYMBOL, "yes", "sell", "1", "0.40", my_probability="0.6")
    assert not r["ok"] and "sizes buys only" in r["reason"]


@pytest.mark.parametrize("setup,qty,needle", [
    (lambda e: None, "250", "max_order_pct_of_balance"),  # 250 x 0.40 = $100 > 8% of 1000
    (lambda e: e.market.positions.update(positions=[
        {"symbol": "GEMI-FEDJAN26-UP", "outcome": "yes", "totalQuantity": "300", "avgPrice": "0.45",
         "marketValue": "140", "contractMetadata": {"eventTicker": EVENT}}]), "100", "max_market_pct"),
    (lambda e: e.market.balances[0].update(available="20"), "100", "available cash"),
])
def test_server_percentage_caps_apply_to_manual_quantity(env, setup, qty, needle):
    write_config(env.config_path, max_order_usd=1000, max_daily_spend_usd=1000)
    setup(env)
    r = env.guard().propose(SYMBOL, "yes", "buy", qty, "0.40")
    assert not r["ok"] and needle in r["reason"], r


def test_daily_pct_cap(env):
    write_config(env.config_path, max_order_usd=1000, max_daily_spend_usd=1000, max_daily_spend_pct=0.05)
    r = env.guard().propose(SYMBOL, "yes", "buy", "150", "0.40")  # $60 > 5% of 1000 = $50 (and < 8%)
    assert not r["ok"] and "daily cap" in r["reason"]


def test_paper_sizing_uses_paper_bankroll(env):
    g = env.guard(dry_run=True, bankroll="50")
    r = g.propose(SYMBOL, "yes", "buy", None, "0.40", my_probability="0.60")
    # paper equity $50: Kelly 50 * 0.2 * 0.25 = $2.50 ; 8% = $4 -> Kelly binds
    assert r["ok"] and r["preview"]["sizing"]["limits_usd"]["kelly"] == "2.50"
    assert g.risk_summary()["source"] == "paper"

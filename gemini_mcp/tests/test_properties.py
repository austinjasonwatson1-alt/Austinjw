"""Task 4: property-based tests (hypothesis) for sizing and the guardrails."""

import tempfile
from decimal import Decimal as D
from pathlib import Path

from hypothesis import HealthCheck, event, example, given, settings
from hypothesis import strategies as st

from conftest import EVENT, SYMBOL, Clock, FakeMarket, FakeTrader, make_contract, make_event, write_config
from guardrails import AuditLog, Guardrails, PaperLedger, RiskState, SpendLedger, size_position

FAST = settings(max_examples=300, deadline=None, suppress_health_check=[HealthCheck.too_slow])
SLOW = settings(max_examples=120, deadline=None, suppress_health_check=[HealthCheck.too_slow])


def dec(lo, hi, places=4):
    return st.decimals(min_value=D(lo), max_value=D(hi), places=places, allow_nan=False, allow_infinity=False)


# --------------------------------------------------------------- size_position


@FAST
@given(
    p=dec("0.01", "0.99", 2), q=dec("0", "1"), fee=dec("0", "0.1", 3), w=dec("0", "1", 2), min_edge=dec("0", "0.2", 3),
    kelly=dec("0", "1", 2), order_pct=dec("0", "1", 3), market_pct=dec("0", "1", 3), balance=dec("-1000", "1000000", 2),
    existing=dec("0", "100000", 2), daily=dec("-100", "10000", 2), ceiling=dec("0", "10000", 2),
    cash=st.one_of(st.none(), dec("-100", "100000", 2)), inc=st.sampled_from([D("1"), D("0.1"), D("0.01"), D("5")]),
    minimum=st.sampled_from([D("0"), D("1"), D("5"), D("0.5")]), cat_pct=st.one_of(st.none(), dec("0", "1", 3)),
    cat_existing=dec("0", "100000", 2), outcome=st.sampled_from(["yes", "no"]),
)
def test_size_position_never_exceeds_any_cap(p, q, fee, w, min_edge, kelly, order_pct, market_pct, balance, existing,
                                             daily, ceiling, cash, inc, minimum, cat_pct, cat_existing, outcome):
    r = size_position(outcome=outcome, balance=balance, p=p, q=q, fee=fee, estimate_weight=w, min_edge=min_edge,
                      kelly_multiplier=kelly, max_order_pct=order_pct, max_market_pct=market_pct,
                      existing_market_exposure=existing, daily_budget_remaining=daily, dollar_ceiling=ceiling,
                      available_cash=cash, quantity_increment=inc, quantity_minimum=minimum,
                      max_category_pct=cat_pct, existing_category_exposure=cat_existing)
    for v in (r.stake_usd, r.quantity):
        assert v.is_finite() and v >= 0
    assert r.stake_usd == r.quantity * p
    if r.quantity == 0:
        return
    assert r.skip_reason is None and r.edge >= min_edge
    assert r.quantity >= minimum and (r.quantity / inc) == (r.quantity / inc).to_integral_value()
    bal = max(balance, D(0))
    caps = [ceiling, max(daily, D(0)), bal * order_pct, max(bal * market_pct - existing, D(0)),
            bal * r.kelly_fraction * kelly]
    if cash is not None:
        caps.append(max(cash, D(0)))
    if cat_pct is not None:
        caps.append(max(bal * cat_pct - cat_existing, D(0)))
    for cap in caps:
        assert r.quantity * (p + fee) <= cap + D("1e-18"), (cap, r)


@FAST
@given(p=dec("0.01", "0.99", 2), q=dec("0", "1"), fee=dec("0", "0.1", 3))
def test_no_trade_below_min_edge(p, q, fee):
    r = size_position(outcome="yes", balance=D(1000), p=p, q=q, fee=fee, estimate_weight=D("0.7"),
                      min_edge=D("0.05"), kelly_multiplier=D("0.25"), max_order_pct=D("0.08"),
                      max_market_pct=D("0.15"), existing_market_exposure=D(0), daily_budget_remaining=D(25),
                      dollar_ceiling=D(10), available_cash=D(1000), quantity_increment=D(1), quantity_minimum=D(1))
    if r.edge < D("0.05"):
        assert r.quantity == 0 and r.stake_usd == 0


# --------------------------------------------------------------- the guardrails end to end (propose + confirm)

garbage = st.one_of(st.none(), st.booleans(), st.integers(-10**12, 10**12), st.text(max_size=12),
                    st.floats(allow_nan=True, allow_infinity=True), st.lists(st.integers(), max_size=2),
                    st.sampled_from(["nan", "inf", "-0", "1e400", "1e-400", "0x10", " 5 ", "5,0", "\u0661"]))
# Valid inputs (orders actually get placed, so the caps are exercised). Garbage gets its own test below.
qty_s = st.one_of(st.integers(1, 40).map(str), dec("0.5", "40", 1).map(str))
price_s = st.one_of(dec("0.01", "0.99", 2).map(str), dec("0.30", "0.70", 2).map(str))
prob_s = st.one_of(st.none(), dec("0.5", "1", 3).map(str))


def make_guard(tmp, *, live, cfg, balances, positions, orders, inc="1", minimum="1"):
    tmp = Path(tmp)
    market = FakeMarket()
    market.balances = balances
    market.positions = {"positions": positions}
    market.active = {"orders": orders}
    market.events[EVENT] = make_event(contracts=[make_contract(quantityIncrement=inc, quantityMinimum=minimum)],
                                      category="economics")
    write_config(tmp / "config.yaml", **cfg)
    trader = FakeTrader() if live else None
    clock = Clock()
    key = f"sandbox:{'live' if live else 'dry_run'}"
    g = Guardrails(config_path=tmp / "config.yaml", kill_path=tmp / "KILL",
                   ledger=SpendLedger(tmp / "state" / "daily_spend.json", key), audit=AuditLog(tmp / "a.log", clock=clock),
                   market=market, trader=trader, dry_run=not live, env="sandbox",
                   risk_state=RiskState(tmp / "state" / "risk_state.json", key),
                   paper=None if live else PaperLedger(tmp / "paper.json", D(1000), clock=clock), clock=clock)
    return g, market, trader


@settings(max_examples=250, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(
    live=st.booleans(), side=st.sampled_from(["buy", "buy", "sell"]), outcome=st.sampled_from(["yes", "no"]),
    qty=qty_s, price=price_s, prob=prob_s, cash=dec("50", "5000", 2), held=st.integers(0, 50),
    resting_buy=st.integers(0, 300), max_order=dec("0.5", "20", 2), daily=dec("1", "50", 2),
    open_max=st.integers(1, 5), trades_max=st.integers(1, 5), exits_max=st.integers(0, 3),
    order_pct=dec("0.005", "0.2", 3),
    market_pct=dec("0.01", "0.3", 3), daily_pct=dec("0.01", "0.6", 3), inc=st.sampled_from(["1", "5", "0.5"]),
    minimum=st.sampled_from(["1", "5"]), confirms=st.integers(1, 6),
)
@example(live=False, side="sell", outcome="no", qty="2", price="0.35", prob=None, cash=D("50"), held=2, resting_buy=0,
         max_order=D("0.5"), daily=D("1"), open_max=1, trades_max=2, exits_max=2, order_pct=D("0.005"),
         market_pct=D("0.01"),
         daily_pct=D("0.01"), inc="1", minimum="1", confirms=2)  # two unfilled paper sells: not an oversell
def test_guardrails_never_place_an_order_that_breaks_a_cap(live, side, outcome, qty, price, prob, cash, held,
                                                            resting_buy, max_order, daily, open_max, trades_max,
                                                            exits_max, order_pct, market_pct, daily_pct, inc, minimum,
                                                            confirms):
    cfg = {"max_order_usd": float(max_order), "max_daily_spend_usd": float(daily), "max_open_orders": open_max,
           "max_trades_per_day": trades_max, "max_exits_per_day": exits_max,
           "max_order_pct_of_balance": float(order_pct),
           "max_market_pct_of_balance": float(market_pct), "max_daily_spend_pct": float(daily_pct),
           "allowed_event_tickers": [EVENT], "max_drawdown_pct": 1, "max_daily_loss_pct": 1, "equity_floor_pct": 0,
           "paper_bankroll_usd": 1000}
    positions = [{"symbol": SYMBOL, "outcome": outcome, "totalQuantity": str(held), "quantityOnHold": "0",
                  "avgPrice": "0.5", "marketValue": str(D(held) * D("0.5")),
                  "contractMetadata": {"eventTicker": EVENT, "category": "economics"}}] if held else []
    orders = [{"orderId": 1, "symbol": SYMBOL, "side": "buy", "outcome": "yes", "remainingQuantity": str(resting_buy),
               "price": "0.5", "contractMetadata": {"eventTicker": EVENT, "category": "economics"}}] if resting_buy else []
    balances = [{"currency": "USD", "amount": str(cash), "available": str(cash)}]
    with tempfile.TemporaryDirectory() as tmp:
        g, market, trader = make_guard(tmp, live=live, cfg=cfg, balances=balances, positions=positions,
                                       orders=orders if live else [], inc=inc, minimum=minimum)
        if not live and held:  # paper holdings, so dry-run sells are exercised too
            g.paper.record_order(symbol=SYMBOL, outcome=outcome, side="buy", quantity=D(held), price=D("0.5"),
                                 fee=D(0), event_ticker=EVENT, filled=True)
        before = g.risk_summary()  # the guard's own view before trading: the caps are checked against it
        equity, cash_now = D(before["equity_usd"]), D(before["cash_usd"])
        exposure = D(before["event_exposure_usd"].get(EVENT, "0"))
        n_before = 0 if live else len(g.paper.snapshot()["orders"])
        tokens = []
        for _ in range(confirms):
            r = g.propose(SYMBOL, outcome, side, qty, price, prob if side == "buy" else None)
            assert isinstance(r, dict) and r["ok"] in (True, False)
            if r["ok"]:
                tokens.append(r["confirmation_token"])
        for t in tokens:
            assert isinstance(g.confirm(t), dict)
        paper_orders = [] if live else g.paper.snapshot()["orders"][n_before:]
        sent = trader.placed if live else [(o["symbol"], o["side"], o["outcome"], D(o["quantity"]), D(o["price"]))
                                           for o in paper_orders]
        event(f"placed {min(len(sent), 2)}{'+' if len(sent) > 2 else ''} ({'live' if live else 'dry'} {side})")
        spent = sum((q * p for _, s, _, q, p in sent if s == "buy"), D(0))
        # Unfilled paper orders don't rest and don't change holdings, so only filled paper sells count as sold.
        sold = (sum((q for _, s, _, q, _ in sent if s == "sell"), D(0)) if live else
                sum((D(o["quantity"]) for o in paper_orders if o["side"] == "sell" and o["filled"]), D(0)))
        assert sum(1 for x in sent if x[1] == "buy") <= trades_max  # buys: trade budget
        assert sum(1 for x in sent if x[1] == "sell") <= exits_max  # sells of held quantity: exit budget
        # max_open_orders needs an exchange whose open-order list grows as orders are placed: that's checked
        # against the stateful fake in test_stress_multiprocess.py.
        assert spent <= min(D(daily), daily_pct * equity) + D("1e-9")
        assert spent <= max(market_pct * equity - exposure, D(0)) + D("1e-9")
        if not live:  # the static live market never updates holdings; see test_two_sells_of_the_same_holding
            assert sold <= held
        if live:
            assert spent <= cash_now
        for sym, s, o, q, p in sent:
            assert q >= D(minimum) and (q / D(inc)) == (q / D(inc)).to_integral_value()
            assert D("0.01") <= p <= D("0.99") and (p * 100) == (p * 100).to_integral_value()
            if s == "buy":
                assert q * p <= D(max_order) and q * p <= order_pct * equity + D("1e-9")


@SLOW
@given(live=st.booleans(), side=st.one_of(st.sampled_from(["buy", "sell"]), garbage),
       outcome=st.one_of(st.sampled_from(["yes", "no"]), garbage), symbol=st.one_of(st.just(SYMBOL), garbage),
       qty=garbage, price=st.one_of(garbage, dec("0.01", "0.99", 2).map(str)), prob=garbage)
def test_garbage_inputs_are_clean_rejections(live, side, outcome, symbol, qty, price, prob):
    cfg = {"allowed_event_tickers": [EVENT], "paper_bankroll_usd": 1000}
    with tempfile.TemporaryDirectory() as tmp:
        g, market, trader = make_guard(tmp, live=live, cfg=cfg,
                                       balances=[{"currency": "USD", "amount": "1000", "available": "1000"}],
                                       positions=[], orders=[])
        r = g.propose(symbol, outcome, side, qty, price, prob)
        assert isinstance(r, dict)
        if r["ok"]:  # only possible when every field happens to be valid (e.g. qty=5 from the integer branch)
            assert isinstance(qty, (int, float, str)) and not isinstance(qty, bool)
        else:
            assert r["rejected"] and isinstance(r["reason"], str) and len(r["reason"]) < 600
        assert (trader.placed if live else g.paper.snapshot()["orders"]) == []

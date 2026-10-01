"""Paper vs live: every live order records what paper mode would have assumed at that moment (filled or not, at
what price, with what fee), and report.py --live compares that with the real fill from order history: a
slippage/fee gap table (N, average, worst) and a flag when live is consistently worse than paper assumed."""

from decimal import Decimal as D

import pytest

import report
from conftest import SYMBOL
from fake_gemini import FakeGemini, guard_for


def events(env, name):
    return [e for e in env.audit() if e["event"] == name]


def confirm(g, price, qty="4", side="buy"):
    r = g.propose(SYMBOL, "yes", side, qty, price)
    assert r["ok"], r
    return g.confirm(r["confirmation_token"])


# ------------------------------------------------------------------ recording the paper assumption


def test_live_order_records_the_paper_assumed_fill(env):
    g = env.guard()  # live; FakeMarket's YES buy price is 0.66
    assert confirm(g, "0.66")["ok"]
    for name in ("confirmation", "order_intent", "order_result"):
        pa = events(env, name)[-1]["paper_assumed"]
        assert pa == {"filled": True, "price": "0.66", "quantity": "4", "fee_per_contract": "0.02",
                      "reference_price": "0.66"}, name


def test_live_order_below_the_ask_is_assumed_unfilled(env):
    g = env.guard()
    confirm(g, "0.50")
    pa = events(env, "order_result")[-1]["paper_assumed"]
    assert pa["filled"] is False and pa["price"] is None and pa["quantity"] == "0" and pa["reference_price"] == "0.66"


def test_dry_run_records_the_same_assumption_it_used(env):
    g = env.guard(dry_run=True)
    r = confirm(g, "0.66")
    wp = events(env, "would_place")[-1]
    assert wp["paper_assumed"]["filled"] is True is r["paper_filled"] and wp["paper_filled"] is True


# ------------------------------------------------------------------ the comparison


def placed(oid, side="buy", filled=True, price="0.60", qty="4", fee="0.02"):
    return {"event": "order_result", "result": "placed", "order_id": oid, "ts": "2026-09-21T12:00:00+00:00",
            "instrument_symbol": SYMBOL, "side": side, "outcome": "yes", "quantity": qty, "limit_price": price,
            "paper_assumed": {"filled": filled, "price": price if filled else None,
                              "quantity": qty if filled else "0", "fee_per_contract": fee, "reference_price": price}}


def hist(oid, filled="4", avg="0.60", status="filled", **extra):
    return {oid: {"orderId": oid, "status": status, "filledQuantity": filled, "avgExecutionPrice": avg, **extra}}


def test_gap_signs_buy_and_sell():
    audit = [placed(1), placed(2, side="sell", price="0.70")]
    h = {**hist(1, avg="0.62"), **hist(2, avg="0.67")}
    g = report.fill_gaps(audit, h)
    rows = {r["order_id"]: r for r in g["orders"]}
    assert rows[1]["price_gap"] == "0.02"   # bought 2c dearer than assumed: worse
    assert rows[2]["price_gap"] == "0.03"   # sold 3c cheaper than assumed: worse
    assert rows[1]["fill_shortfall"] == "0" and rows[1]["gap_usd"] == "0.08"


def test_better_fills_are_negative():
    g = report.fill_gaps([placed(1)], hist(1, avg="0.58"))
    assert g["orders"][0]["price_gap"] == "-0.02" and g["flag"] is False


def test_shortfall_when_live_filled_less_than_paper_assumed():
    g = report.fill_gaps([placed(1)], hist(1, filled="1", status="cancelled"))
    r = g["orders"][0]
    assert r["fill_shortfall"] == "3" and D(r["price_gap"]) == 0
    g = report.fill_gaps([placed(1)], hist(1, filled="0", avg=None, status="cancelled"))
    assert g["orders"][0]["fill_shortfall"] == "4" and g["orders"][0]["price_gap"] is None


def test_fee_gap_only_when_history_reports_a_fee():
    g = report.fill_gaps([placed(1)], hist(1))
    assert g["orders"][0]["fee_gap"] is None and g["summary"]["fee_gap"]["n"] == 0
    g = report.fill_gaps([placed(1)], hist(1, fee="0.12"))  # $0.12 for 4 = 0.03 each vs 0.02 assumed
    assert g["orders"][0]["fee_gap"] == "0.01" and g["summary"]["fee_gap"]["n"] == 1


def test_orders_without_a_paper_assumption_or_history_are_counted_not_compared():
    old = placed(1)
    del old["paper_assumed"]
    g = report.fill_gaps([old, placed(2), placed(3, filled=False)], hist(3, filled="0", avg=None, status="cancelled"))
    assert g["no_assumption"] == 1 and g["not_in_history"] == 1
    assert [r["order_id"] for r in g["orders"]] == [3]


def test_unparseable_history_values_are_skipped_not_guessed():
    g = report.fill_gaps([placed(1)], hist(1, filled="lots", avg="NaN"))
    assert g["orders"] == [] and g["unreadable"] == 1


def test_summary_average_worst_and_n():
    audit = [placed(i) for i in range(1, 5)]
    h = {**hist(1, avg="0.61"), **hist(2, avg="0.63"), **hist(3, avg="0.60"), **hist(4, avg="0.58")}
    s = report.fill_gaps(audit, h)["summary"]["price_gap"]
    assert s == {"n": 4, "average": "0.0050", "worst": "0.03"}


@pytest.mark.parametrize("avgs,flag", [
    (["0.61", "0.61", "0.62", "0.61", "0.60"], True),    # 4 of 5 worse
    (["0.61", "0.59", "0.59", "0.59", "0.59"], False),   # 1 of 5 worse, average better
    (["0.65", "0.59", "0.59", "0.59", "0.59"], True),    # 1 of 5 worse, but the average is worse
    (["0.61", "0.61", "0.61", "0.61"], False),           # all worse, but N < 5: not enough to say
])
def test_flag(avgs, flag):
    audit = [placed(i) for i in range(1, len(avgs) + 1)]
    h = {}
    for i, a in enumerate(avgs, 1):
        h.update(hist(i, avg=a))
    g = report.fill_gaps(audit, h)
    assert g["flag"] is flag
    text = report.format_fill_gaps(g)
    assert ("LIVE FILLS CONSISTENTLY WORSE THAN PAPER ASSUMED" in text) is flag
    assert "price gap" in text and "average" in text and "worst" in text and f"N {len(avgs)}" in text


def test_shortfalls_count_as_worse_for_the_flag():
    audit = [placed(i) for i in range(1, 6)]
    h = {}
    for i in range(1, 6):
        h.update(hist(i, filled="2", status="cancelled"))
    assert report.fill_gaps(audit, h)["flag"] is True


def test_format_with_nothing_to_compare():
    text = report.format_fill_gaps(report.fill_gaps([], {}))
    assert "PAPER vs LIVE" in text and "no live orders" in text


def test_format_report_includes_the_gap_table_when_given():
    g = report.fill_gaps([placed(1)], hist(1, avg="0.62"))
    text = report.format_report([], {"by_kind": {}, "top_reasons": []}, None, [], gaps=g)
    assert "PAPER vs LIVE FILLS" in text and "0.02" in text


# ------------------------------------------------------------------ end to end through the fake exchange


def test_end_to_end_with_the_fake_exchange(tmp_path):
    fake = FakeGemini(state_path=tmp_path / "fake.json")
    market, guard = guard_for(tmp_path, fake, live=True)
    sym = "GEMI-FEDJAN26-DN25"
    ask = market.get_order_book(sym)["asks"][0][0]
    fake.set_fill_mode(sym, "fill")
    r = guard.propose(sym, "yes", "buy", "2", ask)
    assert r["ok"], r
    res = guard.confirm(r["confirmation_token"])
    assert res["ok"], res
    with fake.state() as st:  # Gemini filled it 1c worse than the limit paper assumed
        o = st["orders"][str(res["order_id"])]
        o["avgExecutionPrice"] = format(D(ask) + D("0.01"), "f")
    audit = report.read_audit(tmp_path / "audit.log")
    g = report.fill_gaps(audit, report.order_history(market))
    assert len(g["orders"]) == 1 and g["orders"][0]["price_gap"] == "0.01"
    assert g["orders"][0]["assumed_price"] == ask

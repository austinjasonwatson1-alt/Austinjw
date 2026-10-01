"""report.py research economics: research spend, spend per trade entered, average stated edge, expected net edge
per trade (edge x stake - fee - research cost per trade) and P&L after research costs, per mode. Flagged when
research costs more per trade than the expected edge is worth."""

from decimal import Decimal as D

import pytest

import report
from report import Lot


def cost(c, mode="dry_run"):
    return {"event": "research_cost", "mode": mode, "research_cost_usd": c}


def entry(q_adj="0.70", p="0.60", qty="10", edge="0.08", mode="dry_run"):
    return {"event": "decision", "kind": "entry", "mode": mode, "q_adj": q_adj, "p": p, "quantity": qty,
            "edge": edge}


FEE = D("0.02")


def econ(audit, pnl=None):
    return report.research_economics(audit, FEE, pnl or {})


def test_basic_numbers():
    audit = [cost("0.50"), cost("0.30"), cost("0.20"), entry(), entry(q_adj="0.80", p="0.60", qty="5", edge="0.16")]
    r = econ(audit, {"dry_run": D("3.00")})["dry_run"]
    assert r["research_spend_usd"] == "1.00" and r["research_calls"] == 3 and r["trades_entered"] == 2
    assert r["research_per_trade_usd"] == "0.50"
    assert r["avg_stated_edge"] == "0.1200"
    # edge x stake = (q_adj - p) x quantity: 0.10 x 10 = 1.00 and 0.20 x 5 = 1.00; fee 0.02 x qty: 0.20 and 0.10
    assert r["expected_edge_value_per_trade_usd"] == "1.00"
    assert r["fee_per_trade_usd"] == "0.15"
    assert r["expected_net_edge_per_trade_usd"] == "0.35"   # 1.00 - 0.15 - 0.50
    assert r["pnl_usd"] == "3.00" and r["pnl_after_research_usd"] == "2.00"
    assert r["flag"] is False


def test_flag_when_research_costs_more_than_the_edge_is_worth():
    audit = [cost("1.00"), cost("1.00"), entry(q_adj="0.65", p="0.60", qty="4")]  # edge value 0.20 - fee 0.08
    r = econ(audit)["dry_run"]
    assert r["research_per_trade_usd"] == "2.00" and r["flag"] is True
    assert "research costs more" in r["flag_reason"]
    text = report.format_research_economics(econ(audit))
    assert "RESEARCH COSTS MORE PER TRADE THAN THE EXPECTED EDGE" in text


def test_flag_when_research_was_spent_and_nothing_entered():
    r = econ([cost("0.40")])["dry_run"]
    assert r["trades_entered"] == 0 and r["research_per_trade_usd"] is None and r["flag"] is True


def test_modes_are_kept_apart():
    audit = [cost("0.50", "live"), entry(mode="live"), cost("0.10"), entry()]
    e = econ(audit, {"live": D("-1")})
    assert e["live"]["research_spend_usd"] == "0.50" and e["dry_run"]["research_spend_usd"] == "0.10"
    assert e["live"]["pnl_after_research_usd"] == "-1.50"
    assert e["dry_run"]["pnl_usd"] is None and e["dry_run"]["pnl_after_research_usd"] is None


def test_unreadable_costs_and_entries_are_counted_not_guessed():
    audit = [cost("NaN"), cost(None), cost("0.25"), entry(q_adj=None), entry()]
    r = econ(audit)["dry_run"]
    assert r["research_spend_usd"] == "0.25" and r["unreadable_costs"] == 2
    assert r["trades_entered"] == 2 and r["trades_with_edge_data"] == 1


def test_no_data():
    assert econ([]) == {}
    assert "no research or entries" in report.format_research_economics({})


def test_pnl_by_mode_from_lots():
    def lot(ref, cost_px, proceeds):
        return Lot(ref, "S", "yes", "E", D("1"), D(cost_px), D("0"), None, None, None, D("0"), D(proceeds))
    lots = [lot("p1", "0.40", "1"), lot("live:9", "0.50", "0"),
            Lot("p2", "S", "yes", "E", D("1"), D("0.4"), D("0"), None, None, None, D("1"))]  # open: excluded
    pnl = report.pnl_by_mode(lots)
    assert pnl == {"dry_run": D("0.60"), "live": D("-0.50")}


def test_format_report_includes_economics():
    e = econ([cost("0.50"), entry()], {"dry_run": D("1")})
    text = report.format_report([], {"by_kind": {}, "top_reasons": []}, None, [], economics=e)
    assert "RESEARCH ECONOMICS" in text and "P&L after research" in text

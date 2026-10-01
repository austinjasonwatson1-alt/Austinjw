"""Runner: exit conditions, entry choice, and full runs through the real MCP tool layer (fakes for Gemini)."""

import asyncio
from decimal import Decimal as D

import pytest

import server
from conftest import EVENT, SYMBOL, make_contract, make_event, write_config
from guardrails import Config, check_book
from research import Estimate, ResearchError
from runner import Runner, choose_entry, decide_exit, hours_until, make_confirm, outcome_prices

CFG = Config()  # defaults: w 0.7, fee 0.02, min_edge 0.05, exit 24h, clearly winning 0.85


def exit_(**over):
    args = dict(outcome="yes", q_yes_now=D("0.70"), buy_price=D("0.52"), sell_price=D("0.50"),
                entry_q_adj=D("0.62"), thesis_invalidated=False, invalidation_reason="",
                hours_to_expiry=D("200"), config=CFG)
    args.update(over)
    return decide_exit(**args)


# --------------------------------------------------------------- exit conditions


def test_hold_when_no_exit_condition():
    d = exit_()  # q_adj = 0.7*0.70 + 0.3*0.52 = 0.646 > sell 0.50; edge 0.106 > 0
    assert not d.sell and d.reasons == ["hold: no exit condition met"]


def test_exit_when_price_reaches_estimate():
    d = exit_(buy_price=D("0.66"), sell_price=D("0.66"), q_yes_now=D("0.66"))  # q_adj 0.66 <= sell 0.66
    assert d.sell and d.reasons[0].startswith("price_reached_estimate")


def test_exit_when_estimate_drops_and_edge_gone():
    d = exit_(q_yes_now=D("0.50"))  # q_adj 0.506 < entry 0.62; edge 0.506-0.52-0.02 < 0
    assert d.sell and any(r.startswith("edge_gone") for r in d.reasons)
    assert not any(r.startswith("price_reached") for r in d.reasons)  # sell 0.50 < 0.506


def test_estimate_drop_with_edge_left_holds():
    d = exit_(q_yes_now=D("0.62"))  # dropped (0.59 < 0.62) but edge 0.59-0.52-0.02 = 0.05 > 0
    assert not d.sell


def test_exit_when_thesis_invalidated():
    d = exit_(thesis_invalidated=True, invalidation_reason="Fed chair said no cut in January")
    assert d.sell and d.reasons == ["thesis_invalidated: Fed chair said no cut in January"]


def test_exit_near_expiry_when_not_clearly_winning():
    d = exit_(hours_to_expiry=D("10"))
    assert d.sell and d.reasons[0].startswith("near_expiry_not_winning")


def test_near_expiry_but_clearly_winning_holds():
    d = exit_(hours_to_expiry=D("10"), q_yes_now=D("0.97"), buy_price=D("0.92"), sell_price=D("0.90"))
    assert not d.sell


def test_near_expiry_boundary():
    assert exit_(hours_to_expiry=D("24")).sell
    assert not exit_(hours_to_expiry=D("24.1")).sell


def test_exit_conditions_for_no_side():
    # Holding NO: q_no = 1 - q_yes. q_yes 0.80 -> q_no 0.20, q_adj 0.2*0.7+0.3*0.30 = 0.23 <= sell 0.28
    d = exit_(outcome="no", q_yes_now=D("0.80"), buy_price=D("0.30"), sell_price=D("0.28"), entry_q_adj=D("0.45"))
    assert d.sell and d.reasons[0].startswith("price_reached_estimate")


def test_multiple_reasons_all_logged():
    d = exit_(q_yes_now=D("0.40"), thesis_invalidated=True, invalidation_reason="x", hours_to_expiry=D("1"))
    kinds = [r.split(":")[0] for r in d.reasons]
    # q_adj 0.436 <= sell 0.50 as well, so all four fire
    assert kinds == ["price_reached_estimate", "edge_gone", "thesis_invalidated", "near_expiry_not_winning"]


def test_no_bid_holds():
    d = exit_(sell_price=None, thesis_invalidated=True)
    assert not d.sell and "no bid" in d.reasons[0]


def test_unknown_entry_uses_current_edge_only():
    assert exit_(entry_q_adj=None, q_yes_now=D("0.50")).sell


# --------------------------------------------------------------- entry choice and helpers


def test_choose_entry_picks_better_side():
    bc = check_book({"bids": [["0.60", "100"]], "asks": [["0.62", "100"]]}, "yes", max_spread=D("0.04"))
    yes = choose_entry(D("0.85"), bc, CFG)
    assert yes.outcome == "yes" and yes.p == D("0.62")
    no = choose_entry(D("0.30"), bc, CFG)  # q_no 0.70 vs NO price 0.40
    assert no.outcome == "no" and no.p == D("0.40") and no.q == D("0.70")
    none = choose_entry(D("0.62"), bc, CFG)
    assert none.outcome is None and "below min_edge" in none.reason and set(none.sides) == {"yes", "no"}


def test_outcome_prices():
    book = {"bids": [["0.60", "1"]], "asks": [["0.62", "1"]]}
    assert outcome_prices(book, "yes") == (D("0.62"), D("0.60"))
    assert outcome_prices(book, "no") == (D("0.40"), D("0.38"))
    assert outcome_prices({"bids": [], "asks": [["0.62", "1"]]}, "yes") == (D("0.62"), None)


def test_hours_until():
    assert hours_until("1970-01-02T00:00:00Z", 0) == D("24")
    assert hours_until(None, 0) is None and hours_until("garbage", 0) is None


def test_confirm_policy():
    assert make_confirm(True, False, CFG, interactive=False)({})
    assert not make_confirm(False, True, CFG, interactive=False)({})  # config doesn't allow auto
    import dataclasses
    auto = dataclasses.replace(CFG, runner_auto_confirm_live=True)
    assert make_confirm(False, True, auto, interactive=False)({})
    assert not make_confirm(False, False, auto, interactive=False)({})  # flag missing
    assert make_confirm(False, False, CFG, interactive=True, ask=lambda _: "yes")({})
    assert not make_confirm(False, False, CFG, interactive=True, ask=lambda _: "y")({})


# --------------------------------------------------------------- full runs through MCP tools


class InProcessTools:
    def __init__(self, mcp):
        self.mcp = mcp
        self.calls = []

    async def call(self, name, **args):
        self.calls.append(name)
        _, structured = await self.mcp.call_tool(name, {k: v for k, v in args.items() if v is not None})
        return structured.get("result", structured)


def estimate(q_yes, n_sources=3, invalidated=False, reason=""):
    return Estimate(D(q_yes), "Fed signals a cut; futures agree. Data supports it.", "Resolves YES on a 25bp cut.",
                    ["Fed chair rules out a cut"], ["CPI cooled"], invalidated, reason,
                    [{"url": f"https://example.gov/{i}"} for i in range(n_sources)], "claude-opus-5-5", 2, {})


def run(env, *, dry_run=True, q_yes="0.85", research=None, confirm=None, **cfg):
    write_config(env.config_path, **{"max_order_usd": 10, "max_daily_spend_usd": 25, **cfg})
    guard = env.guard(dry_run=dry_run)
    tools = InProcessTools(server.create_server(env.market, guard))
    calls = []

    def default_research(info, prior):
        calls.append((info, prior))
        return estimate(q_yes)

    r = Runner(tools=tools, research=research or default_research, config=__import__("guardrails").load_config(
        env.config_path), audit=guard.audit, paper=env.paper(), dry_run=dry_run,
        confirm=confirm or make_confirm(dry_run, False, Config(), interactive=False),
        now=env.clock, out=lambda s: None)
    decisions = asyncio.run(r.run())
    return decisions, tools, calls, guard


def by_kind(decisions, kind):
    return [d for d in decisions if d["kind"] == kind]


def tight_market(env):
    # REST prices consistent with the book so a paper buy at the ask fills.
    env.market.events[EVENT] = make_event(contracts=[make_contract(prices={
        "buy": {"yes": "0.62", "no": "0.40"}, "sell": {"yes": "0.60", "no": "0.38"},
        "bestBid": "0.60", "bestAsk": "0.62"}, expiryDate="2027-01-31T00:00:00Z")])
    env.market.book = {"bids": [["0.60", "500"]], "asks": [["0.62", "500"]]}


def test_dry_run_entry_end_to_end(env):
    tight_market(env)
    decisions, tools, calls, guard = run(env)
    entry = by_kind(decisions, "entry")
    assert len(entry) == 1, decisions
    e = entry[0]
    for k in ("q", "q_adj", "p", "edge", "kelly_fraction", "stake_usd", "binding_limit", "thesis", "sources"):
        assert e.get(k) is not None, k
    assert e["outcome"] == "yes" and e["p"] == "0.62" and e["paper_filled"] is True
    # Research stored with the trade in paper_ledger.json; position created by the server.
    snap = env.paper().snapshot()
    rec = snap["research"][e["order_ref"]]
    assert rec["thesis"].startswith("Fed signals") and len(rec["sources"]) == 3 and rec["q_adj"] == e["q_adj"]
    assert list(snap["positions"]) == [f"{SYMBOL}|yes"]
    # The prompt saw the resolution rules, and no prior.
    assert calls[0][1] is None and calls[0][0]["instrument_symbol"] == SYMBOL
    # Every decision is in audit.log.
    assert [d["kind"] for d in env.audit() if d["event"] == "decision"] == [d["kind"] for d in decisions]
    assert set(tools.calls) <= {"get_balances", "get_positions", "get_market", "get_order_book",
                                "propose_order", "confirm_order"}


def test_wide_spread_skips_before_research(env):
    env.market.events[EVENT] = make_event(contracts=[make_contract(expiryDate="2027-01-31T00:00:00Z")])
    env.market.book = {"bids": [["0.02", "157"]], "asks": [["0.99", "100"]]}
    decisions, tools, calls, _ = run(env)
    nt = by_kind(decisions, "no_trade")
    assert nt and "wide spread" in nt[0]["reason"] and calls == []
    assert "propose_order" not in tools.calls


def test_thin_book_skips_and_does_not_confirm(env):
    tight_market(env)
    env.market.book = {"bids": [["0.60", "500"]], "asks": [["0.62", "3"]]}  # 3 contracts at our price
    decisions, tools, _, _ = run(env)
    nt = by_kind(decisions, "no_trade")
    assert nt and "thin book" in nt[0]["reason"] and nt[0]["sizing"]["quantity"] not in (None, "0")
    assert "confirm_order" not in tools.calls
    assert env.paper().snapshot()["orders"] == []


def test_small_edge_is_no_trade_with_both_sides_logged(env):
    tight_market(env)
    decisions, tools, _, _ = run(env, q_yes="0.63")
    nt = by_kind(decisions, "no_trade")[0]
    assert "below min_edge" in nt["reason"] and set(nt["sides"]) == {"yes", "no"}
    assert "propose_order" not in tools.calls


def test_too_few_sources_is_no_trade(env):
    tight_market(env)
    decisions, *_ = run(env, research=lambda i, p: estimate("0.9", n_sources=1))
    assert "sources" in by_kind(decisions, "no_trade")[0]["reason"]


def test_research_failure_is_logged_no_trade(env):
    tight_market(env)

    def boom(info, prior):
        raise ResearchError("the model declined to research this contract")

    decisions, *_ = run(env, research=boom)
    assert "research failed" in by_kind(decisions, "no_trade")[0]["reason"]


def test_review_exits_when_thesis_invalidated(env):
    tight_market(env)
    run(env)  # enter
    assert env.paper().held(SYMBOL, "yes") > 0
    seen = []

    def review(info, prior):
        seen.append(prior)
        return estimate("0.85", invalidated=True, reason="Fed chair ruled out a January cut")

    decisions, *_ = run(env, research=review)
    ex = by_kind(decisions, "exit")
    assert len(ex) == 1 and "thesis_invalidated" in ex[0]["reasons"][0]
    assert seen[0]["thesis"].startswith("Fed signals")  # prior thesis passed to research
    assert env.paper().held(SYMBOL, "yes") == 0  # paper sell at the bid filled
    assert env.paper().snapshot()["research"][ex[0]["order_ref"]]["kind"] == "exit"
    skip = by_kind(decisions, "skip")  # no churn: an exited contract isn't re-entered in the same run
    assert len(skip) == 1 and "not re-entered" in skip[0]["reason"]
    assert by_kind(decisions, "entry") == []


def test_review_holds_and_logs_reasoning(env):
    tight_market(env)
    run(env)
    decisions, *_ = run(env)  # same estimate: still edge, not near expiry
    hold = by_kind(decisions, "hold")
    assert len(hold) == 1 and hold[0]["reasons"] == ["hold: no exit condition met"] and hold[0]["thesis"]
    assert by_kind(decisions, "skip")  # entry scan skips the held contract


def test_live_without_confirmation_proposes_only(env):
    tight_market(env)
    decisions, tools, _, _ = run(env, dry_run=False)
    assert by_kind(decisions, "proposed_not_confirmed") and "confirm_order" not in tools.calls
    assert env.trader.placed == []


def test_live_with_confirmation_places(env):
    tight_market(env)
    decisions, tools, _, _ = run(env, dry_run=False, confirm=lambda preview: True)
    e = by_kind(decisions, "entry")[0]
    assert env.trader.placed and e["order_ref"] == "live:1001"


def test_kill_switch_stops_runner_orders(env):
    tight_market(env)
    env.kill_path.write_text("")
    decisions, tools, _, _ = run(env)
    nt = by_kind(decisions, "no_trade")
    assert nt and "kill switch" in nt[0]["reason"] and "confirm_order" not in tools.calls


def test_research_budget(env):
    tight_market(env)
    decisions, _, calls, _ = run(env, max_research_per_run=0)
    assert calls == [] and "budget" in by_kind(decisions, "no_trade")[0]["reason"]

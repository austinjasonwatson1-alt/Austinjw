"""Equity floor + KILL deletion log, per-category caps, positions in KILL, model provenance, Brier report."""

import asyncio
import json
from decimal import Decimal as D
from types import SimpleNamespace as NS

import pytest

from conftest import EVENT, SYMBOL, make_contract, make_event, write_config
from guardrails import ConfigError, evaluate_breakers, load_config, size_position
from report import MIN_N, Fill, brier, build_lots, estimate_brier, format_report, summarize


def events_of(env, name):
    return [e for e in env.audit() if e["event"] == name]


def set_equity(env, amount):
    env.market.balances[0]["amount"] = env.market.balances[0]["available"] = str(amount)


def propose(g, qty="1", price="0.40", side="buy"):
    return g.propose(SYMBOL, "yes", side, qty, price)


# =============================================================== 1. absolute equity floor


def test_evaluate_breakers_floor_first():
    r = evaluate_breakers(D("590"), D("1000"), D("1000"), D("0.2"), D("0.08"), floor=D("600"))
    assert r.startswith("equity floor")
    assert evaluate_breakers(D("600"), D("600"), D("600"), D("0.2"), D("0.08"), floor=D("600")) is None


def test_floor_trips_and_deleting_kill_does_not_reset_it(env):
    write_config(env.config_path, initial_deposit_usd=1000)
    g = env.guard()
    assert propose(g)["ok"]                     # day 1 at $1000
    env.clock.t += 86400
    set_equity(env, 590)                        # next day: daily loss 0%, but < 60% of $1000
    r = propose(g)
    assert not r["ok"] and "equity floor" in r["reason"] and env.kill_path.exists()
    kill = json.loads(env.kill_path.read_text())
    assert kill["floor"] == "600.00" and kill["floor_basis_source"] == "initial_deposit_usd"

    env.kill_path.unlink()                      # manual delete: drawdown peak re-baselines to 590...
    r = propose(g)
    assert not r["ok"] and "equity floor" in r["reason"] and env.kill_path.exists()  # ...floor doesn't
    assert json.loads(env.kill_path.read_text())["floor"] == "600.00"
    assert events_of(env, "breaker_reset")[0]["equity"] == "590"
    assert len(events_of(env, "circuit_breaker_trip")) == 2

    env.kill_path.unlink()
    set_equity(env, 650)                        # back above the floor
    assert propose(g)["ok"]


def test_floor_defaults_to_first_observed_equity_live(env):
    write_config(env.config_path, max_drawdown_pct=1, max_daily_loss_pct=1)
    g = env.guard()
    assert propose(g)["ok"]                     # first equity seen: $1000
    set_equity(env, 590)
    r = propose(g)
    assert not r["ok"] and "equity floor" in r["reason"]
    assert json.loads(env.kill_path.read_text())["floor_basis_source"] == "first_observed_equity"


def test_floor_basis_never_moves_after_a_deposit(env):
    write_config(env.config_path, max_drawdown_pct=1, max_daily_loss_pct=1)
    g = env.guard()
    propose(g)                                  # basis $1000
    set_equity(env, 5000)
    propose(g)
    assert g.risk_summary()["equity_floor_usd"] == "600.00"


def test_paper_floor_uses_bankroll(env):
    write_config(env.config_path, max_order_usd=100, max_daily_spend_usd=100, max_daily_spend_pct=1,
                 max_order_pct_of_balance=1, max_market_pct_of_balance=1, max_drawdown_pct=1, max_daily_loss_pct=1)
    g = env.guard(dry_run=True)
    t = propose(g, qty="60", price="0.66")["confirmation_token"]
    assert g.confirm(t)["paper_filled"]         # cash 100 - 60 x 0.68 = 59.20
    env.market.events[EVENT]["contracts"][0]["prices"]["sell"]["yes"] = "0.01"
    r = propose(g)
    assert not r["ok"] and "equity floor" in r["reason"]
    assert json.loads(env.kill_path.read_text())["floor_basis_source"] == "paper_bankroll"


def test_floor_disabled_with_zero(env):
    write_config(env.config_path, equity_floor_pct=0, max_drawdown_pct=1, max_daily_loss_pct=1)
    g = env.guard()
    propose(g)
    set_equity(env, 100)
    assert propose(g)["ok"]


def test_every_manual_kill_deletion_is_logged(env):
    g = env.guard()
    env.kill_path.write_text("stop, going on holiday")
    assert "kill switch" in propose(g)["reason"]
    det = events_of(env, "kill_detected")
    assert len(det) == 1 and det[0]["kill"]["created_by"] == "manual"
    env.kill_path.unlink()
    assert propose(g)["ok"]
    dele = events_of(env, "kill_deleted")
    assert len(dele) == 1 and dele[0]["kill"]["content"] == "stop, going on holiday" and dele[0]["present_since"]
    # A second create/delete cycle logs again; quiet checks in between don't.
    env.kill_path.write_text("")
    g.cancel(5)
    g.cancel(6)
    env.kill_path.unlink()
    g.risk_summary()
    assert len(events_of(env, "kill_detected")) == 2 and len(events_of(env, "kill_deleted")) == 2


def test_deleting_breaker_kill_is_logged_with_its_reason(env):
    g = env.guard()
    propose(g)
    set_equity(env, 900)                        # daily loss trip
    propose(g)
    propose(g)                                  # notices the breaker's KILL
    env.kill_path.unlink()
    env.clock.t += 86400
    propose(g)
    dele = events_of(env, "kill_deleted")
    assert dele and dele[0]["kill"]["created_by"] == "circuit_breaker" and "daily loss" in dele[0]["kill"]["reason"]


# =============================================================== 5. KILL lists positions


def test_kill_file_lists_positions_and_flags_missing_quotes(env):
    env.market.positions = {"positions": [
        {"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "10", "avgPrice": "0.5", "marketValue": "4",
         "contractMetadata": {"eventTicker": EVENT, "category": "Economics"}},
        {"symbol": "GEMI-OTHER-X", "outcome": "no", "totalQuantity": "20", "quantityOnHold": "5", "avgPrice": "0.3",
         "contractMetadata": {"eventTicker": "OTHER", "category": "sports"}},  # no marketValue = no quote
    ]}
    g = env.guard()
    propose(g)
    set_equity(env, 500)
    assert not propose(g)["ok"]
    kill = json.loads(env.kill_path.read_text())
    pos = {p["symbol"]: p for p in kill["open_positions"]}
    assert pos[SYMBOL]["quote"] == "ok" and pos[SYMBOL]["value"] == "4" and pos[SYMBOL]["category"] == "economics"
    assert pos["GEMI-OTHER-X"]["quote"].startswith("NO LIVE QUOTE") and pos["GEMI-OTHER-X"]["available"] == "15"
    assert kill["positions_without_quote"] == ["GEMI-OTHER-X|no"]
    assert events_of(env, "circuit_breaker_trip")[0]["positions_without_quote"] == ["GEMI-OTHER-X|no"]


def test_kill_file_with_no_positions(env):
    g = env.guard()
    propose(g)
    set_equity(env, 500)
    propose(g)
    kill = json.loads(env.kill_path.read_text())
    assert kill["open_positions"] == [] and kill["positions_without_quote"] == []


# =============================================================== 4. per-category caps


def test_category_caps_config():
    assert load_config.__name__  # imported
    from pathlib import Path
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "c.yaml"
        p.write_text("category_exposure_caps: {default: 0.3, Sports: 0.2}\n")
        assert load_config(p).category_exposure_caps == {"default": D("0.3"), "sports": D("0.2")}
        p.write_text("{}\n")
        assert load_config(p).category_exposure_caps == {}
        for bad in ("category_exposure_caps: [0.2]\n", "category_exposure_caps: {sports: 1.5}\n",
                    "category_exposure_caps: {'a/b': 0.1}\n", "initial_deposit_usd: -5\n"):
            p.write_text(bad)
            with pytest.raises(ConfigError):
                load_config(p)


def test_sizing_category_clamp():
    r = size_position(outcome="yes", balance=D("1000"), p=D("0.40"), q=D("0.60"), fee=D("0.02"),
                      estimate_weight=D("0.7"), min_edge=D("0.05"), kelly_multiplier=D("0.25"),
                      max_order_pct=D("0.08"), max_market_pct=D("0.15"), existing_market_exposure=D("0"),
                      daily_budget_remaining=D("1000"), dollar_ceiling=D("1000"), available_cash=D("1000"),
                      quantity_increment=D("1"), quantity_minimum=D("1"),
                      max_category_pct=D("0.20"), existing_category_exposure=D("190"))
    assert r.binding_limit == "category_pct" and r.limits["category_pct"] == D("10")
    assert r.quantity * (r.p + r.fee) <= 10


def sports_market(env):
    env.market.events[EVENT] = make_event(category="Sports")
    env.market.positions = {"positions": [
        {"symbol": "GEMI-NBA-X", "outcome": "yes", "totalQuantity": "300", "avgPrice": "0.6", "marketValue": "170",
         "contractMetadata": {"eventTicker": "NBA1", "category": "sports"}}]}  # $180 sports exposure


def test_server_category_cap_rejects_and_clamps(env):
    sports_market(env)
    write_config(env.config_path, max_order_usd=1000, max_daily_spend_usd=1000,
                 category_exposure_caps={"sports": 0.20})  # equity 1000 + 170 -> cap $234, $54 headroom
    g = env.guard()
    r = propose(g, qty="150")                               # $60
    assert not r["ok"] and "category 'sports'" in r["reason"]
    r = g.propose(SYMBOL, "yes", "buy", None, "0.40", my_probability="0.60")
    assert r["ok"] and r["preview"]["sizing"]["binding_limit"] == "category_pct"
    assert r["preview"]["sizing"]["limits_usd"]["category_pct"] == "54.00"
    assert D(r["preview"]["worst_case_cost_usd"]) <= 54


def test_category_default_cap_and_off_by_default(env):
    sports_market(env)
    write_config(env.config_path, max_order_usd=1000, max_daily_spend_usd=1000)
    assert propose(env.guard(), qty="150")["ok"]           # no caps configured
    write_config(env.config_path, max_order_usd=1000, max_daily_spend_usd=1000,
                 category_exposure_caps={"default": 0.20, "economics": 0.9})
    r = propose(env.guard(), qty="150")
    assert not r["ok"] and "category 'sports'" in r["reason"]
    s = env.guard().risk_summary()
    assert s["category_exposure_usd"]["sports"] == "180.00" and s["category_caps"]["default"] == "0.2"


def test_paper_category_exposure(env):
    env.market.events[EVENT] = make_event(category="Sports")
    write_config(env.config_path, category_exposure_caps={"sports": 0.10})  # paper $100 -> $10
    g = env.guard(dry_run=True)
    assert g.confirm(propose(g, qty="12", price="0.66")["confirmation_token"])["paper_filled"]  # ~$8.16 basis
    r = propose(g, qty="5", price="0.40")                   # +$2 > $10 cap
    assert not r["ok"] and "category 'sports'" in r["reason"]


# =============================================================== 3. model provenance


def test_research_records_models_and_fallback():
    from research import research_contract

    submit = {"resolution_rules_summary": "r", "probability_yes": 0.6, "thesis": "t", "invalidation_conditions": [],
              "key_facts": [], "thesis_invalidated": False, "invalidation_reason": ""}
    responses = [
        NS(stop_reason="pause_turn", content=[], model="claude-opus-5-5", usage=NS(input_tokens=1, output_tokens=1)),
        NS(stop_reason="tool_use", model="claude-opus-4-8",
           content=[NS(type="fallback"), NS(type="tool_use", name="submit_estimate", input=submit)],
           usage=NS(input_tokens=1, output_tokens=1, iterations=[NS(type="fallback_message")])),
    ]
    client = NS(beta=NS(messages=NS(create=lambda **kw: responses.pop(0))))
    est = research_contract(client, model="claude-opus-5-5", contract={}, prior=None, now_iso="x")
    assert est.model == "claude-opus-4-8" and est.model_requested == "claude-opus-5-5"
    assert est.models_used == ["claude-opus-5-5", "claude-opus-4-8"] and est.fallback_used is True
    log = est.as_log()
    assert log["model"] == "claude-opus-4-8" and log["models_used"] == ["claude-opus-5-5", "claude-opus-4-8"]


def test_runner_logs_model_in_audit_and_ledger(env):
    from test_runner import estimate, run, tight_market

    tight_market(env)
    decisions, *_ = run(env)
    entry = [d for d in decisions if d["kind"] == "entry"][0]
    audit_entry = [e for e in env.audit() if e["event"] == "decision" and e.get("kind") == "entry"][0]
    ledger_rec = env.paper().snapshot()["research"][entry["order_ref"]]
    for rec in (audit_entry, ledger_rec):
        assert rec["research_model"] == "claude-opus-5-5"
        assert rec["research_model_requested"] == "claude-opus-5-5"
        assert rec["research_models_used"] == ["claude-opus-5-5"] and rec["research_fallback_used"] is False
    # no-trade and hold decisions carry it too
    tight_market(env)
    decisions, *_ = run(env)
    hold = [d for d in decisions if d["kind"] == "hold"][0]
    assert hold["research_model"] == "claude-opus-5-5"


# =============================================================== 2. Brier scores in the report


def test_brier_math():
    assert brier([(D("1"), True), (D("0"), False)]) == 0
    assert brier([(D("0.7"), True), (D("0.4"), False)]) == (D("0.09") + D("0.16")) / 2
    assert brier([]) is None


def lot_fill(i, edge, q, won, mid="0.50", price="0.52"):
    ref = f"r{i}"
    research = {ref: {"edge": edge, "q": q, "q_adj": q, "book": {"best_bid": str(D(mid) - D("0.01")),
                                                                  "best_ask": str(D(mid) + D("0.01"))}}}
    return Fill(ref, str(i), f"S{i}", "yes", "buy", D("1"), D(price), D("0.02"), "EV"), research, ("yes" if won else "no")


def test_brier_per_bucket_vs_market_and_low_n_flag():
    fills, research, res = [], {}, {}
    # 5-10% bucket: 30 contracts, q 0.70 vs market 0.50, 21 wins -> enough N
    for i in range(30):
        f, r, side = lot_fill(i, "0.06", "0.70", won=i < 21)
        fills.append(f); research.update(r); res[f.symbol] = side
    # 20%+ bucket: 4 contracts -> flagged
    for i in range(30, 34):
        f, r, side = lot_fill(i, "0.25", "0.90", won=i < 31)
        fills.append(f); research.update(r); res[f.symbol] = side
    lots = build_lots(fills, research, lambda ev, sym: res.get(sym))
    rows = {r["bucket"]: r for r in summarize(lots)}
    a = rows["5-10%"]
    assert a["n_scored"] == 30 and a["low_n"] is False
    exp_me = (21 * (D("0.3") ** 2) + 9 * (D("0.7") ** 2)) / 30           # 0.237
    exp_mkt = D("0.25")                                                    # mid 0.50 every time
    assert a["brier_mine"] == format(exp_me.quantize(D("0.0001")), "f")
    assert a["brier_market"] == "0.2500"
    assert D(a["brier_skill"]) == (1 - exp_me / exp_mkt).quantize(D("0.0001"))
    b = rows["20%+"]
    assert b["n_scored"] == 4 and b["low_n"] is True
    text = format_report(summarize(lots), {"by_kind": {}, "top_reasons": []})
    assert f"N<{MIN_N}" in [line for line in text.splitlines() if line.strip().startswith("20%+")][0]
    assert f"N<{MIN_N}" not in [line for line in text.splitlines() if line.strip().startswith("5-10%")][0]


def test_brier_scores_sold_positions_on_resolution():
    fills = [Fill("a", "1", "S1", "yes", "buy", D("2"), D("0.50"), D("0.02"), "EV"),
             Fill("x", "2", "S1", "yes", "sell", D("2"), D("0.60"), D("0.02"), "EV")]
    research = {"a": {"edge": "0.06", "q": "0.70", "q_adj": "0.64", "book": {"best_bid": "0.48", "best_ask": "0.50"}}}
    lot = build_lots(fills, research, lambda ev, sym: "no")[0]
    assert lot.closed and lot.settled_win is None and lot.resolved_win is False  # sold, but still scored
    assert lot.market_q == D("0.49")
    row = summarize([lot])[0]
    assert row["n_scored"] == 1 and row["brier_mine"] == "0.4900" and row["brier_market"] == "0.2401"


def test_no_side_market_probability_is_complement():
    fills = [Fill("a", "1", "S1", "no", "buy", D("1"), D("0.40"), D("0.02"), "EV")]
    research = {"a": {"edge": "0.08", "q": "0.55", "q_adj": "0.50", "book": {"best_bid": "0.58", "best_ask": "0.62"}}}
    lot = build_lots(fills, research, lambda ev, sym: None)[0]
    assert lot.market_q == D("0.40") and lot.resolved_win is None


def test_all_estimates_brier_dedupes_per_contract_per_day():
    def dec(ts, sym, est, bb, ba, **kw):
        return {"event": "decision", "ts": ts, "kind": "no_trade", "instrument_symbol": sym, "event_ticker": "EV",
                "estimate": est, "book": {"best_bid": bb, "best_ask": ba}, "research_model": "claude-opus-5-5", **kw}

    entries = [
        dec("2026-10-01T01:00:00", "A", "0.20", "0.49", "0.51"),   # superseded same day
        dec("2026-10-01T09:00:00", "A", "0.80", "0.49", "0.51"),
        dec("2026-10-02T09:00:00", "A", "0.90", "0.59", "0.61"),   # new day -> new sample
        dec("2026-10-01T09:00:00", "B", "0.30", "0.39", "0.41"),
        {"event": "decision", "ts": "2026-10-01T10:00:00", "kind": "hold", "instrument_symbol": "C",
         "event_ticker": "EV", "estimate": "0.70", "outcome": "no", "buy_price": "0.32", "sell_price": "0.28",
         "research_model": "claude-opus-4-8"},                     # held NO: YES mid = 1 - 0.30 = 0.70
        dec("2026-10-01T09:00:00", "D", "0.50", "0.49", "0.51"),   # unresolved -> not scored
    ]
    out = estimate_brier(entries, lambda ev, sym: {"A": "yes", "B": "no", "C": "yes"}.get(sym))
    assert out["n_estimates"] == 5 and out["n_scored"] == 4 and out["low_n"] is True
    me = ((D("0.2") ** 2) + (D("0.1") ** 2) + (D("0.3") ** 2) + (D("0.3") ** 2)) / 4
    mkt = ((D("0.5") ** 2) + (D("0.4") ** 2) + (D("0.4") ** 2) + (D("0.3") ** 2)) / 4
    assert out["brier_mine"] == format(me.quantize(D("0.0001")), "f")
    assert out["brier_market"] == format(mkt.quantize(D("0.0001")), "f")
    assert out["estimates_by_model"] == {"claude-opus-5-5": 5, "claude-opus-4-8": 1}

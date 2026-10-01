"""Task 1: the runner evaluates the floor, drawdown and daily-loss breakers at the start of every run, before any
research or proposal, and a trip creates KILL. A check that can't be completed stops the run too (fail closed)."""

import json

import yaml

from fake_gemini import FakeGemini
from test_e2e_fake import ORDER, World, estimate, kinds


def counting_research(calls):
    def research(info, prior):
        calls.append(info["instrument_symbol"])
        return estimate(0.85)
    return research


def tool_names(w):
    return [name for name, _ in w.tools.calls]


def test_drawdown_with_nothing_to_propose_still_trips_at_run_start(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True)
    w.run()  # entries rest; next run would propose nothing (all skipped), so no proposal would ever trip it
    n_orders = len(w.posts(ORDER))
    fake.set_cash("650")  # >20% below peak
    calls, before = [], len(w.tools.calls)
    d = w.run(research=counting_research(calls))
    assert (tmp_path / "KILL").exists()
    kill = json.loads((tmp_path / "KILL").read_text())
    assert kill["created_by"] == "circuit_breaker" and "drawdown" in kill["reason"]
    assert calls == [] and len(w.posts(ORDER)) == n_orders
    assert tool_names(w)[before:] == ["get_balances", "check_circuit_breakers"]  # nothing after the check
    stop = kinds(d, "run_stopped")
    assert stop and "circuit breaker" in stop[0]["reason"]
    assert [x["kind"] for x in d][-1] == "run_end"
    assert any(e["event"] == "circuit_breaker_trip" for e in w.audit())


def test_floor_breach_on_the_first_run_trips_before_research(tmp_path):
    fake = FakeGemini(cash="550")
    w = World(tmp_path, fake, live=True, config={"starting_balance_usd": 1000, "equity_floor_pct": 0.6})
    calls = []
    d = w.run(research=counting_research(calls))
    assert (tmp_path / "KILL").exists() and calls == [] and w.posts(ORDER) == []
    assert "floor" in kinds(d, "run_stopped")[0]["reason"]


def test_daily_loss_trips_at_run_start(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True, config={"max_drawdown_pct": 0.5, "max_daily_loss_pct": 0.05})
    w.run(research=lambda info, prior: estimate(0.5))  # sets today's start, no entries (no edge)
    fake.set_cash("930")  # -7% today
    calls = []
    d = w.run(research=counting_research(calls))
    assert (tmp_path / "KILL").exists() and calls == []
    assert "daily loss" in kinds(d, "run_stopped")[0]["reason"]


def test_dry_run_paper_breaker_trips_at_run_start(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=False, config={"max_drawdown_pct": 0.05, "allowed_event_tickers": ["FEDJAN26"]})
    w.run()  # paper entries
    for sym in ("GEMI-FEDJAN26-DN25", "GEMI-FEDJAN26-HOLD"):
        fake.set_book(sym, "0.01", "0.03")  # paper positions collapse in value
    calls = []
    d = w.run(research=counting_research(calls))
    assert (tmp_path / "KILL").exists() and calls == []
    assert kinds(d, "run_stopped")


def test_check_that_cant_complete_stops_the_run_without_kill(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True)
    fake.fail_next("/v1/balances", "503", times=100)
    calls = []
    d = w.run(research=counting_research(calls))
    assert calls == [] and w.posts(ORDER) == []
    assert not (tmp_path / "KILL").exists()  # an outage isn't a trip
    assert "balances" in kinds(d, "run_stopped")[0]["reason"]


def test_existing_kill_stops_the_run_before_research(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True)
    (tmp_path / "KILL").write_text("manual")
    calls = []
    d = w.run(research=counting_research(calls))
    assert calls == [] and "kill switch" in kinds(d, "run_stopped")[0]["reason"]


def test_healthy_account_runs_normally_and_check_comes_first(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True)
    calls = []
    d = w.run(research=counting_research(calls))
    assert calls and kinds(d, "entry") and not kinds(d, "run_stopped")
    names = tool_names(w)
    assert names.index("check_circuit_breakers") < names.index("get_positions") < names.index("propose_order")


def test_check_tool_is_read_only_except_for_kill_and_risk_state(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True)
    import asyncio
    r = asyncio.run(w.tools.call("check_circuit_breakers"))
    assert r["ok"] is True and r["tripped"] is False and "equity_usd" in r
    assert [p for m, p, _ in fake.requests if m == "POST"] and w.posts(ORDER) == []
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text())
    assert cfg["max_trades_per_day"] == 10  # untouched

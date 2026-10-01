"""Short-dated focus: the runner only researches/enters contracts expiring inside
[min_hours_to_expiry, max_days_to_expiry]; everything else is skipped and logged before research."""

from datetime import datetime, timezone
from decimal import Decimal as D

import pytest
import yaml

import preflight
from conftest import EVENT, T0, make_contract, make_event
from guardrails import Config, ConfigError, load_config
from test_preflight import DRY, GOOD
from test_runner import by_kind, run


def iso(hours):
    return datetime.fromtimestamp(T0 + hours * 3600, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def market(env, *hours):
    contracts = []
    for i, h in enumerate(hours):
        contracts.append(make_contract(
            symbol=f"GEMI-{EVENT}-C{i}", label=f"c{i}", expiryDate=iso(h),
            prices={"buy": {"yes": "0.62", "no": "0.40"}, "sell": {"yes": "0.60", "no": "0.38"},
                    "bestBid": "0.60", "bestAsk": "0.62"}))
    env.market.events[EVENT] = make_event(contracts=contracts)
    env.market.book = {"bids": [["0.60", "500"]], "asks": [["0.62", "500"]]}


def test_defaults():
    c = Config()
    assert c.max_days_to_expiry == D("7") and c.min_hours_to_expiry == D("6")


def test_only_contracts_inside_the_window_are_researched(env):
    market(env, 3, 48, 20 * 24)  # too soon, inside, too far
    decisions, tools, calls, _ = run(env, max_order_usd=1)
    researched = [info["instrument_symbol"] for info, _ in calls]
    assert researched == [f"GEMI-{EVENT}-C1"]
    skips = [d for d in by_kind(decisions, "no_trade") if "expiry window" in (d.get("reason") or "")]
    assert [d["instrument_symbol"] for d in skips] == [f"GEMI-{EVENT}-C0", f"GEMI-{EVENT}-C2"]
    assert "min_hours_to_expiry 6" in skips[0]["reason"] and "max_days_to_expiry 7" in skips[1]["reason"]
    assert all(d.get("hours_to_expiry") for d in skips)
    logged = [e for e in env.audit() if e["event"] == "decision" and "expiry window" in (e.get("reason") or "")]
    assert len(logged) == 2


def test_window_boundaries_are_inclusive(env):
    market(env, 6, 7 * 24, 5.9, 7 * 24 + 0.1)
    _, _, calls, _ = run(env, max_order_usd=1)
    assert sorted(info["instrument_symbol"] for info, _ in calls) == [f"GEMI-{EVENT}-C0", f"GEMI-{EVENT}-C1"]


def test_window_is_configurable(env):
    market(env, 3, 20 * 24)
    _, _, calls, _ = run(env, max_order_usd=1, min_hours_to_expiry=1, max_days_to_expiry=30)
    assert len(calls) == 2


def test_out_of_window_skip_happens_before_the_budget_check(env):
    market(env, 20 * 24)
    decisions, _, calls, _ = run(env, max_research_per_run=0)
    assert calls == []
    assert any("expiry window" in (d.get("reason") or "") for d in by_kind(decisions, "no_trade"))


def test_position_review_ignores_the_window(env):
    # Held positions are still reviewed (and can be exited) whatever their expiry: the window only gates entries.
    import inspect

    import runner
    src = inspect.getsource(runner.Runner.review_positions)
    assert "max_days_to_expiry" not in src and "min_hours_to_expiry" not in src


@pytest.mark.parametrize("over,needle", [
    ({"max_days_to_expiry": 0}, "max_days_to_expiry"),
    ({"max_days_to_expiry": -1}, "max_days_to_expiry"),
    ({"min_hours_to_expiry": -1}, "min_hours_to_expiry"),
    ({"min_hours_to_expiry": 200, "max_days_to_expiry": 7}, "empty"),
    ({"max_days_to_expiry": "x"}, "max_days_to_expiry"),
])
def test_bad_window_config_is_refused(tmp_path, over, needle):
    p = tmp_path / "config.yaml"
    p.write_text(yaml.safe_dump(over))
    with pytest.raises(ConfigError, match=needle):
        load_config(p)


def test_preflight_warns_above_30_days(tmp_path):
    here = tmp_path
    (here / "config.yaml").write_text(yaml.safe_dump({**GOOD, "max_days_to_expiry": 31}))
    ok = lambda *a, **k: __import__("subprocess").CompletedProcess(a, 0, "", "")  # noqa: E731
    fails, notes = preflight.check_with_notes(DRY, here, git=ok)
    assert not any("max_days_to_expiry" in f for f in fails)  # a warning, not a failure
    assert any("max_days_to_expiry is 31" in n for n in notes)
    (here / "config.yaml").write_text(yaml.safe_dump({**GOOD, "max_days_to_expiry": 30}))
    _, notes = preflight.check_with_notes(DRY, here, git=ok)
    assert not any("max_days_to_expiry" in n for n in notes)


def test_shipped_config_sets_the_window():
    from pathlib import Path
    raw = yaml.safe_load((Path(__file__).resolve().parents[1] / "config.yaml").read_text())
    assert raw["max_days_to_expiry"] == 7 and raw["min_hours_to_expiry"] == 6

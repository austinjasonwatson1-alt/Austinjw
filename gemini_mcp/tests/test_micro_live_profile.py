"""Profiles: config.yaml may define named profiles that override base keys; "micro_live" is the small-stakes live
profile. learning_budget_usd sets the equity floor at starting balance - budget (never below 40% of it). Preflight
refuses live mode when the effective limits exceed the micro_live ceilings, unless allow_above_micro_live: true."""

import json
from decimal import Decimal as D
from pathlib import Path

import pytest
import yaml

import preflight
from conftest import write_config
from guardrails import Config, ConfigError, load_config
from test_preflight import DRY, LIVE
from test_safety_additions import propose, set_equity

ROOT = Path(__file__).resolve().parents[1]
MICRO = {"max_order_usd": 5, "max_daily_spend_usd": 15, "max_trades_per_day": 4, "max_open_orders": 2,
         "runner_auto_confirm_live": False}


def load(tmp_path, data):
    p = tmp_path / "config.yaml"
    p.write_text(yaml.safe_dump(data))
    return load_config(p)


# ------------------------------------------------------------------ loading profiles


def test_shipped_micro_live_profile_matches_the_ceilings():
    raw = yaml.safe_load((ROOT / "config.yaml").read_text())
    prof = raw["profiles"]["micro_live"]
    assert {k: prof[k] for k in MICRO} == MICRO
    assert "learning_budget_usd" in prof
    assert {k: D(str(v)) if not isinstance(v, bool) else v for k, v in MICRO.items()} == \
        {k: (v if isinstance(v, bool) else D(str(v))) for k, v in preflight.MICRO_LIVE_CEILINGS.items()}
    assert raw.get("profile") is None  # nothing active by default (the shipped setup is DRY_RUN)


def test_selecting_a_profile_overrides_base_keys(tmp_path):
    c = load(tmp_path, {"max_order_usd": 2, "max_daily_spend_usd": 5, "min_edge": 0.07, "profile": "micro_live",
                        "profiles": {"micro_live": {**MICRO, "learning_budget_usd": 30}}})
    assert c.profile == "micro_live"
    assert (c.max_order_usd, c.max_daily_spend_usd, c.max_trades_per_day, c.max_open_orders) == (5, 15, 4, 2)
    assert c.min_edge == D("0.07") and c.learning_budget_usd == D("30")


def test_profiles_are_ignored_unless_selected(tmp_path):
    c = load(tmp_path, {"max_order_usd": 2, "profiles": {"micro_live": MICRO}})
    assert c.profile is None and c.max_order_usd == D("2")


@pytest.mark.parametrize("data,needle", [
    ({"profile": "nope", "profiles": {"micro_live": MICRO}}, "profile 'nope'"),
    ({"profile": "micro_live"}, "profile 'micro_live'"),
    ({"profile": 3, "profiles": {"micro_live": MICRO}}, "profile"),
    ({"profiles": ["micro_live"]}, "profiles"),
    ({"profiles": {"micro_live": {"max_ordr_usd": 5}}}, "max_ordr_usd"),        # typo inside a profile
    ({"profiles": {"micro_live": {"profile": "x"}}}, "profile"),               # no nesting
    ({"profiles": {"micro_live": {"max_order_usd": -1}}, "profile": "micro_live"}, "max_order_usd"),
    ({"profiles": {"micro_live": {"max_order_usd": -1}}}, "max_order_usd"),    # checked even when not selected
    ({"profiles": {"micro_live": None}}, "micro_live"),
])
def test_bad_profiles_are_refused(tmp_path, data, needle):
    with pytest.raises(ConfigError, match=needle):
        load(tmp_path, data)


@pytest.mark.parametrize("bad", [0, -5, "x"])
def test_learning_budget_must_be_positive(tmp_path, bad):
    with pytest.raises(ConfigError, match="learning_budget_usd"):
        load(tmp_path, {"learning_budget_usd": bad})


# ------------------------------------------------------------------ the floor


@pytest.mark.parametrize("budget,floor", [("30", "70.00"), ("60", "40.00"), ("90", "40.00")])
def test_learning_budget_sets_the_floor_never_below_40pct(env, budget, floor):
    write_config(env.config_path, starting_balance_usd=100, learning_budget_usd=float(budget),
                 max_drawdown_pct=1, max_daily_loss_pct=1, max_order_usd=1)
    set_equity(env, 100)
    g = env.guard()
    assert propose(g)["ok"]
    s = g.risk_summary()
    assert s["equity_floor_usd"] == floor and s["equity_floor_basis"]["source"] == "starting_balance_usd"


def test_learning_budget_floor_trips(env):
    write_config(env.config_path, starting_balance_usd=100, learning_budget_usd=30, max_drawdown_pct=1,
                 max_daily_loss_pct=1, max_order_usd=1)
    set_equity(env, 100)
    g = env.guard()
    assert propose(g)["ok"]
    set_equity(env, "69.99")
    r = propose(g)
    assert not r["ok"] and "equity floor" in r["reason"] and env.kill_path.exists()
    assert json.loads(env.kill_path.read_text())["floor"] == "70.00"


def test_learning_budget_applies_even_with_equity_floor_pct_zero(env):
    write_config(env.config_path, starting_balance_usd=100, learning_budget_usd=30, equity_floor_pct=0,
                 max_drawdown_pct=1, max_daily_loss_pct=1, max_order_usd=1)
    set_equity(env, 100)
    g = env.guard()
    propose(g)
    assert g.risk_summary()["equity_floor_usd"] == "70.00"


def test_paper_floor_uses_the_bankroll_as_starting_balance(env):
    write_config(env.config_path, learning_budget_usd=25, max_order_usd=1)
    g = env.guard(dry_run=True)
    propose(g)
    s = g.risk_summary()
    assert s["equity_floor_usd"] == "75.00" and s["equity_floor_basis"]["source"] == "paper_bankroll"


def test_without_a_learning_budget_the_pct_floor_is_unchanged(env):
    write_config(env.config_path, starting_balance_usd=100, max_drawdown_pct=1, max_daily_loss_pct=1,
                 max_order_usd=1)
    set_equity(env, 100)
    g = env.guard()
    propose(g)
    assert g.risk_summary()["equity_floor_usd"] == "60.00"


# ------------------------------------------------------------------ preflight


def ok_git(*a, **k):
    import subprocess
    return subprocess.CompletedProcess(a, 0, "", "")


BASE = {"allowed_event_tickers": ["FEDJAN26"], "starting_balance_usd": 100, "fee_confirmed": True}


def pf(tmp_path, environ, data, marker=True):
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(data))
    if marker:
        import verify_auth
        verify_auth.write_marker("sandbox", tmp_path)
    return preflight.check_with_notes(environ, tmp_path, git=ok_git)


MICRO_ON = {**BASE, "profile": "micro_live", "profiles": {"micro_live": {**MICRO, "learning_budget_usd": 30}}}


def test_live_with_micro_live_passes(tmp_path):
    fails, _ = pf(tmp_path, LIVE, MICRO_ON)
    assert fails == []


@pytest.mark.parametrize("key,value", [("max_order_usd", 5.01), ("max_daily_spend_usd", 16), ("max_trades_per_day", 5),
                                       ("max_open_orders", 3), ("runner_auto_confirm_live", True)])
def test_live_above_a_ceiling_fails(tmp_path, key, value):
    data = json.loads(json.dumps(MICRO_ON))
    data["profiles"]["micro_live"][key] = value
    fails, _ = pf(tmp_path, LIVE, data)
    assert any(key in f and ("settled live trades" in f or "hand-confirmed" in f) for f in fails), fails


def test_live_with_no_profile_is_held_to_the_same_ceilings(tmp_path):
    fails, _ = pf(tmp_path, LIVE, {**BASE, "max_order_usd": 10, "learning_budget_usd": 30})
    assert any("max_order_usd" in f and "micro_live" in f for f in fails)
    # the library defaults (no limits set at all) exceed them too
    fails, _ = pf(tmp_path, LIVE, {**BASE, "learning_budget_usd": 30})
    assert any("max_daily_spend_usd" in f for f in fails)


def test_live_needs_a_learning_budget(tmp_path):
    data = json.loads(json.dumps(MICRO_ON))
    data["profiles"]["micro_live"]["learning_budget_usd"] = None
    fails, _ = pf(tmp_path, LIVE, data)
    assert any("learning_budget_usd" in f for f in fails)


def test_unlocked_limits_do_not_relax_other_bounds(tmp_path):
    # Even with the scale-up gate passed, the fixed risk bounds still apply (see test_fast_track_gates.py).
    fails, _ = pf(tmp_path, LIVE, {**MICRO_ON, "kelly_multiplier": 0.9})
    assert any("kelly_multiplier" in f for f in fails)


def test_dry_run_only_notes_the_ceilings(tmp_path):
    fails, notes = pf(tmp_path, DRY, {**BASE, "max_order_usd": 10}, marker=False)
    assert not any("micro_live" in f for f in fails)
    assert any("max_order_usd" in n and "micro_live" in n for n in notes)


def test_clamped_learning_budget_is_noted(tmp_path):
    data = json.loads(json.dumps(MICRO_ON))
    data["profiles"]["micro_live"]["learning_budget_usd"] = 80
    fails, notes = pf(tmp_path, LIVE, data)
    assert fails == [] and any("40%" in n and "learning_budget_usd" in n for n in notes)


def test_enforce_refuses_live_above_ceilings(tmp_path):
    import io
    (tmp_path / "config.yaml").write_text(yaml.safe_dump({**BASE, "max_order_usd": 10}))
    out = io.StringIO()
    assert preflight.enforce(LIVE, tmp_path, out=out) is False
    assert "micro_live" in out.getvalue()


def test_config_defaults():
    c = Config()
    assert c.profile is None and c.learning_budget_usd is None and not hasattr(c, "allow_above_micro_live")

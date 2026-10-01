"""max_trades_per_day: placed orders per UTC day, checked at propose and confirm, persisted per mode."""

import json

import pytest
import yaml

from conftest import SYMBOL, make_position, write_config
from guardrails import ConfigError, load_config


def buy(g, qty="2", price="0.50", outcome="yes"):
    r = g.propose(SYMBOL, outcome, "buy", qty, price)
    assert r["ok"], r
    return g.confirm(r["confirmation_token"])


def test_default_is_5_and_shipped_config_sets_5(tmp_path):
    p = tmp_path / "c.yaml"
    p.write_text("{}\n")
    assert load_config(p).max_trades_per_day == 5
    from pathlib import Path
    shipped = yaml.safe_load((Path(__file__).resolve().parents[1] / "config.yaml").read_text())
    assert shipped["max_trades_per_day"] == 5


@pytest.mark.parametrize("bad", [-1, 1.5, "five", True])
def test_bad_config_values(tmp_path, bad):
    p = tmp_path / "c.yaml"
    write_config(p, max_trades_per_day=bad)
    with pytest.raises(ConfigError):
        load_config(p)


def test_limit_enforced_at_propose_and_resets_next_utc_day(env):
    write_config(env.config_path, max_trades_per_day=2)
    g = env.guard()
    assert buy(g)["ok"] and buy(g)["ok"]
    r = g.propose(SYMBOL, "yes", "buy", "2", "0.50")
    assert not r["ok"] and "trades placed today" in r["reason"]
    assert env.audit()[-1]["event"] == "rejection"
    env.clock.t += 86400
    assert buy(g)["ok"]


def test_limit_enforced_again_at_confirm(env):
    write_config(env.config_path, max_trades_per_day=2)
    g = env.guard()
    toks = [g.propose(SYMBOL, "yes", "buy", "2", "0.50")["confirmation_token"] for _ in range(3)]
    assert g.confirm(toks[0])["ok"] and g.confirm(toks[1])["ok"]
    r = g.confirm(toks[2])
    assert not r["ok"] and "trades placed today" in r["reason"]
    assert len(env.trader.placed) == 2


def test_sells_dont_use_the_trade_budget(env):
    # Exits have their own ceiling (max_exits_per_day, tests/test_exits_per_day.py).
    write_config(env.config_path, max_trades_per_day=1)
    env.market.positions = {"positions": [make_position(total="10")]}
    g = env.guard()
    r = g.propose(SYMBOL, "yes", "sell", "5", "0.70")
    assert g.confirm(r["confirmation_token"])["ok"]
    assert g.propose(SYMBOL, "yes", "buy", "2", "0.50")["ok"]


def test_failed_placement_still_counts(env):
    write_config(env.config_path, max_trades_per_day=1)
    g = env.guard()

    def boom(*a):
        raise RuntimeError("timeout")

    env.trader.place_limit_order = boom
    assert not buy(g)["ok"]
    assert "trades placed today" in g.propose(SYMBOL, "yes", "buy", "2", "0.50")["reason"]


def test_persists_across_restart_and_modes_are_separate(env):
    write_config(env.config_path, max_trades_per_day=1)
    assert buy(env.guard())["ok"]
    assert "trades placed today" in env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")["reason"]
    d = env.guard(dry_run=True)
    assert buy(d, outcome="no", price="0.36")["ok"]  # dry run has its own count
    assert "trades placed today" in d.propose(SYMBOL, "no", "buy", "2", "0.36")["reason"]


def test_zero_blocks_everything(env):
    write_config(env.config_path, max_trades_per_day=0)
    assert "trades placed today" in env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")["reason"]


def test_missing_ledger_after_first_use_fails_closed(env):
    g = env.guard()
    assert g.propose(SYMBOL, "yes", "buy", "2", "0.50")["ok"]  # initializes state, no trade yet
    env.ledger_path.unlink()
    r = env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")
    assert not r["ok"] and "daily_spend" in r["reason"], r


def test_ledger_missing_this_mode_fails_closed(env):
    assert buy(env.guard())["ok"]
    data = json.loads(env.ledger_path.read_text())
    for section in data.values():
        if isinstance(section, dict):
            section.pop("sandbox:live", None)
    env.ledger_path.write_text(json.dumps(data))
    r = env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")
    assert not r["ok"] and "daily_spend" in r["reason"], r


def test_legacy_risk_state_without_ledger_initializes(env):
    env.risk_path.parent.mkdir(parents=True, exist_ok=True)
    env.risk_path.write_text(json.dumps({"sandbox:live": {"peak": "1000", "day": "2026-09-21",
                                                          "day_start": "1000"}}))
    assert buy(env.guard())["ok"]


def test_risk_summary_and_preview_show_trade_count(env):
    write_config(env.config_path, max_trades_per_day=3)
    g = env.guard()
    buy(g)
    s = g.risk_summary()
    assert (s["trades_today"], s["max_trades_per_day"]) == (1, 3)
    p = g.propose(SYMBOL, "yes", "buy", "2", "0.50")["preview"]
    assert p["limits"]["trades_today"] == 1 and p["limits"]["max_trades_per_day"] == 3

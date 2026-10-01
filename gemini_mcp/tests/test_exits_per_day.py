"""Task 2: sells of held quantity (exits) are exempt from max_trades_per_day and have their own ceiling,
max_exits_per_day (default 10), at propose and confirm, with the same file protections as the trade count."""

import json
from pathlib import Path

import pytest
import yaml

from conftest import SYMBOL, make_position, write_config
from guardrails import ConfigError, load_config


def hold(env, total="50"):
    env.market.positions = {"positions": [make_position(total=total)]}


def sell(g, qty="1"):
    r = g.propose(SYMBOL, "yes", "sell", qty, "0.70")
    assert r["ok"], r
    return g.confirm(r["confirmation_token"])


def buy(g):
    r = g.propose(SYMBOL, "yes", "buy", "2", "0.50")
    assert r["ok"], r
    return g.confirm(r["confirmation_token"])


def test_default_and_shipped_config(tmp_path):
    p = tmp_path / "c.yaml"
    p.write_text("{}\n")
    assert load_config(p).max_exits_per_day == 10
    shipped = yaml.safe_load((Path(__file__).resolve().parents[1] / "config.yaml").read_text())
    assert shipped["max_exits_per_day"] == 10


@pytest.mark.parametrize("bad", [-1, 2.5, "ten", True])
def test_bad_values(tmp_path, bad):
    p = tmp_path / "c.yaml"
    write_config(p, max_exits_per_day=bad)
    with pytest.raises(ConfigError):
        load_config(p)


def test_sells_are_exempt_from_max_trades_per_day(env):
    write_config(env.config_path, max_trades_per_day=1)
    hold(env)
    g = env.guard()
    assert buy(g)["ok"]
    assert "trades placed today" in g.propose(SYMBOL, "yes", "buy", "2", "0.50")["reason"]
    assert sell(g)["ok"] and sell(g)["ok"]  # exits still allowed after the trade cap is used up


def test_zero_trades_still_allows_exits(env):
    write_config(env.config_path, max_trades_per_day=0)
    hold(env)
    g = env.guard()
    assert sell(g)["ok"]
    assert not g.propose(SYMBOL, "yes", "buy", "2", "0.50")["ok"]


def test_buys_dont_use_the_exit_budget(env):
    write_config(env.config_path, max_exits_per_day=1, max_trades_per_day=5)
    hold(env)
    g = env.guard()
    assert buy(g)["ok"] and buy(g)["ok"]
    assert sell(g)["ok"]


def test_exit_ceiling_at_propose_and_reset_next_utc_day(env):
    write_config(env.config_path, max_exits_per_day=2)
    hold(env)
    g = env.guard()
    assert sell(g)["ok"] and sell(g)["ok"]
    r = g.propose(SYMBOL, "yes", "sell", "1", "0.70")
    assert not r["ok"] and "exits placed today" in r["reason"] and "max_exits_per_day is 2" in r["reason"]
    assert env.audit()[-1]["event"] == "rejection"
    env.clock.t += 86400
    assert sell(g)["ok"]


def test_exit_ceiling_at_confirm(env):
    write_config(env.config_path, max_exits_per_day=2)
    hold(env)
    g = env.guard()
    toks = [g.propose(SYMBOL, "yes", "sell", "1", "0.70")["confirmation_token"] for _ in range(3)]
    assert g.confirm(toks[0])["ok"] and g.confirm(toks[1])["ok"]
    r = g.confirm(toks[2])
    assert not r["ok"] and "exits placed today" in r["reason"]
    assert len(env.trader.placed) == 2


def test_zero_exits_blocks_sells(env):
    write_config(env.config_path, max_exits_per_day=0)
    hold(env)
    assert "exits placed today" in env.guard().propose(SYMBOL, "yes", "sell", "1", "0.70")["reason"]


def test_persists_across_restart_and_modes_are_separate(env):
    write_config(env.config_path, max_exits_per_day=1)
    hold(env)
    assert sell(env.guard())["ok"]
    assert "exits placed today" in env.guard().propose(SYMBOL, "yes", "sell", "1", "0.70")["reason"]


def test_counts_show_in_preview_and_risk_summary(env):
    write_config(env.config_path, max_exits_per_day=4)
    hold(env)
    g = env.guard()
    sell(g)
    s = g.risk_summary()
    assert (s["exits_today"], s["max_exits_per_day"]) == (1, 4)
    p = g.propose(SYMBOL, "yes", "sell", "1", "0.70")["preview"]["limits"]
    assert (p["exits_today"], p["max_exits_per_day"]) == (1, 4)


# --------------------------------------------------------------- same file protections as the trade count


def edit_ledger(env, fn):
    data = json.loads(env.ledger_path.read_text())
    fn(data)
    env.ledger_path.write_text(json.dumps(data))


def refused(env, needle, side="sell"):
    g = env.guard()
    r = g.propose(SYMBOL, "yes", side, "1" if side == "sell" else "2", "0.70" if side == "sell" else "0.50")
    assert not r["ok"] and needle in r["reason"], r
    assert env.audit()[-1]["event"] == "rejection"


def test_missing_ledger_after_use_is_refused(env):
    hold(env)
    assert sell(env.guard())["ok"]
    env.ledger_path.unlink()
    refused(env, "daily_spend")


def test_ledger_missing_this_modes_exit_entry_is_refused(env):
    hold(env)
    assert sell(env.guard())["ok"]
    edit_ledger(env, lambda d: d["exits"].pop("sandbox:live"))
    refused(env, "daily_spend")


def test_current_format_ledger_without_exit_section_is_refused(env):
    hold(env)
    assert sell(env.guard())["ok"]
    edit_ledger(env, lambda d: d.pop("exits"))
    refused(env, "daily spend ledger")


@pytest.mark.parametrize("count", [-1, "3", None, 1.5, True])
def test_malformed_exit_count_is_refused(env, count):
    hold(env)
    assert sell(env.guard())["ok"]
    edit_ledger(env, lambda d: d["exits"]["sandbox:live"].update({"2026-09-21": count}))
    refused(env, "malformed")


def test_exit_count_rolled_back_below_audit_is_refused(env):
    hold(env)
    g = env.guard()
    assert sell(g)["ok"] and sell(g)["ok"]
    edit_ledger(env, lambda d: d["exits"]["sandbox:live"].update({"2026-09-21": 0}))
    refused(env, "audit.log")
    refused(env, "audit.log", side="buy")  # buys refused too: the ledger can't be trusted


def test_legacy_v1_ledger_without_exits_is_upgraded(env):
    """A ledger written before exits existed (version 1, no exits section) keeps working."""
    g = env.guard()
    assert buy(g)["ok"]
    edit_ledger(env, lambda d: (d.pop("exits"), d.update(version=1)))
    hold(env)
    assert sell(env.guard())["ok"]
    data = json.loads(env.ledger_path.read_text())
    assert data["version"] == 2 and data["exits"]["sandbox:live"]["2026-09-21"] == 1

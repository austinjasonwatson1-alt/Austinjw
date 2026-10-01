"""state/daily_spend.json must be present, well-formed, and never below what audit.log shows for today."""

import json

import pytest

from conftest import SYMBOL, make_position


def buy(g, qty="4", price="0.50"):
    r = g.propose(SYMBOL, "yes", "buy", qty, price)
    assert r["ok"], r
    return g.confirm(r["confirmation_token"])


def edit_ledger(env, fn):
    data = json.loads(env.ledger_path.read_text())
    fn(data)
    env.ledger_path.write_text(json.dumps(data))


def refused(env, needle):
    r = env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")
    assert not r["ok"] and needle in r["reason"], r
    last = env.audit()[-1]
    assert last["event"] == "rejection" and needle in last["reason"]
    return r


def test_missing_after_use_is_refused_and_logged(env):
    assert buy(env.guard())["ok"]
    env.ledger_path.unlink()
    refused(env, "daily_spend")


def test_corrupt_json_is_refused_and_logged(env):
    assert buy(env.guard())["ok"]
    env.ledger_path.write_text("{not json")
    refused(env, "unreadable")


@pytest.mark.parametrize("amount", ["NaN", "-50", "abc", "Infinity", None, 5])
def test_malformed_spend_amount_is_refused_and_logged(env, amount):
    assert buy(env.guard())["ok"]
    edit_ledger(env, lambda d: d["spend"]["sandbox:live"].update({"2026-09-21": amount}))
    refused(env, "malformed")


def test_spend_rolled_back_below_audit_is_refused(env):
    g = env.guard()
    assert buy(g)["ok"] and buy(g)["ok"]  # $2 + $2
    edit_ledger(env, lambda d: d["spend"]["sandbox:live"].update({"2026-09-21": "1"}))
    r = refused(env, "audit.log")
    assert "$4" in r["reason"]


def test_trade_count_rolled_back_below_audit_is_refused(env):
    g = env.guard()
    assert buy(g)["ok"] and buy(g)["ok"]
    edit_ledger(env, lambda d: d["trades"]["sandbox:live"].update({"2026-09-21": 0}))
    refused(env, "audit.log")


def test_state_wiped_but_audit_shows_today_is_refused(env):
    assert buy(env.guard())["ok"]
    env.ledger_path.unlink()
    env.risk_path.unlink()
    refused(env, "audit.log")


def test_sells_count_toward_the_audit_trade_floor(env):
    env.market.positions = {"positions": [make_position(total="10")]}
    g = env.guard()
    assert g.confirm(g.propose(SYMBOL, "yes", "sell", "5", "0.70")["confirmation_token"])["ok"]
    edit_ledger(env, lambda d: d["trades"]["sandbox:live"].update({"2026-09-21": 0}))
    refused(env, "audit.log")


def test_other_mode_and_other_day_audit_entries_are_ignored(env):
    d = env.guard(dry_run=True)
    assert d.confirm(d.propose(SYMBOL, "no", "buy", "2", "0.36")["confirmation_token"])["ok"]
    assert env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")["ok"]  # live: dry-run entries don't count
    g = env.guard()
    assert buy(g)["ok"]
    env.clock.t += 86400
    assert buy(g)["ok"]  # yesterday's audit entries don't count today


def test_ledger_at_or_above_audit_is_fine(env):
    g = env.guard()
    assert buy(g)["ok"]
    edit_ledger(env, lambda d: d["spend"]["sandbox:live"].update({"2026-09-21": "3"}))
    assert g.propose(SYMBOL, "yes", "buy", "2", "0.50")["ok"]


def test_garbage_audit_lines_are_skipped(env):
    g = env.guard()
    assert buy(g)["ok"]
    with open(env.audit_path, "a") as f:
        f.write('{"ts": "2026-09-21T00:00:00.000+00:00", broken\n')
    assert g.propose(SYMBOL, "yes", "buy", "2", "0.50")["ok"]

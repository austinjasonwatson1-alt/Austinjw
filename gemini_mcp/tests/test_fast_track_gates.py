"""Fast-track gates enforced by preflight from audit.log:
- live limits above the micro_live ceilings need >= 20 settled live trades (no override flag any more);
- live auto-confirm needs >= 15 hand-confirmed live trades that ended "placed", counted since the last
  unconfirmed/unknown live send;
- a missing or unreadable audit.log counts as zero."""

import json
from datetime import datetime, timezone

import pytest
import yaml

import preflight
from conftest import SYMBOL, T0
from guardrails import ConfigError, load_config
from test_micro_live_profile import BASE, MICRO, pf
from test_preflight import DRY, LIVE
from test_runner import CFG, by_kind, make_confirm, run, tight_market

SANDBOX = "LIVE (sandbox): test funds"
PROD = "LIVE (production): REAL MONEY"
NOW = T0
PAST, FUTURE = "2026-09-20T00:00:00Z", "2026-09-30T00:00:00Z"
MICRO_ON = {**BASE, "profile": "micro_live", "profiles": {"micro_live": {**MICRO, "learning_budget_usd": 30}}}


def ts(i=0):
    return datetime.fromtimestamp(T0 - 86400 + i, tz=timezone.utc).isoformat(timespec="milliseconds")


class Log:
    def __init__(self):
        self.lines, self.i = [], 0

    def add(self, **e):
        self.i += 1
        self.lines.append(json.dumps({"ts": ts(self.i), **e}))
        return self

    def placed(self, oid, *, side="buy", status="filled", expiry=PAST, mode=SANDBOX, by="hand", decision=True):
        iid = f"i{oid}"
        self.add(event="order_intent", intent_id=iid, action="place", mode=mode, side=side)
        self.add(event="order_result", intent_id=iid, result="placed", order_id=oid, status=status, side=side,
                 mode=mode, contract_expiry=expiry, confirmed_by=by)
        if decision:
            self.add(event="decision", kind="entry" if side == "buy" else "exit", mode="live",
                     order_ref=f"live:{oid}", confirmed_by=by)
        return self

    def unconfirmed(self, iid, mode=SANDBOX):
        self.add(event="order_intent", intent_id=iid, action="place", mode=mode)
        return self.add(event="order_result", intent_id=iid, result="unconfirmed", mode=mode)

    def write(self, path):
        path.write_text("\n".join(self.lines) + "\n")
        return path


def counts(tmp_path, log, env="sandbox", now=NOW):
    return preflight.fast_track_counts(log.write(tmp_path / "audit.log"), env, now)


# ------------------------------------------------------------------ settled live trades


def test_settled_counts_filled_live_buys_whose_contract_expired(tmp_path):
    log = Log()
    for oid in range(1, 4):
        log.placed(oid)
    assert counts(tmp_path, log).settled == 3


@pytest.mark.parametrize("kw", [
    {"expiry": FUTURE},                 # not expired yet
    {"expiry": None},                   # expiry not recorded (older entries)
    {"expiry": "soon"},                 # unparseable
    {"status": "open"},                 # resting at placement: no fill evidence in audit.log
    {"side": "sell"},                   # exits aren't trades
    {"mode": PROD},                     # other environment
    {"mode": "DRY RUN (sandbox): nothing will be placed"},
])
def test_settled_excludes(tmp_path, kw):
    assert counts(tmp_path, Log().placed(1, **kw)).settled == 0


def test_settled_counts_each_order_once_and_ignores_non_placed(tmp_path):
    log = Log().placed(1).placed(1).unconfirmed("x")
    log.add(event="order_result", result="failed", mode=SANDBOX, side="buy", status="filled", contract_expiry=PAST,
            order_id=2)
    assert counts(tmp_path, log).settled == 1


def test_production_counts_only_production(tmp_path):
    log = Log().placed(1, mode=PROD).placed(2)
    assert counts(tmp_path, log, env="production").settled == 1


# ------------------------------------------------------------------ hand-confirmed clean streak


def test_hand_confirmed_placed_trades_are_counted(tmp_path):
    log = Log()
    for oid in range(1, 6):
        log.placed(oid, status="open", expiry=FUTURE)  # fill and settlement don't matter here
    log.placed(6, side="sell")                          # exits count too: each is a hand-confirmed live trade
    assert counts(tmp_path, log).hand_confirmed_clean == 6


@pytest.mark.parametrize("kw", [{"by": "auto"}, {"by": None}, {"decision": False}, {"mode": PROD}])
def test_not_hand_confirmed(tmp_path, kw):
    assert counts(tmp_path, Log().placed(1, **kw)).hand_confirmed_clean == 0


def test_an_unconfirmed_result_restarts_the_count(tmp_path):
    log = Log().placed(1).placed(2).unconfirmed("u").placed(3)
    assert counts(tmp_path, log).hand_confirmed_clean == 1


def test_an_intent_without_a_result_restarts_the_count(tmp_path):
    log = Log().placed(1).placed(2)
    log.add(event="order_intent", intent_id="lost", action="place", mode=SANDBOX)
    log.placed(3)
    assert counts(tmp_path, log).hand_confirmed_clean == 1


def test_an_unknown_cancel_restarts_the_count_too(tmp_path):
    log = Log().placed(1)
    log.add(event="order_intent", intent_id="c", action="cancel", mode=SANDBOX)
    log.add(event="order_result", intent_id="c", result="unconfirmed", mode=SANDBOX)
    assert counts(tmp_path, log).hand_confirmed_clean == 0


def test_a_definite_failure_does_not_restart_it(tmp_path):
    log = Log().placed(1)
    log.add(event="order_intent", intent_id="f", action="place", mode=SANDBOX)
    log.add(event="order_result", intent_id="f", result="failed", mode=SANDBOX)
    log.placed(2)
    assert counts(tmp_path, log).hand_confirmed_clean == 2


def test_other_environment_unknowns_do_not_restart_it(tmp_path):
    log = Log().placed(1).unconfirmed("p", mode=PROD).placed(2)
    assert counts(tmp_path, log).hand_confirmed_clean == 2


def test_a_corrupt_line_restarts_the_streak_but_not_settled(tmp_path):
    log = Log().placed(1).placed(2)
    log.lines.append('{"ts": "2026-09-20T00:00:00", "event": "order_res')
    log.placed(3)
    c = counts(tmp_path, log)
    assert c.hand_confirmed_clean == 1 and c.settled == 3


def test_missing_or_unreadable_audit_counts_zero(tmp_path):
    c = preflight.fast_track_counts(tmp_path / "nope.log", "sandbox", NOW)
    assert (c.settled, c.hand_confirmed_clean) == (0, 0)
    d = tmp_path / "dir.log"
    d.mkdir()
    c = preflight.fast_track_counts(d, "sandbox", NOW)
    assert (c.settled, c.hand_confirmed_clean) == (0, 0)
    b = tmp_path / "bin.log"
    b.write_bytes(b"\xff\xfe\x00garbage")
    c = preflight.fast_track_counts(b, "sandbox", NOW)
    assert (c.settled, c.hand_confirmed_clean) == (0, 0)


# ------------------------------------------------------------------ preflight


def write_trades(tmp_path, settled=0, hand=0):
    log = Log()
    for i in range(settled):
        log.placed(100 + i, by="auto")
    for i in range(hand):
        log.placed(500 + i, status="open", expiry=FUTURE)
    log.write(tmp_path / "audit.log")


def above(**over):
    data = json.loads(json.dumps(MICRO_ON))
    data["profiles"]["micro_live"].update(over)
    return data


@pytest.mark.parametrize("key,value", [("max_order_usd", 6), ("max_daily_spend_usd", 20), ("max_trades_per_day", 5),
                                       ("max_open_orders", 3)])
def test_limits_above_micro_live_need_20_settled_live_trades(tmp_path, key, value):
    write_trades(tmp_path, settled=19)
    fails, _ = pf(tmp_path, LIVE, above(**{key: value}))
    assert any(key in f and "20 settled live trades" in f and "found 19" in f for f in fails), fails
    write_trades(tmp_path, settled=20)
    fails, notes = pf(tmp_path, LIVE, above(**{key: value}))
    assert fails == [] and any("20 settled" in n for n in notes)


def test_auto_confirm_needs_15_clean_hand_confirmed_trades(tmp_path):
    write_trades(tmp_path, hand=14)
    fails, _ = pf(tmp_path, LIVE, above(runner_auto_confirm_live=True))
    assert any("runner_auto_confirm_live" in f and "15" in f and "found 14" in f for f in fails), fails
    write_trades(tmp_path, hand=15)
    fails, _ = pf(tmp_path, LIVE, above(runner_auto_confirm_live=True))
    assert fails == []


def test_settled_trades_alone_do_not_unlock_auto_confirm(tmp_path):
    write_trades(tmp_path, settled=40)  # auto-confirmed trades never count as hand-confirmed
    fails, _ = pf(tmp_path, LIVE, above(runner_auto_confirm_live=True))
    assert any("runner_auto_confirm_live" in f for f in fails)


def test_no_audit_log_means_zero(tmp_path):
    fails, _ = pf(tmp_path, LIVE, above(max_order_usd=6))
    assert any("found 0" in f for f in fails)


def test_override_flag_is_gone(tmp_path):
    p = tmp_path / "config.yaml"
    p.write_text(yaml.safe_dump({**BASE, "allow_above_micro_live": True}))
    with pytest.raises(ConfigError, match="allow_above_micro_live.*removed"):
        load_config(p)
    fails, _ = pf(tmp_path, LIVE, {**BASE, "allow_above_micro_live": True, "learning_budget_usd": 30})
    assert any("allow_above_micro_live" in f for f in fails)


def test_learning_budget_is_still_required_live(tmp_path):
    write_trades(tmp_path, settled=50)
    data = above(max_order_usd=6)
    data["profiles"]["micro_live"]["learning_budget_usd"] = None
    fails, _ = pf(tmp_path, LIVE, data)
    assert any("learning_budget_usd" in f for f in fails)


def test_within_ceilings_needs_no_history(tmp_path):
    fails, _ = pf(tmp_path, LIVE, MICRO_ON)
    assert fails == []


def test_dry_run_only_notes(tmp_path):
    fails, notes = pf(tmp_path, DRY, above(max_order_usd=6, runner_auto_confirm_live=True), marker=False)
    assert not any("settled" in f or "hand-confirmed" in f for f in fails)
    assert any("20 settled" in n for n in notes) and any("hand-confirmed" in n for n in notes)


def test_shipped_config_has_no_override_flag():
    from pathlib import Path
    raw = yaml.safe_load((Path(__file__).resolve().parents[1] / "config.yaml").read_text())
    assert "allow_above_micro_live" not in raw


# ------------------------------------------------------------------ what gets recorded


def test_runner_records_hand_confirmation_and_contract_expiry(env):
    tight_market(env)
    env.trader.place_limit_order = lambda *a: {"orderId": 77, "status": "filled"}
    hand = make_confirm(False, False, CFG, interactive=True, ask=lambda _: "yes")
    decisions, *_ = run(env, dry_run=False, confirm=hand, max_order_usd=1)
    res = [e for e in env.audit() if e["event"] == "order_result"][-1]
    assert res["confirmed_by"] == "hand" and res["contract_expiry"] == "2026-09-24T00:00:00Z"
    assert by_kind(decisions, "entry")[0]["confirmed_by"] == "hand"
    c = preflight.fast_track_counts(env.audit_path, "sandbox", T0)
    assert c.hand_confirmed_clean == 1 and c.settled == 0  # not expired yet
    assert preflight.fast_track_counts(env.audit_path, "sandbox", T0 + 4 * 86400).settled == 1


def test_runner_records_auto_confirmation(env):
    import dataclasses
    tight_market(env)
    auto = make_confirm(False, True, dataclasses.replace(CFG, runner_auto_confirm_live=True), interactive=False)
    decisions, *_ = run(env, dry_run=False, confirm=auto, max_order_usd=1)
    res = [e for e in env.audit() if e["event"] == "order_result"][-1]
    assert res["confirmed_by"] == "auto"
    assert preflight.fast_track_counts(env.audit_path, "sandbox", T0).hand_confirmed_clean == 0


def test_confirmed_by_is_restricted(env):
    from conftest import write_config
    write_config(env.config_path, max_order_usd=1)
    g = env.guard()
    t = g.propose(SYMBOL, "yes", "buy", "1", "0.66")["confirmation_token"]
    g.confirm(t, confirmed_by="definitely a human")
    assert [e for e in env.audit() if e["event"] == "order_result"][-1]["confirmed_by"] is None

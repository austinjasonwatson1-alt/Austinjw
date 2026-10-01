import dataclasses
import json
from decimal import Decimal

import pytest

from conftest import EVENT, SYMBOL, make_contract, make_event, make_order, write_config
from guardrails import (
    AuditLog,
    ConfigError,
    Rejected,
    load_config,
    parse_dry_run,
    parse_env,
    parse_order_input,
)


def events_of(env, name):
    return [e for e in env.audit() if e["event"] == name]


def propose_ok(g, side="buy", outcome="yes", qty="5", price="0.50", symbol=SYMBOL):
    r = g.propose(symbol, outcome, side, qty, price)
    assert r["ok"], r
    return r


# --------------------------------------------------------------- required cases


def test_over_limit_order_rejected(env):
    g = env.guard()
    r = g.propose(SYMBOL, "yes", "buy", "30", "0.50")  # $15 > $10
    assert not r["ok"] and "max_order_usd" in r["reason"]
    rej = events_of(env, "rejection")[-1]
    assert rej["action"] == "propose_order" and "max_order_usd" in rej["reason"]


def test_non_allowlisted_market_rejected(env):
    env.market.events["OTHER"] = make_event("OTHER", [make_contract("GEMI-OTHER-X")])
    g = env.guard()
    r = g.propose("GEMI-OTHER-X", "yes", "buy", "1", "0.50")
    assert not r["ok"] and "not a contract of any allowlisted event" in r["reason"]


def test_empty_allowlist_blocks_everything(env):
    write_config(env.config_path, allowed_event_tickers=[])
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", "0.50")
    assert not r["ok"] and "allowlist is empty" in r["reason"]


def test_expired_token_rejected(env):
    g = env.guard()
    token = propose_ok(g)["confirmation_token"]
    env.clock.t += 301
    r = g.confirm(token)
    assert not r["ok"] and "expired" in r["reason"]
    assert env.trader.placed == []


def test_token_valid_just_before_expiry(env):
    g = env.guard()
    token = propose_ok(g)["confirmation_token"]
    env.clock.t += 299
    assert g.confirm(token)["ok"]


def test_reused_token_rejected(env):
    g = env.guard()
    token = propose_ok(g)["confirmation_token"]
    assert g.confirm(token)["ok"]
    r = g.confirm(token)
    assert not r["ok"] and "already used" in r["reason"]
    assert len(env.trader.placed) == 1


def test_unknown_token_rejected(env):
    r = env.guard().confirm("not-a-real-token")
    assert not r["ok"] and "unknown" in r["reason"]


def test_kill_switch_blocks_all_order_tools(env):
    g = env.guard()
    token = propose_ok(g)["confirmation_token"]
    env.kill_path.write_text("")
    for r in (g.propose(SYMBOL, "yes", "buy", "1", "0.50"), g.confirm(token), g.cancel(123)):
        assert not r["ok"] and "kill switch" in r["reason"]
    assert env.trader.placed == [] and env.trader.cancelled == []


def test_kill_switch_created_mid_confirmation_blocks_placement(env, monkeypatch):
    g = env.guard()
    token = propose_ok(g)["confirmation_token"]
    real_validate = g._validate

    def validate_then_kill(*a, **k):
        v = real_validate(*a, **k)
        env.kill_path.write_text("")
        return v

    monkeypatch.setattr(g, "_validate", validate_then_kill)
    r = g.confirm(token)
    assert not r["ok"] and "kill switch" in r["reason"]
    assert env.trader.placed == []


def test_dry_run_confirm_places_nothing(env):
    g = env.guard(dry_run=True)
    assert g._trader is None
    token = propose_ok(g, outcome="no", price="0.35")["confirmation_token"]
    r = g.confirm(token)
    assert r["ok"] and r["dry_run"] and "Nothing was sent" in r["message"]
    assert env.trader.placed == []
    wp = events_of(env, "would_place")
    assert len(wp) == 1 and wp[0]["trade"] == "BUY NO @ 0.35"
    assert events_of(env, "placement") == []


def test_dry_run_cancel_does_nothing(env):
    r = env.guard(dry_run=True).cancel("42")
    assert r["ok"] and r["dry_run"]
    assert env.trader.cancelled == []
    assert events_of(env, "would_cancel")[0]["order_id"] == 42


def test_dry_run_guardrails_refuse_a_trading_client(env):
    from guardrails import Guardrails
    with pytest.raises(ValueError):
        Guardrails(config_path=env.config_path, kill_path=env.kill_path, ledger=None, audit=None,
                   market=env.market, trader=env.trader, dry_run=True, env="sandbox", paper=env.paper())
    with pytest.raises(ValueError, match="paper ledger"):
        Guardrails(config_path=env.config_path, kill_path=env.kill_path, ledger=None, audit=None,
                   market=env.market, trader=None, dry_run=True, env="sandbox")


def test_daily_cap_accumulates(env):
    g = env.guard()
    for _ in range(3):  # 3 x $8 = $24
        assert g.confirm(propose_ok(g, qty="16", price="0.50")["confirmation_token"])["ok"]
        env.market.active = {"orders": []}
    r = g.propose(SYMBOL, "yes", "buy", "4", "0.50")  # +$2 -> $26 > $25
    assert not r["ok"] and "daily cap" in r["reason"] and "$24" in r["reason"]
    assert g.propose(SYMBOL, "yes", "buy", "2", "0.50")["ok"]  # +$1 -> exactly $25 is allowed


def test_daily_cap_persists_across_restart_and_resets_next_utc_day(env):
    g = env.guard()
    g.confirm(propose_ok(g, qty="20", price="0.50")["confirmation_token"])  # $10
    g.confirm(propose_ok(g, qty="20", price="0.50")["confirmation_token"])  # $20
    g2 = env.guard()  # new instance, same ledger file
    assert not g2.propose(SYMBOL, "yes", "buy", "12", "0.50")["ok"]  # $6 more -> $26
    env.clock.t += 86400
    assert g2.propose(SYMBOL, "yes", "buy", "12", "0.50")["ok"]


def test_daily_cap_checked_again_at_confirm(env):
    g = env.guard()
    t1 = propose_ok(g, qty="16", price="0.50")["confirmation_token"]  # $8
    t2 = propose_ok(g, qty="16", price="0.50")["confirmation_token"]
    t3 = propose_ok(g, qty="16", price="0.50")["confirmation_token"]
    t4 = propose_ok(g, qty="16", price="0.50")["confirmation_token"]  # all pass at propose time
    assert all(g.confirm(t)["ok"] for t in (t1, t2, t3))
    r = g.confirm(t4)
    assert not r["ok"] and "daily cap" in r["reason"]
    assert len(env.trader.placed) == 3


def test_dry_run_spend_does_not_consume_live_budget(env):
    dry = env.guard(dry_run=True)
    for _ in range(3):
        dry.confirm(propose_ok(dry, qty="16", price="0.50")["confirmation_token"])
    assert propose_ok(env.guard(), qty="16", price="0.50")


# --------------------------------------------------------------- extra safety cases


def test_tampered_pending_order_rejected(env):
    g = env.guard()
    token = propose_ok(g)["confirmation_token"]
    pending = g._pending[token]
    object.__setattr__(pending.order, "quantity", "500")
    r = g.confirm(token)
    assert not r["ok"] and "does not match" in r["reason"]
    assert env.trader.placed == []


@pytest.mark.parametrize("price", [None, "market", "", "0", "1", "1.5", "-0.1", "nan", "abc", True])
def test_market_orders_and_bad_prices_rejected(env, price):
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", price)
    assert not r["ok"]


def test_off_grid_price_and_quantity_rejected(env):
    g = env.guard()
    r = g.propose(SYMBOL, "yes", "buy", "1", "0.355")
    assert not r["ok"] and "price grid" in r["reason"]
    r = g.propose(SYMBOL, "yes", "buy", "1.5", "0.35")
    assert not r["ok"] and "quantity grid" in r["reason"]


def test_missing_increments_fail_closed(env):
    env.market.events[EVENT] = make_event(contracts=[make_contract(priceIncrement=None)])
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", "0.35")
    assert not r["ok"] and "increments" in r["reason"]


@pytest.mark.parametrize("outcome", ["YES", "No", "maybe", "", None, "y"])
def test_outcome_must_be_exactly_yes_or_no(env, outcome):
    r = env.guard().propose(SYMBOL, outcome, "buy", "1", "0.35")
    assert not r["ok"] and "outcome" in r["reason"]


@pytest.mark.parametrize("side", ["BUY", "short", None])
def test_side_must_be_exactly_buy_or_sell(env, side):
    assert not env.guard().propose(SYMBOL, "yes", side, "1", "0.35")["ok"]


def test_preview_shows_action_and_mode(env):
    r = propose_ok(env.guard(dry_run=True), outcome="no", price="0.35", qty="4")
    p = r["preview"]
    assert p["action"] == "BUY NO @ 0.35"
    assert p["summary"].startswith("BUY NO @ 0.35 x 4 contracts")
    assert p["worst_case_cost_usd"] == "1.40"
    assert "DRY RUN" in p["mode"]
    assert p["resolved_event_ticker"] == EVENT


def test_proposal_audit_logs_resolved_event_ticker(env):
    propose_ok(env.guard())
    assert events_of(env, "proposal")[0]["resolved_event_ticker"] == EVENT


def test_contract_not_open_rejected(env):
    env.market.events[EVENT] = make_event(contracts=[make_contract(marketState="closed")])
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", "0.35")
    assert not r["ok"] and "marketState" in r["reason"]


def test_allowlist_fails_closed_when_event_lookup_fails(env):
    write_config(env.config_path, allowed_event_tickers=["BROKEN", "OTHER"])
    env.market.failing_events.add("BROKEN")
    env.market.events["OTHER"] = make_event("OTHER", [make_contract("GEMI-OTHER-X")])
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", "0.35")
    assert not r["ok"] and "can't determine which event" in r["reason"]


def test_allowlist_rejects_symbol_found_in_two_events(env):
    write_config(env.config_path, allowed_event_tickers=[EVENT, "DUP"])
    env.market.events["DUP"] = make_event("DUP")
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", "0.35")
    assert not r["ok"] and "more than one" in r["reason"]


def test_allowlist_ignores_nested_child_events(env):
    child = make_event("CHILD", [make_contract("GEMI-CHILD-X")])
    env.market.events[EVENT] = make_event(events=[child])
    r = env.guard().propose("GEMI-CHILD-X", "yes", "buy", "1", "0.35")
    assert not r["ok"] and "not a contract of any allowlisted event" in r["reason"]


def test_allowlist_rejects_mismatched_event_ticker(env):
    env.market.events[EVENT] = make_event(ticker="SOMETHING-ELSE")
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", "0.35")
    assert not r["ok"] and "does not match" in r["reason"]


def test_max_open_orders(env):
    env.market.active = {"orders": [make_order(i) for i in range(3)]}
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", "0.35")
    assert not r["ok"] and "max_open_orders" in r["reason"]


def test_open_orders_lookup_failure_rejects(env):
    env.market.active_error = RuntimeError("HTTP 401")
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", "0.35")
    assert not r["ok"] and "open orders" in r["reason"]


# --------------------------------------------------------------- sells


def hold(env, qty, outcome="yes", on_hold="0"):
    env.market.positions = {"positions": [
        {"symbol": SYMBOL, "outcome": outcome, "totalQuantity": qty, "quantityOnHold": on_hold}]}


def test_sell_within_holdings_uses_one_minus_price_cost(env):
    hold(env, "10")
    r = propose_ok(env.guard(), side="sell", qty="10", price="0.70")
    assert r["preview"]["worst_case_cost_usd"] == "3.00"  # 10 x (1 - 0.70)
    assert r["preview"]["action"] == "SELL YES @ 0.70"


def test_sell_more_than_held_rejected(env):
    hold(env, "10", on_hold="4")  # only 6 available
    r = env.guard().propose(SYMBOL, "yes", "sell", "7", "0.70")
    assert not r["ok"] and "exceeds" in r["reason"]


def test_sell_with_no_position_rejected(env):
    hold(env, "10", outcome="no")  # holds NO, tries to sell YES
    r = env.guard().propose(SYMBOL, "yes", "sell", "1", "0.70")
    assert not r["ok"] and "exceeds" in r["reason"]


def test_sell_of_held_quantity_is_not_capped_in_dollars(env):
    hold(env, "100")
    g = env.guard()
    r = propose_ok(g, side="sell", qty="50", price="0.70")  # worst case 50 x 0.30 = $15 > $10 ceiling
    assert r["preview"]["worst_case_cost_usd"] == "15.00"
    assert g.confirm(r["confirmation_token"])["ok"]
    assert g.ledger.spent_on(g._today()) == 0  # exits don't use the daily budget


@pytest.mark.parametrize("positions", [None, {"nope": 1}, {"positions": "x"},
                                       {"positions": [{"symbol": SYMBOL, "outcome": "yes"}]},
                                       {"positions": [{"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "abc"}]}])
def test_sell_rejected_on_unexpected_positions(env, positions):
    env.market.positions = positions
    assert not env.guard().propose(SYMBOL, "yes", "sell", "1", "0.70")["ok"]


def test_sell_rejected_when_positions_lookup_fails(env):
    env.market.positions_error = RuntimeError("HTTP 500")
    r = env.guard().propose(SYMBOL, "yes", "sell", "1", "0.70")
    assert not r["ok"] and "positions lookup failed" in r["reason"]


# --------------------------------------------------------------- config / settings / audit


def test_config_rechecked_at_confirm(env):
    g = env.guard()
    token = propose_ok(g, qty="16", price="0.50")["confirmation_token"]  # $8
    write_config(env.config_path, max_order_usd=5)
    r = g.confirm(token)
    assert not r["ok"] and "max_order_usd" in r["reason"]


def test_config_errors(tmp_path):
    with pytest.raises(ConfigError):
        load_config(tmp_path / "missing.yaml")
    p = tmp_path / "c.yaml"
    p.write_text("max_order_usd: 5\nallowed_event_ticker: [X]\n")  # typo'd key
    with pytest.raises(ConfigError, match="unknown"):
        load_config(p)
    p.write_text("max_order_usd: -1\n")
    with pytest.raises(ConfigError):
        load_config(p)
    p.write_text("allowed_event_tickers: ['../../etc']\n")
    with pytest.raises(ConfigError):
        load_config(p)


def test_config_defaults(tmp_path):
    p = tmp_path / "c.yaml"
    p.write_text("{}\n")
    c = load_config(p)
    assert (c.max_order_usd, c.max_daily_spend_usd, c.max_open_orders, c.allowed_event_tickers) == (
        Decimal("10"), Decimal("25"), 3, ())
    assert (c.estimate_weight, c.kelly_multiplier, c.max_order_pct_of_balance, c.max_market_pct_of_balance,
            c.max_daily_spend_pct, c.max_drawdown_pct, c.max_daily_loss_pct) == (
        Decimal("0.7"), Decimal("0.25"), Decimal("0.08"), Decimal("0.15"), Decimal("0.25"), Decimal("0.20"),
        Decimal("0.08"))


def test_shipped_config_is_valid_and_trades_nothing():
    from pathlib import Path
    c = load_config(Path(__file__).resolve().parents[1] / "config.yaml")
    assert c.allowed_event_tickers == ()
    assert c.max_order_usd <= 2
    assert c.runner_auto_confirm_live is False


def test_dry_run_parsing():
    assert parse_dry_run(None) is True
    assert parse_dry_run("") is True
    assert parse_dry_run("true") is True
    assert parse_dry_run("false") is False
    for bad in ("False", "0", "no", "off", " false"):
        with pytest.raises(ConfigError):
            parse_dry_run(bad)


def test_env_parsing():
    assert parse_env(None) == "sandbox"
    assert parse_env("production") == "production"
    with pytest.raises(ConfigError):
        parse_env("prod")


def test_corrupt_ledger_fails_closed(env):
    env.ledger_path.parent.mkdir(parents=True, exist_ok=True)
    env.ledger_path.write_text("{not json")
    r = env.guard().propose(SYMBOL, "yes", "buy", "1", "0.35")
    assert not r["ok"] and "ledger" in r["reason"]


def test_audit_log_redacts_secrets(tmp_path):
    a = AuditLog(tmp_path / "a.log", redact=["SEKRET123", "account-KEY"])
    a.write("rejection", reason="bad sig with SEKRET123", key="account-KEY")
    line = (tmp_path / "a.log").read_text()
    assert "SEKRET123" not in line and "account-KEY" not in line
    rec = json.loads(line)
    assert rec["event"] == "rejection" and rec["ts"].endswith("+00:00")


def test_every_action_is_audited(env):
    g = env.guard()
    t = propose_ok(g)["confirmation_token"]
    g.confirm(t)
    g.cancel(1001)
    g.propose(SYMBOL, "yes", "buy", "999", "0.5")
    kinds = [e["event"] for e in env.audit()]
    assert kinds == ["proposal", "confirmation", "order_intent", "order_result", "order_intent", "order_result",
                     "rejection"]
    assert [e["result"] for e in env.audit() if e["event"] == "order_result"] == ["placed", "cancelled"]


def test_parse_order_input_canonicalizes():
    o = parse_order_input(SYMBOL, "yes", "buy", 5, 0.35)
    assert (o.quantity, o.limit_price) == ("5", "0.35")
    assert dataclasses.is_dataclass(o)
    with pytest.raises(Rejected):
        parse_order_input("bad symbol!", "yes", "buy", 1, 0.3)

"""Q5 (safer default): a live sell confirmed in the last RECENT_SELL_WINDOW_S seconds stays reserved against the
same holding even if Gemini's positions/open orders haven't reflected it yet (the static fake market never does)."""

from conftest import SYMBOL, make_position, write_config
from guardrails import RECENT_SELL_WINDOW_S


def setup(env, total="10"):
    write_config(env.config_path, max_exits_per_day=20)
    env.market.positions = {"positions": [make_position(total=total)]}  # never updated: a lagging view


def sell(g, qty):
    r = g.propose(SYMBOL, "yes", "sell", qty, "0.70")
    if not r["ok"]:
        return r
    return g.confirm(r["confirmation_token"])


def test_second_sell_of_the_same_holding_is_refused_while_the_view_lags(env):
    setup(env)
    g = env.guard()
    assert sell(g, "10")["ok"]
    r = g.propose(SYMBOL, "yes", "sell", "10", "0.70")
    assert not r["ok"] and "exceeds" in r["reason"] and "recently confirmed" in r["reason"]


def test_partial_sells_add_up(env):
    setup(env)
    g = env.guard()
    assert sell(g, "4")["ok"]
    assert not g.propose(SYMBOL, "yes", "sell", "7", "0.70")["ok"]
    assert sell(g, "6")["ok"]
    assert not g.propose(SYMBOL, "yes", "sell", "1", "0.70")["ok"]


def test_reservation_expires_after_the_window(env):
    setup(env)
    g = env.guard()
    assert sell(g, "10")["ok"]
    env.clock.t += RECENT_SELL_WINDOW_S + 1
    assert g.propose(SYMBOL, "yes", "sell", "10", "0.70")["ok"]


def test_reservation_is_shared_across_processes(env):
    setup(env)
    assert sell(env.guard(), "10")["ok"]
    assert not env.guard().propose(SYMBOL, "yes", "sell", "1", "0.70")["ok"]  # another "process"


def test_reflected_sells_are_not_double_counted(env):
    write_config(env.config_path, max_exits_per_day=20)
    env.market.positions = {"positions": [make_position(total="10", on_hold="4")]}
    g = env.guard()
    assert sell(g, "4")["ok"]  # Gemini already shows these 4 on hold: max(on_hold 4, recent 4) = 4 reserved
    env.market.positions = {"positions": [make_position(total="10", on_hold="4")]}
    assert g.propose(SYMBOL, "yes", "sell", "6", "0.70")["ok"]


def test_other_outcome_and_dry_run_unaffected(env):
    setup(env)
    g = env.guard()
    assert sell(g, "10")["ok"]
    env.market.positions = {"positions": [make_position(total="10"), make_position(total="5", outcome="no")]}
    assert g.propose(SYMBOL, "no", "sell", "5", "0.30")["ok"]

"""F5: deleting state/risk_state.json silently re-baselined the drawdown peak and day-start equity
(and, without initial_deposit_usd, the floor) to whatever equity is now."""

from conftest import SYMBOL


def test_deleted_risk_state_after_trading_fails_closed(env):
    g = env.guard()
    assert g.confirm(g.propose(SYMBOL, "yes", "buy", "16", "0.50")["confirmation_token"])["ok"]
    env.risk_path.unlink()
    env.market.balances = [{"currency": "USD", "amount": "700", "available": "700"}]  # 30% below peak
    r = env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")
    assert not r["ok"] and "risk state" in r["reason"], r
    assert not env.risk_path.exists() or "peak" not in env.risk_path.read_text()


def test_first_run_without_state_still_works(env):
    assert env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")["ok"]


def test_dry_run_history_does_not_block_live_first_run(env):
    d = env.guard(dry_run=True)
    assert d.confirm(d.propose(SYMBOL, "no", "buy", "2", "0.35")["confirmation_token"])["ok"]
    env.risk_path.unlink()
    d2 = env.guard(dry_run=True)
    assert not d2.propose(SYMBOL, "no", "buy", "2", "0.35")["ok"]
    assert env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")["ok"]  # live has no history

"""F10: paper valuation and paper fills trusted Gemini's quote values unchecked. A sell quote of 50 inflated
paper equity (and so every %-of-equity cap in DRY_RUN); a non-numeric quote raised after spend was recorded."""

from decimal import Decimal

from conftest import EVENT, SYMBOL, make_contract, make_event


def contract_with(buy_no="0.36", sell_no="0.34"):
    c = make_contract()
    c["prices"]["buy"]["no"] = buy_no
    c["prices"]["sell"]["no"] = sell_no
    return c


def test_out_of_range_or_garbage_quote_is_no_quote(env):
    d = env.guard(dry_run=True)
    assert d.confirm(d.propose(SYMBOL, "no", "buy", "5", "0.36")["confirmation_token"])["paper_filled"]
    for bad in ("50", "-3", "abc", "NaN"):
        env.market.events[EVENT] = make_event(contracts=[contract_with(sell_no=bad)])
        s = d.risk_summary()
        assert Decimal(s["equity_usd"]) <= Decimal("100"), (bad, s["equity_usd"])
        assert f"{SYMBOL}|no" in s["positions_without_quote"]


def test_garbage_fill_reference_is_unfilled_not_a_crash(env):
    d = env.guard(dry_run=True)
    tok = d.propose(SYMBOL, "no", "buy", "5", "0.36")["confirmation_token"]
    env.market.events[EVENT] = make_event(contracts=[contract_with(buy_no="abc")])
    r = d.confirm(tok)
    assert r["ok"] and r["paper_filled"] is False, r

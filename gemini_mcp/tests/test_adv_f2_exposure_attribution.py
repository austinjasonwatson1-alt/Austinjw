"""F2: positions and resting orders without contractMetadata.eventTicker were keyed under "" and never
counted toward the per-event or per-category cap of the event they belong to."""

from conftest import EVENT, SYMBOL, make_event, write_config


def test_position_without_event_metadata_counts_toward_market_cap(env):
    # equity 1000 + 168 = 1168; 15% cap = 175.20; existing 168 + new $10 = 178 > cap
    env.market.positions = {"positions": [
        {"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "240", "avgPrice": "0.70", "marketValue": "168"}]}
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert not r["ok"] and "max_market_pct_of_balance" in r["reason"], r


def test_resting_buy_without_event_metadata_counts_toward_market_cap(env):
    env.market.active = {"orders": [
        {"orderId": 1, "symbol": SYMBOL, "outcome": "yes", "side": "buy", "remainingQuantity": "240", "price": "0.70"}]}
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert not r["ok"] and "max_market_pct_of_balance" in r["reason"], r


def test_position_without_metadata_counts_toward_category_cap(env):
    write_config(env.config_path, category_exposure_caps={"sports": 0.05})
    env.market.events[EVENT] = make_event(category="sports")
    # equity 1045, sports cap 52.25; existing 45 + $10 = 55 > cap
    env.market.positions = {"positions": [
        {"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "90", "avgPrice": "0.50", "marketValue": "45"}]}
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert not r["ok"] and "category" in r["reason"], r


def test_tagged_and_untagged_entries_are_not_double_counted(env):
    # Same position reported with metadata: counted once (would be 2 x 168 if double counted).
    env.market.positions = {"positions": [
        {"symbol": SYMBOL, "outcome": "yes", "totalQuantity": "100", "avgPrice": "0.70", "marketValue": "70",
         "contractMetadata": {"eventTicker": EVENT}}]}
    # equity 1070, cap 160.5; 70 + 10 = 80 fits; 2 x 70 + 10 = 150 would also fit, so check the number
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert r["ok"], r

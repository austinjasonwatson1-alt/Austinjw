"""F2: exposure is attributed to an event by its event ticker OR by its symbol being one of that event's
contracts. Missing contractMetadata is now refused outright (test_strict_fields.py); this covers metadata that
names a different (stale or child) event for a contract that belongs to the event being traded."""

from conftest import EVENT, SYMBOL, make_event, make_order, make_position, write_config


def test_position_with_other_event_metadata_counts_toward_market_cap(env):
    # equity 1000 + 168 = 1168; 15% cap = 175.20; existing 168 + new $10 = 178 > cap
    env.market.positions = {"positions": [make_position(total="240", avg="0.70", value="168", event="STALE")]}
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert not r["ok"] and "max_market_pct_of_balance" in r["reason"], r


def test_resting_buy_with_other_event_metadata_counts_toward_market_cap(env):
    env.market.active = {"orders": [make_order(remaining="240", price="0.70", event="STALE")]}
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert not r["ok"] and "max_market_pct_of_balance" in r["reason"], r


def test_position_with_other_category_metadata_counts_toward_category_cap(env):
    write_config(env.config_path, category_exposure_caps={"sports": 0.05})
    env.market.events[EVENT] = make_event(category="sports")
    # equity 1045, sports cap 52.25; existing 45 + $10 = 55 > cap
    env.market.positions = {"positions": [make_position(total="90", avg="0.50", value="45", category="misc")]}
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert not r["ok"] and "category" in r["reason"], r


def test_tagged_entries_are_not_double_counted(env):
    env.market.positions = {"positions": [make_position(total="100", avg="0.70", value="70")]}
    # equity 1070, cap 160.5; counted once: 70 + 10 = 80 fits
    r = env.guard().propose(SYMBOL, "yes", "buy", "20", "0.50")
    assert r["ok"], r

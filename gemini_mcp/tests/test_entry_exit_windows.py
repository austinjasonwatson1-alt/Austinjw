"""The entry window must start no closer to expiry than the near-expiry exit rule: min_hours_to_expiry <
exit_hours_before_expiry is refused, so a contract entered at the edge of the window is never sold on the next run
just because it's near expiry. Shipped: min_hours_to_expiry 12, exit_hours_before_expiry 6."""

from pathlib import Path

import pytest
import yaml

from conftest import EVENT, T0, make_contract, make_event
from guardrails import Config, ConfigError, load_config
from test_expiry_window import iso
from test_runner import by_kind, run

ROOT = Path(__file__).resolve().parents[1]


def load(tmp_path, **over):
    p = tmp_path / "config.yaml"
    p.write_text(yaml.safe_dump(over))
    return load_config(p)


def test_defaults_and_shipped_values():
    c = Config()
    assert (c.min_hours_to_expiry, c.exit_hours_before_expiry) == (12, 6)
    raw = yaml.safe_load((ROOT / "config.yaml").read_text())
    assert raw["min_hours_to_expiry"] == 12 and raw["exit_hours_before_expiry"] == 6
    load_config(ROOT / "config.yaml")


@pytest.mark.parametrize("mn,ex", [(6, 24), (5.9, 6), (0, 1)])
def test_entry_window_inside_the_exit_window_is_refused(tmp_path, mn, ex):
    with pytest.raises(ConfigError, match="min_hours_to_expiry.*exit_hours_before_expiry"):
        load(tmp_path, min_hours_to_expiry=mn, exit_hours_before_expiry=ex)


@pytest.mark.parametrize("mn,ex", [(6, 6), (12, 6), (24, 24), (0, 0)])
def test_equal_or_wider_is_allowed(tmp_path, mn, ex):
    c = load(tmp_path, min_hours_to_expiry=mn, exit_hours_before_expiry=ex)
    assert c.min_hours_to_expiry >= c.exit_hours_before_expiry


def market_expiring_in(env, hours):
    env.market.events[EVENT] = make_event(contracts=[make_contract(prices={
        "buy": {"yes": "0.62", "no": "0.40"}, "sell": {"yes": "0.60", "no": "0.38"},
        "bestBid": "0.60", "bestAsk": "0.62"}, expiryDate=iso(hours))])
    env.market.book = {"bids": [["0.60", "500"]], "asks": [["0.62", "500"]]}


def test_entry_at_the_window_edge_is_not_exited_next_run_for_expiry(env):
    market_expiring_in(env, 12)  # exactly min_hours_to_expiry (shipped 12) out
    decisions, *_ = run(env, min_hours_to_expiry=12, exit_hours_before_expiry=6)
    assert len(by_kind(decisions, "entry")) == 1
    env.clock.t = T0 + 3600  # next hourly run: 11 h left
    decisions, *_ = run(env, min_hours_to_expiry=12, exit_hours_before_expiry=6)
    assert by_kind(decisions, "exit") == []
    hold = by_kind(decisions, "hold")
    assert len(hold) == 1 and not any("near_expiry" in r for r in hold[0]["reasons"])


def test_the_expiry_exit_still_fires_inside_its_own_window(env):
    market_expiring_in(env, 12)
    run(env, min_hours_to_expiry=12, exit_hours_before_expiry=6)
    env.clock.t = T0 + 7 * 3600  # 5 h left: inside exit_hours_before_expiry 6, sell price 0.60 < 0.85
    decisions, *_ = run(env, min_hours_to_expiry=12, exit_hours_before_expiry=6)
    ex = by_kind(decisions, "exit")
    assert len(ex) == 1 and any(r.startswith("near_expiry_not_winning") for r in ex[0]["reasons"])

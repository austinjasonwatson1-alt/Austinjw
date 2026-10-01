"""Research cost budget: each research call's cost is estimated from token and search counts and logged; the
runner stops researching when the per-run or per-UTC-day cost cap would be passed. max_research_per_run may go up
to 20, but above 5 it needs max_research_cost_usd_per_run."""

import json
from decimal import Decimal as D

import pytest
import yaml

from conftest import T0
from guardrails import Config, ConfigError, load_config
from research import Estimate, ResearchError, research_contract
from runner import UNKNOWN_USAGE, research_cost_usd
from test_expiry_window import market
from test_research_and_report import CONTRACT, FakeClient, resp
from test_runner import by_kind, run

# $1.00 at the default prices: 200k input x $4/M = 0.80, 9k output x $20/M = 0.18, 2 searches x $0.01 = 0.02
DOLLAR = {"input_tokens": 200_000, "output_tokens": 9_000}


def est(usage=DOLLAR, searches=2, q="0.62"):
    return Estimate(D(q), "t", "r", [], [], False, "", [{"url": "https://a"}, {"url": "https://b"}],
                    "claude-opus-5-5", searches, dict(usage))


def researcher(calls, make=lambda: est()):
    def research(info, prior):
        calls.append(info["instrument_symbol"])
        r = make()
        if isinstance(r, Exception):
            raise r
        return r
    return research


def cost_entries(env):
    return [e for e in env.audit() if e["event"] == "research_cost"]


def write_prior(env, *rows):
    with open(env.audit_path, "a") as f:
        for ts, cost in rows:
            f.write(json.dumps({"ts": ts, "event": "research_cost", "mode": "live", "research_cost_usd": cost}) + "\n")


# ------------------------------------------------------------------ config


def write(tmp_path, **over):
    p = tmp_path / "config.yaml"
    p.write_text(yaml.safe_dump(over))
    return load_config(p)


def test_defaults_and_prices():
    c = Config()
    assert c.max_research_cost_usd_per_run is None and c.max_research_cost_usd_per_day is None
    assert (c.research_input_usd_per_mtok, c.research_output_usd_per_mtok, c.research_usd_per_search) == \
        (D("4"), D("20"), D("0.01"))


BOTH = {"max_research_cost_usd_per_run": 1, "max_research_cost_usd_per_day": 2}


def test_up_to_20_research_calls_with_both_cost_caps(tmp_path):
    assert write(tmp_path, max_research_per_run=20, **BOTH).max_research_per_run == 20
    assert write(tmp_path, max_research_per_run=5).max_research_per_run == 5  # no cap needed at 5 or fewer
    with pytest.raises(ConfigError, match="max_research_per_run"):
        write(tmp_path, max_research_per_run=21, **BOTH)


@pytest.mark.parametrize("n", [6, 10, 20])
def test_above_5_requires_both_cost_caps(tmp_path, n):
    with pytest.raises(ConfigError, match="max_research_cost_usd_per_run and max_research_cost_usd_per_day"):
        write(tmp_path, max_research_per_run=n)
    with pytest.raises(ConfigError, match="max_research_cost_usd_per_day"):
        write(tmp_path, max_research_per_run=n, max_research_cost_usd_per_run=1)  # the run cap alone isn't enough
    with pytest.raises(ConfigError, match="max_research_cost_usd_per_run"):
        write(tmp_path, max_research_per_run=n, max_research_cost_usd_per_day=2)  # nor the day cap alone


@pytest.mark.parametrize("key", ["max_research_cost_usd_per_run", "max_research_cost_usd_per_day"])
@pytest.mark.parametrize("bad", [0, -1, "x", True])
def test_cost_caps_must_be_positive(tmp_path, key, bad):
    with pytest.raises(ConfigError, match=key):
        write(tmp_path, **{key: bad})


def test_shipped_config_is_valid_and_capped():
    from pathlib import Path
    cfg = load_config(Path(__file__).resolve().parents[1] / "config.yaml")
    assert cfg.max_research_cost_usd_per_run == D("1") and cfg.max_research_cost_usd_per_day == D("2")


# ------------------------------------------------------------------ cost estimate


def test_cost_estimate():
    c = Config()
    assert research_cost_usd(DOLLAR, 2, c) == D("1.00")
    assert research_cost_usd({"input_tokens": 1_000_000, "output_tokens": 100_000}, 5, c) == D("6.05")
    assert research_cost_usd({}, 0, c) == 0


@pytest.mark.parametrize("usage", [None, "x", {"input_tokens": "lots"}, {"input_tokens": -5}, {"input_tokens": True}])
def test_unknown_or_bad_usage_is_charged_the_conservative_estimate(usage):
    c = Config()
    worst = research_cost_usd(UNKNOWN_USAGE, c.research_max_searches, c)
    assert worst >= D("1")  # 200k in + 16k out + every search
    assert research_cost_usd(usage, None, c) == worst


def test_research_error_carries_usage():
    client = FakeClient(resp("refusal"))
    with pytest.raises(ResearchError) as ei:
        research_contract(client, model="claude-opus-5-5", contract=CONTRACT, prior=None, now_iso="2026-01-01")
    assert ei.value.usage == {"input_tokens": 100, "output_tokens": 50} and ei.value.searches == 0
    assert ResearchError("x").usage is None  # unknown unless the loop got that far


# ------------------------------------------------------------------ runner


def test_every_research_call_is_costed_and_logged(env):
    market(env, 48, 48)
    calls = []
    decisions, *_ = run(env, research=researcher(calls))
    assert len(calls) == 2
    logged = cost_entries(env)
    assert [e["research_cost_usd"] for e in logged] == ["1.00", "1.00"]
    assert logged[0]["instrument_symbol"] == calls[0] and logged[0]["usage"] == DOLLAR and logged[0]["searches"] == 2
    end = by_kind(decisions, "run_end")[0]
    assert end["research_cost_usd"] == "2.00"


def test_per_run_cap_stops_research_and_logs_it(env):
    market(env, 48, 48, 48, 48)
    calls = []
    decisions, tools, *_ = run(env, research=researcher(calls), max_research_cost_usd_per_run=2.5)
    # after two $1 calls, the next ($1 projected from the costliest call so far) would pass $2.50
    assert len(calls) == 2
    stop = by_kind(decisions, "research_budget_reached")
    assert len(stop) == 1 and "max_research_cost_usd_per_run 2.5" in stop[0]["reason"]
    assert stop[0]["run_cost_usd"] == "2.00"
    skipped = [d for d in by_kind(decisions, "no_trade") if "research cost budget" in (d.get("reason") or "")]
    assert len(skipped) == 2
    assert len(cost_entries(env)) == 2


def test_per_day_cap_counts_earlier_runs_today(env):
    market(env, 48, 48)
    write_prior(env, ("2026-09-21T01:00:00.000+00:00", "3.00"), ("2026-09-21T02:00:00.000+00:00", "3.00"),
                ("2026-09-21T03:00:00.000+00:00", "3.00"),
                ("2026-09-20T23:59:59.000+00:00", "50.00"))  # yesterday: ignored
    calls = []
    decisions, *_ = run(env, research=researcher(calls), max_research_cost_usd_per_day=10)
    assert calls == []  # $9 spent today; the costliest call today ($3) would pass $10
    stop = by_kind(decisions, "research_budget_reached")
    assert len(stop) == 1 and "max_research_cost_usd_per_day 10" in stop[0]["reason"]
    assert stop[0]["day_cost_usd"] == "9.00"


def test_per_day_cap_allows_research_while_under(env):
    market(env, 48, 48)
    write_prior(env, ("2026-09-21T01:00:00.000+00:00", "1.00"))
    calls = []
    run(env, research=researcher(calls), max_research_cost_usd_per_day=10)
    assert len(calls) == 2


def test_day_cost_counts_both_modes(env):
    # Research is paid for in real money whether the run is DRY_RUN or live.
    market(env, 48)
    with open(env.audit_path, "a") as f:
        f.write(json.dumps({"ts": "2026-09-21T01:00:00.000+00:00", "event": "research_cost", "mode": "dry_run",
                            "research_cost_usd": "9.50"}) + "\n")
    calls = []
    run(env, research=researcher(calls), max_research_cost_usd_per_day=10)
    assert calls == []


def test_unreadable_cost_lines_do_not_lower_the_day_total(env):
    market(env, 48)
    with open(env.audit_path, "a") as f:
        f.write('{"ts": "2026-09-21T01:00:00.000+00:00", "event": "research_cost", "research_cost_usd": "NaN"}\n')
        f.write("garbage\n")
    write_prior(env, ("2026-09-21T02:00:00.000+00:00", "9.50"))
    calls = []
    run(env, research=researcher(calls), max_research_cost_usd_per_day=10)
    assert calls == []


def test_failed_research_is_still_charged(env):
    market(env, 48, 48, 48)
    calls = []
    err = ResearchError("declined")
    err.usage, err.searches = dict(DOLLAR), 2
    decisions, *_ = run(env, research=researcher(calls, lambda: err), max_research_cost_usd_per_run=2.5)
    assert len(calls) == 2 and [e["research_cost_usd"] for e in cost_entries(env)] == ["1.00", "1.00"]
    assert cost_entries(env)[0]["ok"] is False


def test_failed_research_with_unknown_usage_is_charged_conservatively(env):
    market(env, 48, 48)
    calls = []
    run(env, research=researcher(calls, lambda: ResearchError("APIConnectionError")),
        max_research_cost_usd_per_run=1)
    assert len(calls) == 1  # one unknown call (>= $1) uses up a $1 run budget
    assert D(cost_entries(env)[0]["research_cost_usd"]) >= D("1") and cost_entries(env)[0]["usage_known"] is False


def test_count_budget_still_applies(env):
    market(env, 48, 48, 48)
    calls = []
    run(env, research=researcher(calls), max_research_per_run=2)
    assert len(calls) == 2

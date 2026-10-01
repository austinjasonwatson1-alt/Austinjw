"""Two-stage research: an optional cheap screening estimate (small model from GEMINI_MCP_SCREEN_MODEL, default
claude-haiku-4-5, at most 1 web search). Only contracts whose screening estimate differs from the market mid by at
least screen_min_edge get full research. Both stages' costs and models are in audit.log. Off by default."""

from decimal import Decimal as D
from types import SimpleNamespace as NS

import pytest
import yaml

import runner
from conftest import EVENT
from guardrails import Config, ConfigError, load_config
from research import ResearchError, ScreenEstimate, screen_contract
from runner import research_cost_usd
from test_expiry_window import market
from test_research_and_report import CONTRACT, search_result
from test_research_budget import DOLLAR, est
from test_runner import by_kind, run

SCREEN_USAGE = {"input_tokens": 100_000, "output_tokens": 10_000}  # $0.10 + $0.05 at $1 / $5, + 1 search = $0.16


def sym(i):
    return f"GEMI-{EVENT}-C{i}"


def screener(calls, estimates, usage=SCREEN_USAGE):
    def screen(info):
        calls.append(info["instrument_symbol"])
        p = estimates[info["instrument_symbol"]]
        if isinstance(p, Exception):
            raise p
        return ScreenEstimate(D(p), "quick take", "claude-haiku-4-5", 1, dict(usage))
    return screen


def researcher(calls):
    def research(info, prior):
        calls.append(info["instrument_symbol"])
        return est()
    return research


def cost_entries(env):
    return [e for e in env.audit() if e["event"] == "research_cost"]


# ------------------------------------------------------------------ config


def test_defaults():
    c = Config()
    assert c.screening_enabled is False and c.screen_min_edge == D("0.08")
    assert (c.screen_input_usd_per_mtok, c.screen_output_usd_per_mtok) == (D("1"), D("5"))
    assert runner.DEFAULT_SCREEN_MODEL == "claude-haiku-4-5" and runner.SCREEN_MAX_SEARCHES == 1


def test_shipped_config_has_screening_off():
    from pathlib import Path
    raw = yaml.safe_load((Path(__file__).resolve().parents[1] / "config.yaml").read_text())
    assert raw["screening_enabled"] is False and raw["screen_min_edge"] == 0.08


@pytest.mark.parametrize("over,needle", [({"screen_min_edge": 1.5}, "screen_min_edge"),
                                         ({"screen_min_edge": -0.1}, "screen_min_edge"),
                                         ({"screening_enabled": "yes"}, "screening_enabled")])
def test_bad_screening_config(tmp_path, over, needle):
    p = tmp_path / "config.yaml"
    p.write_text(yaml.safe_dump(over))
    with pytest.raises(ConfigError, match=needle):
        load_config(p)


def test_screen_model_from_env():
    assert runner.screen_model_from_env({}) == "claude-haiku-4-5"
    assert runner.screen_model_from_env({"GEMINI_MCP_SCREEN_MODEL": ""}) == "claude-haiku-4-5"
    assert runner.screen_model_from_env({"GEMINI_MCP_SCREEN_MODEL": "claude-sonnet-5-5"}) == "claude-sonnet-5-5"
    with pytest.raises(ConfigError, match="GEMINI_MCP_SCREEN_MODEL"):
        runner.screen_model_from_env({"GEMINI_MCP_SCREEN_MODEL": "gpt-4; rm -rf"})


def test_screen_cost_uses_screen_prices():
    c = Config()
    assert research_cost_usd(SCREEN_USAGE, 1, c, stage="screen") == D("0.16")
    assert research_cost_usd(SCREEN_USAGE, 1, c) == D("0.61")  # full-research prices: 0.40 + 0.20 + 0.01
    unknown = research_cost_usd(None, None, c, stage="screen")
    assert D("0") < unknown < research_cost_usd(None, None, c)


# ------------------------------------------------------------------ the screening call


class Client:
    def __init__(self, *responses):
        self.responses, self.requests = list(responses), []
        self.messages = NS(create=self.create)
        self.beta = NS(messages=NS(create=self.fail))

    def create(self, **kw):
        self.requests.append(kw)
        return self.responses.pop(0)

    def fail(self, **kw):
        raise AssertionError("screening must not use the beta full-research path")


def resp(stop, *blocks, model="claude-haiku-4-5"):
    return NS(stop_reason=stop, content=list(blocks), model=model, usage=NS(input_tokens=1000, output_tokens=200))


def submit(p, reason="r"):
    return NS(type="tool_use", name="submit_screen", input={"probability_yes": p, "reason": reason})


def test_screen_contract_request_and_result():
    client = Client(resp("tool_use", NS(type="server_tool_use", name="web_search", input={}),
                         search_result("https://a.gov/1"), submit(0.7)))
    s = screen_contract(client, model="claude-haiku-4-5", contract=CONTRACT, now_iso="2026-09-21T00:00:00Z")
    assert s.probability_yes == D("0.7") and s.model == "claude-haiku-4-5" and s.searches == 1
    assert s.usage == {"input_tokens": 1000, "output_tokens": 200}
    req = client.requests[0]
    assert req["model"] == "claude-haiku-4-5"
    search = [t for t in req["tools"] if t.get("name") == "web_search"]
    assert search == [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}]
    assert not any(t.get("name") == "web_fetch" for t in req["tools"])
    for k in ("betas", "fallbacks", "output_config", "thinking"):
        assert k not in req  # small models reject these; screening keeps the request plain


@pytest.mark.parametrize("bad", [1.5, -0.1, "x", None])
def test_screen_rejects_bad_probabilities(bad):
    client = Client(resp("tool_use", submit(bad)))
    with pytest.raises(ResearchError) as ei:
        screen_contract(client, model="claude-haiku-4-5", contract=CONTRACT, now_iso="t")
    assert ei.value.usage == {"input_tokens": 1000, "output_tokens": 200}


def test_screen_refusal_carries_usage():
    client = Client(resp("refusal"))
    with pytest.raises(ResearchError) as ei:
        screen_contract(client, model="claude-haiku-4-5", contract=CONTRACT, now_iso="t")
    assert ei.value.usage["input_tokens"] == 1000


def test_screen_nudges_once_then_gives_up():
    client = Client(resp("end_turn", NS(type="text", text="hmm")), resp("end_turn", NS(type="text", text="hmm")))
    with pytest.raises(ResearchError, match="submit_screen"):
        screen_contract(client, model="claude-haiku-4-5", contract=CONTRACT, now_iso="t")
    assert len(client.requests) == 2


# ------------------------------------------------------------------ runner, screening off (default)


def test_off_by_default_the_screen_is_never_called(env):
    market(env, 48, 48)
    scr, full = [], []
    decisions, *_ = run(env, research=researcher(full), screen=screener(scr, {sym(0): "0.61", sym(1): "0.61"}))
    assert scr == [] and full == [sym(0), sym(1)]
    assert {e["stage"] for e in cost_entries(env)} == {"full"}


# ------------------------------------------------------------------ runner, screening on


def test_only_contracts_that_pass_the_screen_get_full_research(env):
    market(env, 48, 48, 48)  # book 0.60 / 0.62: market mid 0.61
    scr, full = [], []
    decisions, *_ = run(env, research=researcher(full), screening_enabled=True, max_order_usd=1,
                        screen=screener(scr, {sym(0): "0.65", sym(1): "0.75", sym(2): "0.45"}))
    assert scr == [sym(0), sym(1), sym(2)]
    assert full == [sym(1), sym(2)]  # 0.65 is within 0.08 of 0.61; 0.75 and 0.45 aren't (either direction)
    out = [d for d in by_kind(decisions, "no_trade") if "screened out" in (d.get("reason") or "")]
    assert len(out) == 1 and out[0]["instrument_symbol"] == sym(0)
    assert out[0]["screen_estimate"] == "0.65" and out[0]["screen_market_mid"] == "0.61"
    assert out[0]["screen_model"] == "claude-haiku-4-5" and out[0]["screen_cost_usd"] == "0.16"
    costs = cost_entries(env)
    assert [(e["stage"], e["instrument_symbol"]) for e in costs] == [
        ("screen", sym(0)), ("screen", sym(1)), ("full", sym(1)), ("screen", sym(2)), ("full", sym(2))]
    assert {e["model"] for e in costs if e["stage"] == "screen"} == {"claude-haiku-4-5"}
    assert {e["model"] for e in costs if e["stage"] == "full"} == {"claude-opus-5-5"}
    assert [e["research_cost_usd"] for e in costs if e["stage"] == "screen"] == ["0.16"] * 3
    passed = [d for d in decisions if d.get("instrument_symbol") == sym(1) and d["kind"] in ("entry", "no_trade")]
    assert passed and passed[0]["screen_model"] == "claude-haiku-4-5" and passed[0]["screen_cost_usd"] == "0.16"
    assert passed[0]["research_model"] == "claude-opus-5-5" and passed[0]["research_cost_usd"] == "1.00"


def test_screen_threshold_is_configurable(env):
    market(env, 48)
    scr, full = [], []
    run(env, research=researcher(full), screening_enabled=True, screen_min_edge=0.03,
        screen=screener(scr, {sym(0): "0.65"}))
    assert full == [sym(0)]


def test_failed_screen_skips_full_research_and_is_charged(env):
    market(env, 48)
    scr, full = [], []
    err = ResearchError("declined", usage=dict(SCREEN_USAGE), searches=1)
    decisions, *_ = run(env, research=researcher(full), screening_enabled=True,
                        screen=screener(scr, {sym(0): err}))
    assert full == [] and "screening failed" in by_kind(decisions, "no_trade")[0]["reason"]
    assert [(e["stage"], e["ok"]) for e in cost_entries(env)] == [("screen", False)]


def test_screening_enabled_without_a_screener_fails_closed(env):
    market(env, 48)
    full = []
    decisions, *_ = run(env, research=researcher(full), screening_enabled=True)
    assert full == [] and "no screening model" in by_kind(decisions, "no_trade")[0]["reason"]


def test_screening_counts_toward_the_cost_caps_not_the_call_count(env):
    market(env, 48, 48, 48)
    scr, full = [], []
    run(env, research=researcher(full), screening_enabled=True, max_research_per_run=1,
        screen=screener(scr, {sym(i): "0.61" for i in range(3)}))
    assert len(scr) == 3 and full == []  # three screens, all screened out; the call budget isn't used
    scr2 = []
    env.audit_path.unlink()
    run(env, research=researcher([]), screening_enabled=True, max_research_cost_usd_per_run=0.3,
        screen=screener(scr2, {sym(i): "0.61" for i in range(3)}))
    assert len(scr2) == 1  # 0.16 spent; another (~0.16) would pass 0.30


def test_position_review_is_never_screened(env):
    import inspect
    src = inspect.getsource(runner.Runner.review_positions)
    assert "screen" not in src


def test_preflight_checks_the_screening_model(tmp_path):
    from test_micro_live_profile import BASE, pf
    from test_preflight import DRY
    data = {**BASE, "screening_enabled": True}
    fails, notes = pf(tmp_path, {**DRY, "GEMINI_MCP_SCREEN_MODEL": "not a model"}, data, marker=False)
    assert any("GEMINI_MCP_SCREEN_MODEL" in f for f in fails)
    fails, notes = pf(tmp_path, DRY, data, marker=False)
    assert not any("GEMINI_MCP_SCREEN_MODEL" in f for f in fails)
    assert any("claude-haiku-4-5 screens contracts" in n for n in notes)

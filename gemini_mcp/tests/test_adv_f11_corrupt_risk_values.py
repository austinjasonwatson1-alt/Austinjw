"""F11: a corrupt value inside state/risk_state.json (valid JSON, bad number) raised InvalidOperation out of
propose, unaudited, instead of a logged fail-closed rejection."""

import json

import pytest

from conftest import SYMBOL


@pytest.mark.parametrize("st", [{"peak": "abc", "day": "2026-09-21", "day_start": "1000"},
                                {"peak": "1000", "day": "2026-09-21", "day_start": "NaN"},
                                {"peak": "1000", "initial_equity": "zzz"},
                                ["not", "a", "dict"]])
def test_corrupt_risk_values_are_logged_rejections(env, st):
    env.risk_path.parent.mkdir(parents=True, exist_ok=True)
    env.risk_path.write_text(json.dumps({"sandbox:live": st}))
    r = env.guard().propose(SYMBOL, "yes", "buy", "2", "0.50")
    assert r["ok"] is False and "risk state" in r["reason"], r
    assert env.audit()[-1]["event"] == "rejection"

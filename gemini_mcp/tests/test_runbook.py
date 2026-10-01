"""RUNBOOK.md stays in sync with the code: every audit event, order_result value and decision kind is documented."""

import re
from pathlib import Path

import report

ROOT = Path(__file__).resolve().parents[1]
RUNBOOK = (ROOT / "RUNBOOK.md").read_text()


def code(name):
    return (ROOT / name).read_text()


def test_every_audit_event_is_documented():
    events = set(re.findall(r'audit\.write\(\s*"([a-z_]+)"', code("guardrails.py") + code("runner.py")))
    events |= {"proposal", "kill_detected", "kill_deleted", "breaker_reset"}  # written via variables
    assert events >= {"confirmation", "order_intent", "order_result", "rejection", "would_place", "decision"}
    for e in events:
        assert f"`{e}`" in RUNBOOK, e


def test_every_order_result_and_decision_kind_is_documented():
    results = set(re.findall(r'"(placed|failed|unconfirmed|cancelled|cancel_failed)"', code("guardrails.py")))
    kinds = set(re.findall(r'self\.log\(\s*"([a-z_]+)"', code("runner.py"))) | {"entry", "exit", "run_skipped"}
    kinds |= {f"{k}_failed" for k in ("entry", "exit")}
    for k in results | kinds:
        assert f"`{k}`" in RUNBOOK, k


def test_going_live_threshold_matches_report():
    assert f"N ≥ {report.MIN_N}" in RUNBOOK and f"N<{report.MIN_N}" in RUNBOOK
    for label, *_ in [(b[2],) for b in report.BUCKETS]:
        assert label.replace("-", "–").replace("edge < ", "under ") in RUNBOOK or label in RUNBOOK


def test_going_live_criteria_are_the_agreed_ones():
    sec = RUNBOOK[RUNBOOK.index("## 8. Going-live criteria"):]
    flat = sec.replace("**", "").lower()
    for needle in ("at least 4 weeks of paper trading", "at least 30 settled trades",
                   "Brier score beats the market's on the traded contracts",
                   "positive return after confirmed fees", "fee_confirmed: true",
                   "never past half of `max_drawdown_pct`", "worst drawdown seen",
                   "Failing any criterion means keep paper trading",
                   "manual confirmation", "small size", "human check of the fill against Gemini's site"):
        assert needle.replace("**", "").lower() in flat, needle
    assert "Q8" not in sec  # no longer a proposal awaiting confirmation


def _fast_track():
    start = RUNBOOK.index("## 9. Fast track")
    nxt = RUNBOOK.find("\n## ", start + 1)
    return RUNBOOK[start:nxt if nxt != -1 else None]


def test_fast_track_gates_are_the_agreed_ones():
    flat = _fast_track().replace("**", "").replace("`", "").lower()
    for needle in ("micro-live may start after", "clean dry run", "verify_auth", "capture_samples",
                   "scale up only after about 20 settled trades", "no unexplained fill/fee differences",
                   "auto-confirm only after about 15 clean hand-confirmed live trades",
                   "still keeps every breaker, cap, and the endpoint allowlist",
                   "profile: micro_live", "learning_budget_usd", "allow_above_micro_live",
                   "live fills consistently worse than paper assumed"):
        assert needle in flat, needle


def test_fast_track_states_the_preflight_ceilings():
    import preflight
    flat = _fast_track().replace("`", "")
    for key, limit in preflight.MICRO_LIVE_CEILINGS.items():
        value = str(limit).lower() if isinstance(limit, bool) else str(limit)
        assert f"{key} {value}" in flat or f"{key}: {value}" in flat, key


def test_going_live_section_points_to_the_fast_track():
    sec = RUNBOOK[RUNBOOK.index("## 8. Going-live criteria"):RUNBOOK.index("## 9. Fast track")]
    assert "Fast track" in sec and "No exceptions" not in sec
    assert "max_order_usd: 2" not in sec  # live size now comes from the micro_live profile

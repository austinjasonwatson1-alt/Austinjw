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

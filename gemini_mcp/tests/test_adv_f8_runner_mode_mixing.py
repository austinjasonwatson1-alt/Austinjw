"""F8: the runner's prior research lookup mixed paper and live records from paper_ledger.json, so a live
position review could use a paper entry's estimate (and vice versa)."""

from decimal import Decimal

from conftest import SYMBOL
from guardrails import AuditLog, Config, PaperLedger
from runner import Runner


def make(tmp_path, dry_run):
    paper = PaperLedger(tmp_path / "paper_ledger.json", Decimal("100"))
    return Runner(tools=None, research=None, config=Config(), audit=AuditLog(tmp_path / "a.log"), paper=paper,
                  dry_run=dry_run, confirm=lambda p: True), paper


def rec(ref, q_adj, ts):
    return {"kind": "entry", "instrument_symbol": SYMBOL, "outcome": "yes", "order_ref": ref, "q_adj": q_adj,
            "ts": ts}


def test_live_review_ignores_paper_research(tmp_path):
    r, paper = make(tmp_path, dry_run=False)
    paper.attach_research("paper-1", rec("paper-1", "0.90", "2026-09-30T00:00:00+00:00"))
    assert r.prior_for(SYMBOL, "yes") is None
    paper.attach_research("live:5", rec("live:5", "0.60", "2026-09-29T00:00:00+00:00"))
    assert r.prior_for(SYMBOL, "yes")["order_ref"] == "live:5"


def test_paper_review_ignores_live_research(tmp_path):
    r, paper = make(tmp_path, dry_run=True)
    paper.attach_research("live:5", rec("live:5", "0.60", "2026-09-30T00:00:00+00:00"))
    assert r.prior_for(SYMBOL, "yes") is None

"""Task 5: dashboard.py is read-only, offline, escapes untrusted text, and shows what needs attention."""

import hashlib
import json
import re
import socket
import subprocess
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest

import dashboard
import report
from conftest import Clock
from fake_gemini import FakeGemini
from test_e2e_fake import World, estimate

ROOT = Path(__file__).resolve().parents[1]


def snapshot(root: Path) -> dict[str, tuple[str, int]]:
    return {str(p.relative_to(root)): (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns)
            for p in root.rglob("*") if p.is_file()}


@pytest.fixture
def desk(tmp_path):
    """A state dir with real runner/server history: entries, an unknown order, a breaker trip and KILL."""
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True)
    fake.fail_next("/v1/prediction-markets/order", "timeout_after_apply")  # the first placement's outcome is lost
    w.run()
    w.clock.t += 86400
    w.run(research=lambda info, prior: estimate(0.9))
    w.clock.t += 86400
    fake.set_cash("600")
    # every contract has a resting order by now, so the runner proposes nothing; one manual proposal trips the breaker
    assert not w.guard.propose("GEMI-NBAFINALS-BOS", "yes", "buy", "1", "0.42")["ok"]
    w.run()
    (tmp_path / "report.json").write_text(json.dumps({
        "buckets": [{"bucket": "5-10%", "n_scored": 12, "low_n": True, "brier_mine": "0.2100", "brier_market": "0.2300"},
                    {"bucket": "ALL", "n_scored": 40, "low_n": False, "brier_mine": "0.1900", "brier_market": "0.2000"}],
        "all_estimates": {"n_scored": 3, "low_n": True, "brier_mine": "0.1000", "brier_market": "0.2000",
                          "points": [{"p_yes": "0.8", "market": "0.6", "won": True},
                                     {"p_yes": "0.85", "market": "0.7", "won": True},
                                     {"p_yes": "0.2", "market": "0.4", "won": False}]}}))
    return tmp_path, w


def test_never_writes_inputs_and_never_touches_the_network(desk, monkeypatch):
    root, _ = desk
    before = snapshot(root)

    def no_network(*a, **k):
        raise AssertionError("dashboard tried to open a socket")

    monkeypatch.setattr(socket, "socket", no_network)
    monkeypatch.setattr(socket, "create_connection", no_network)
    assert dashboard.main(["--root", str(root)]) == 0
    after = snapshot(root)
    assert set(after) - set(before) == {"dashboard.html"}
    assert {k: v for k, v in after.items() if k != "dashboard.html"} == before


def test_dashboard_imports_no_http_client():
    code = ("import sys; sys.path.insert(0, '.'); import dashboard; "
            "print(sorted(m for m in ('httpx', 'gemini_client', 'anthropic', 'websockets', 'requests', 'urllib3') "
            "if m in sys.modules))")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    assert out.strip() == "[]"
    m = dashboard.build_model(dashboard.load_inputs(ROOT / "nonexistent"))
    dashboard.render(m)  # building also mustn't pull them in
    out = subprocess.run([sys.executable, "-c", code.replace("import dashboard;", "import dashboard; "
                          "from pathlib import Path; dashboard.render(dashboard.build_model(dashboard.load_inputs(Path('.'))));")],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout
    assert out.strip() == "[]"


@pytest.mark.parametrize("target", ["audit.log", "KILL", "config.yaml", "paper_ledger.json", ".env", "report.json",
                                    "state/risk_state.json", "state/new.html", "out.txt"])
def test_refuses_to_write_over_inputs_or_into_state(desk, target, capsys):
    root, _ = desk
    before = snapshot(root)
    assert dashboard.main(["--root", str(root), "--out", str(root / target)]) == 2
    assert snapshot(root) == before


def test_untrusted_text_is_escaped(tmp_path):
    evil = '<script>alert(1)</script><img src=x onerror=alert(2)>'
    entries = [
        {"ts": "2026-09-21T10:00:00.000+00:00", "event": "decision", "kind": "run_start", "mode": "live",
         "risk": {"mode": "LIVE (sandbox): test funds", "equity_usd": "100", "peak_equity_usd": "100",
                  "equity_floor_usd": "60"}},
        {"ts": "2026-09-21T10:01:00.000+00:00", "event": "decision", "kind": "no_trade", "mode": "live",
         "instrument_symbol": "GEMI-X</script><script>alert(3)</script>", "reason": evil, "thesis": evil,
         "estimate": "0.5", "sources": [{"url": "javascript:alert(4)", "title": evil},
                                        {"url": "https://ok.example/a?b=<c>", "title": "fine"},
                                        {"url": "data:text/html,<script>alert(5)</script>", "title": "d"}]},
        {"ts": "2026-09-21T10:02:00.000+00:00", "event": "decision", "kind": "run_start", "mode": "live",
         "risk": {"mode": "LIVE (sandbox): test funds", "equity_usd": "90", "peak_equity_usd": "100",
                  "equity_floor_usd": "60</script><script>alert(6)</script>"}},
    ]
    (tmp_path / "audit.log").write_text("\n".join(json.dumps(e) for e in entries))
    (tmp_path / "KILL").write_text(evil)
    page = dashboard.render(dashboard.build_model(dashboard.load_inputs(tmp_path)))
    scripts = re.findall(r"<script\b[^>]*>(.*?)</script>", page, flags=re.S)
    assert all("alert(" not in s for s in scripts)
    assert "<img" not in page and "onerror=alert" not in page.replace("onerror=alert(2)&gt;", "")
    assert 'href="javascript:' not in page and 'href="data:' not in page
    assert 'href="https://ok.example/a?b=&lt;c&gt;"' in page
    assert 'rel="noopener noreferrer nofollow"' in page


def test_page_is_self_contained_with_a_network_blocking_csp(desk):
    root, _ = desk
    page = dashboard.render(dashboard.build_model(dashboard.load_inputs(root)))
    assert "connect-src 'none'" in page and "default-src 'none'" in page
    for tag in re.findall(r"<(?:script|link|img|iframe|object|embed|source|audio|video)\b[^>]*>", page):
        assert not re.search(r"""(src|href)\s*=\s*["']?(https?:)?//""", tag), tag
    assert "@import" not in page and "url(http" not in page


def test_shows_what_needs_attention(desk):
    root, w = desk
    m = dashboard.build_model(dashboard.load_inputs(root))
    titles = " | ".join(a["title"] for a in m.attention)
    assert "KILL file present" in titles
    assert "Order with unknown outcome" in titles
    assert "Circuit breaker trip" in titles
    page = dashboard.render(m)
    for text in ("Needs attention", "unknown, check Gemini", "Equity, peak and floor", "Today vs limits",
                 "Open positions", "Decisions", "Calibration", "Brier score", "Research by contract", "N=40"):
        assert text in page, text
    assert m.mode_key == "sandbox:live" and len(m.equity_series) >= 3
    assert m.limits["max_trades"] == 10


def test_thin_book_skips_are_counted(tmp_path):
    e = {"ts": "2026-09-21T10:00:00.000+00:00", "event": "decision", "kind": "no_trade", "mode": "dry_run",
         "instrument_symbol": "S", "reason": "thin book: 3 contracts at or better than 0.5, need 10"}
    (tmp_path / "audit.log").write_text("\n".join(json.dumps(e) for _ in range(3)))
    m = dashboard.build_model(dashboard.load_inputs(tmp_path),
                              now=datetime(2026, 9, 21, 12, tzinfo=timezone.utc))
    thin = [a for a in m.attention if "thin book" in a["title"]]
    assert thin and thin[0]["detail"].startswith("3 today")


def test_empty_state_renders(tmp_path):
    page = dashboard.render(dashboard.build_model(dashboard.load_inputs(tmp_path)))
    assert "NO DATA YET" in page and "Nothing needs attention" not in page  # config.yaml missing is flagged
    assert "config.yaml not found" in page


def test_calibration_bins():
    pts = [(Decimal("0.81"), Decimal("0.6"), True), (Decimal("0.89"), Decimal("0.62"), False),
           (Decimal("0.15"), None, False), (Decimal("1"), Decimal("0.99"), True)]
    cal = dashboard.calibration_bins(pts)
    mine = {b["bin"]: b for b in cal["mine"]}
    assert mine[8]["n"] == 2 and mine[8]["observed"] == 0.5 and abs(mine[8]["predicted"] - 0.85) < 1e-9
    assert mine[9]["n"] == 1 and mine[1]["observed"] == 0.0
    assert sum(b["n"] for b in cal["market"]) == 3  # one point had no market price


def test_report_estimate_brier_exposes_scored_points():
    e = {"event": "decision", "ts": "2026-10-01T09:00:00", "kind": "no_trade", "instrument_symbol": "A",
         "event_ticker": "EV", "estimate": "0.80", "book": {"best_bid": "0.49", "best_ask": "0.51"}}
    out = report.estimate_brier([e], lambda ev, sym: "yes")
    assert out["points"] == [{"symbol": "A", "day": "2026-10-01", "p_yes": "0.80", "market": "0.50", "won": True}]


def test_live_positions_come_from_the_latest_run_only(tmp_path):
    def ev(kind, ts, **kw):
        return {"ts": ts, "event": "decision", "kind": kind, "mode": "live", **kw}

    risk = {"mode": "LIVE (sandbox): test funds", "equity_usd": "100"}
    entries = [ev("run_start", "2026-09-20T10:00", risk=risk),
               ev("hold", "2026-09-20T10:01", instrument_symbol="OLD", outcome="yes", held_quantity="5"),
               ev("run_start", "2026-09-21T10:00", risk=risk),
               ev("hold", "2026-09-21T10:01", instrument_symbol="NEW", outcome="no", held_quantity="2")]
    (tmp_path / "audit.log").write_text("\n".join(json.dumps(e) for e in entries))
    m = dashboard.build_model(dashboard.load_inputs(tmp_path))
    assert [p["symbol"] for p in m.positions] == ["NEW"]


def test_limits_show_buys_and_exits_separately(tmp_path):
    (tmp_path / "config.yaml").write_text("max_trades_per_day: 4\nmax_exits_per_day: 7\n")
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "daily_spend.json").write_text(json.dumps({
        "version": 2, "spend": {"sandbox:live": {"2026-09-21": "3"}}, "trades": {"sandbox:live": {"2026-09-21": 2}},
        "exits": {"sandbox:live": {"2026-09-21": 5}}}))
    (tmp_path / "audit.log").write_text(json.dumps({"ts": "2026-09-21T10:00:00", "event": "rejection",
                                                    "mode": "LIVE (sandbox): test funds"}))
    m = dashboard.build_model(dashboard.load_inputs(tmp_path), now=datetime(2026, 9, 21, 12, tzinfo=timezone.utc))
    assert (m.limits["trades"], m.limits["max_trades"], m.limits["exits"], m.limits["max_exits"]) == (2, 4, 5, 7)
    page = dashboard.render(m)
    assert "Buys placed today" in page and "Exits placed today" in page and "5 of 7" in page

"""The launchd job is for DRY_RUN only: it sets GEMINI_MCP_SCHEDULE=dry_run_only, and the runner refuses to start
if that is set while DRY_RUN isn't dry, before preflight, research or the server are touched."""

import plistlib
from pathlib import Path

import pytest

import runner

ROOT = Path(__file__).resolve().parents[1]
PLIST = ROOT / "launchd" / "com.gemini-mcp.dryrun.plist.template"


@pytest.mark.parametrize("dry", ["false", "False", "0", "no"])
def test_schedule_marker_refuses_anything_but_dry_run(monkeypatch, dry, capsys):
    monkeypatch.setattr(runner, "HERE", ROOT / "does-not-exist")  # no .env is read
    monkeypatch.setenv("GEMINI_MCP_SCHEDULE", "dry_run_only")
    monkeypatch.setenv("DRY_RUN", dry)
    started = []
    monkeypatch.setattr(runner, "run_with_server", lambda *a, **k: started.append(1))
    import preflight
    monkeypatch.setattr(preflight, "enforce", lambda *a, **k: started.append("preflight") or True)
    assert runner.main([]) == 3
    assert started == []
    assert "dry_run_only" in capsys.readouterr().err


def test_schedule_marker_allows_dry_run(monkeypatch):
    import anthropic
    import preflight
    monkeypatch.setattr(runner, "HERE", ROOT)
    monkeypatch.setenv("GEMINI_MCP_SCHEDULE", "dry_run_only")
    monkeypatch.setenv("DRY_RUN", "true")
    monkeypatch.setattr(preflight, "enforce", lambda *a, **k: True)
    monkeypatch.setattr(anthropic, "Anthropic", lambda *a, **k: object())
    ran = []

    async def fake_run(make):
        ran.append(1)
        return []

    monkeypatch.setattr(runner, "run_with_server", fake_run)
    assert runner.main([]) == 0 and ran == [1]


def test_unknown_schedule_marker_value_refuses(monkeypatch):
    monkeypatch.setenv("GEMINI_MCP_SCHEDULE", "live_please")
    monkeypatch.setenv("DRY_RUN", "true")
    monkeypatch.setattr(runner, "HERE", ROOT / "does-not-exist")
    assert runner.main([]) == 3


def test_plist_template_is_dry_run_only_and_disabled():
    text = PLIST.read_text()
    p = plistlib.loads(text.encode())
    assert p["Disabled"] is True
    env = p["EnvironmentVariables"]
    assert env["DRY_RUN"] == "true" and env["GEMINI_MCP_SCHEDULE"] == "dry_run_only"
    args = p["ProgramArguments"]
    assert args[-1].endswith("runner.py") and not any("auto-confirm" in a for a in args)
    assert "ANTHROPIC_API_KEY" not in env and not any("KEY" in k or "SECRET" in k for k in env)
    assert "DRY_RUN ONLY" in text and "launchd/README.md" in text
    note = (ROOT / "launchd" / "README.md").read_text()
    for needle in ("--auto-confirm", "runner_auto_confirm_live: true", "DRY_RUN=false", "Disabled", "exit code 3"):
        assert needle in note  # what live scheduling would need, and why this one can't be live

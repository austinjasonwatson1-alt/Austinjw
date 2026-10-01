"""launchd/validate_plist.py: plistlib-based validation of the launchd job (plutil isn't available off macOS),
checking launchd's own structure rules and the DRY_RUN-only rules, for the template and an installed copy."""

import plistlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "launchd"))
import validate_plist as vp  # noqa: E402

TEMPLATE = ROOT / "launchd" / "com.gemini-mcp.dryrun.plist.template"


def load():
    return plistlib.loads(TEMPLATE.read_bytes())


def installed(tmp_path, **changes):
    """A filled-in copy like ~/Library/LaunchAgents/com.gemini-mcp.dryrun.plist, pointing at real paths."""
    gm = tmp_path / "gemini_mcp"
    (gm / ".venv" / "bin").mkdir(parents=True)
    py = gm / ".venv" / "bin" / "python"
    py.write_text("#!/bin/sh\n")
    py.chmod(0o755)
    (gm / "runner.py").write_text("")
    logs = tmp_path / "Logs"
    logs.mkdir()
    text = (TEMPLATE.read_text().replace("/ABS/PATH/gemini_mcp", str(gm))
            .replace("/Users/YOUR_USER/Library/Logs/gemini_mcp", str(logs)))
    d = plistlib.loads(text.encode())
    d.update(changes)
    out = tmp_path / "com.gemini-mcp.dryrun.plist"
    out.write_bytes(plistlib.dumps(d))
    return out


def test_template_is_valid_as_a_template():
    assert vp.validate(TEMPLATE, template=True) == []


def test_template_is_not_installable_as_is():
    errors = vp.validate(TEMPLATE, template=False)
    assert any("/ABS/PATH" in e for e in errors) and any("YOUR_USER" in e for e in errors)


def test_filled_in_copy_is_valid(tmp_path):
    assert vp.validate(installed(tmp_path), template=False) == []


@pytest.mark.parametrize("change,needle", [
    ({"Label": 5}, "Label"),
    ({"Disabled": "yes"}, "Disabled"),
    ({"ProgramArguments": "python runner.py"}, "ProgramArguments"),
    ({"ProgramArguments": ["python", "runner.py"]}, "absolute"),
    ({"StartCalendarInterval": [{"Hour": 25, "Minute": 5}]}, "Hour"),
    ({"StartCalendarInterval": [{"Hour": 9, "Minute": "5"}]}, "Minute"),
    ({"StartCalendarInterval": [{"Hour": 9, "Second": 5}]}, "Second"),
    ({"RunAtLoad": 1}, "RunAtLoad"),
    ({"EnvironmentVariables": {"DRY_RUN": "false", "GEMINI_MCP_SCHEDULE": "dry_run_only"}}, "DRY_RUN"),
    ({"EnvironmentVariables": {"DRY_RUN": "true"}}, "GEMINI_MCP_SCHEDULE"),
    ({"EnvironmentVariables": {"DRY_RUN": "true", "GEMINI_MCP_SCHEDULE": "dry_run_only", "GEMINI_API_KEY": "x"}},
     "secret"),
    ({"EnvironmentVariables": {"DRY_RUN": True, "GEMINI_MCP_SCHEDULE": "dry_run_only"}}, "string"),
    ({"KeepAlive": True}, "KeepAlive"),
])
def test_bad_plists_are_rejected(tmp_path, change, needle):
    errors = vp.validate(installed(tmp_path, **change), template=False)
    assert errors and any(needle in e for e in errors), errors


def test_auto_confirm_is_rejected(tmp_path):
    d = load()
    p = installed(tmp_path, ProgramArguments=[x.replace("/ABS/PATH/gemini_mcp", str(tmp_path / "gemini_mcp"))
                                              for x in d["ProgramArguments"]] + ["--auto-confirm"])
    assert any("auto-confirm" in e for e in vp.validate(p, template=False))


def test_missing_program_or_log_dir_is_reported(tmp_path):
    p = installed(tmp_path)
    (tmp_path / "gemini_mcp" / "runner.py").unlink()
    (tmp_path / "Logs").rmdir()
    errors = vp.validate(p, template=False)
    assert any("runner.py" in e for e in errors) and any("log" in e.lower() for e in errors)


def test_not_a_plist_is_reported(tmp_path):
    p = tmp_path / "x.plist"
    p.write_text("<plist><dict><key>Label</key>")
    assert any("not a valid plist" in e for e in vp.validate(p, template=False))


def test_cli_exit_codes(tmp_path, capsys):
    assert vp.main([str(installed(tmp_path))]) == 0
    assert "OK" in capsys.readouterr().out
    assert vp.main(["--template", str(TEMPLATE)]) == 0
    assert vp.main([str(TEMPLATE)]) == 1
    assert "/ABS/PATH" in capsys.readouterr().out

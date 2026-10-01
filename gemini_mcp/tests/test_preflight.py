"""preflight.py: every check, plus server/runner startup enforcement."""

import json
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

import preflight
import verify_auth

GOOD = {"allowed_event_tickers": ["FEDJAN26"], "starting_balance_usd": 100, "fee_confirmed": True}
DRY = {"DRY_RUN": "true"}
LIVE = {"DRY_RUN": "false"}


def git(cwd, *args):
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=cwd, check=True,
                   capture_output=True)


@pytest.fixture
def repo(tmp_path):
    """A git repo with the project in gm/ and a .gitignore like the real one."""
    git(tmp_path, "init", "-q")
    (tmp_path / ".gitignore").write_text(".env\nstate/\n")
    here = tmp_path / "gm"
    here.mkdir()

    def config(**over):
        (here / "config.yaml").write_text(yaml.safe_dump({**GOOD, **over}))

    def marker(env="sandbox", age_s=60.0):
        verify_auth.write_marker(env, here)
        m = here / "state" / "verify_auth_ok.json"
        data = json.loads(m.read_text())
        data["epoch"] = time.time() - age_s
        m.write_text(json.dumps(data))

    config()
    return SimpleNamespace(here=here, config=config, marker=marker)


def test_good_setup_passes_dry_and_live(repo):
    assert preflight.check(DRY, repo.here) == []
    repo.marker()
    assert preflight.check(LIVE, repo.here) == []


@pytest.mark.parametrize("over,needle", [
    ({"starting_balance_usd": None}, "starting_balance_usd"),
    ({"fee_confirmed": False}, "fee_confirmed"),
    ({"allowed_event_tickers": []}, "allowed_event_tickers"),
    ({"max_order_pct_of_balance": 0.16}, "max_order_pct_of_balance"),
    ({"max_daily_spend_pct": 0.51}, "max_daily_spend_pct"),
    ({"max_drawdown_pct": 0.36}, "max_drawdown_pct"),
    ({"equity_floor_pct": 0.39}, "equity_floor_pct"),
    ({"equity_floor_pct": 0}, "equity_floor_pct"),
    ({"kelly_multiplier": 0.51}, "kelly_multiplier"),
    ({"max_order_usd": "lots"}, "config.yaml"),
])
def test_each_config_failure(repo, over, needle):
    repo.config(**over)
    for environ in (DRY, LIVE):
        repo.marker()
        fails = preflight.check(environ, repo.here)
        assert len(fails) == 1 and needle in fails[0], fails


def test_bounds_are_inclusive(repo):
    repo.config(max_order_pct_of_balance=0.15, max_daily_spend_pct=0.5, max_drawdown_pct=0.35,
                equity_floor_pct=0.4, kelly_multiplier=0.5)
    assert preflight.check(DRY, repo.here) == []


def test_zero_deposit_is_rejected(repo):
    repo.config(starting_balance_usd=0)  # config itself refuses <= 0
    fails = preflight.check(DRY, repo.here)
    assert fails and "starting_balance_usd" in fails[0]


def test_verify_auth_marker_required_only_live(repo):
    assert preflight.check(DRY, repo.here) == []
    fails = preflight.check(LIVE, repo.here)
    assert len(fails) == 1 and "verify_auth.py has not succeeded" in fails[0]


@pytest.mark.parametrize("env,age,needle", [("sandbox", 25 * 3600, "24 h"), ("production", 60, "GEMINI_ENV"),
                                            ("sandbox", -3600, "future")])
def test_stale_wrong_env_or_future_marker_fails_live(repo, env, age, needle):
    repo.marker(env=env, age_s=age)
    fails = preflight.check(LIVE, repo.here)
    assert len(fails) == 1 and needle in fails[0], fails


def test_corrupt_marker_fails_live(repo):
    (repo.here / "state").mkdir()
    (repo.here / "state" / "verify_auth_ok.json").write_text("{nope")
    assert "unreadable" in preflight.check(LIVE, repo.here)[0]


def test_production_marker_matches_production(repo):
    repo.marker(env="production")
    assert preflight.check({**LIVE, "GEMINI_ENV": "production"}, repo.here) == []


def test_tracked_env_fails(repo):
    (repo.here / ".env").write_text("GEMINI_API_KEY=x\n")
    git(repo.here, "add", "-f", ".env")
    fails = preflight.check(DRY, repo.here)
    assert any("tracked by git" in f for f in fails), fails


def test_env_not_gitignored_fails(repo):
    (repo.here.parent / ".gitignore").write_text("state/\n")
    fails = preflight.check(DRY, repo.here)
    assert any(".env is not covered by .gitignore" in f for f in fails), fails


@pytest.mark.parametrize("name", ["api.pem", "gemini.key", ".env.production"])
def test_key_file_on_disk_not_ignored_fails(repo, name):
    (repo.here / name).write_text("x")
    fails = preflight.check(DRY, repo.here)
    assert any(name in f for f in fails), fails
    (repo.here.parent / ".gitignore").write_text(f".env\nstate/\n{name}\n")
    assert preflight.check(DRY, repo.here) == []


def test_env_example_is_allowed(repo):
    (repo.here / ".env.example").write_text("GEMINI_API_KEY=\n")
    git(repo.here, "add", ".env.example")
    assert preflight.check(DRY, repo.here) == []


def test_not_a_git_repo_fails(tmp_path):
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(GOOD))
    fails = preflight.check(DRY, tmp_path)
    assert len(fails) == 1 and "git" in fails[0]


def test_malformed_dry_run_is_treated_as_live(repo):
    assert preflight.is_live({"DRY_RUN": "False"})
    fails = preflight.check({"DRY_RUN": "False"}, repo.here)
    assert any("DRY_RUN" in f for f in fails) and any("verify_auth" in f for f in fails)


def test_enforce_blocks_live_and_warns_dry(repo, capsys):
    repo.config(fee_confirmed=False)
    import sys
    assert preflight.enforce(DRY, repo.here, out=sys.stdout) is True
    assert "warnings" in capsys.readouterr().out
    assert preflight.enforce(LIVE, repo.here, out=sys.stdout) is False
    out = capsys.readouterr().out
    assert "refusing to start" in out and "fee_confirmed" in out


def test_shipped_config_fails_preflight():
    here = Path(preflight.__file__).resolve().parent
    fails = " ".join(preflight.check(DRY, here))
    for needle in ("starting_balance_usd", "fee_confirmed", "allowed_event_tickers"):
        assert needle in fails


def test_verify_auth_success_writes_marker_preflight_accepts(repo, monkeypatch, capsys):
    monkeypatch.setattr(verify_auth, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(verify_auth, "HERE", repo.here)
    monkeypatch.setenv("GEMINI_API_KEY", "account-abc")
    monkeypatch.setenv("GEMINI_API_SECRET", "s")
    monkeypatch.delenv("GEMINI_ENV", raising=False)
    monkeypatch.setattr(verify_auth.ReadOnlyClient, "get_balances", lambda self: [])
    monkeypatch.setattr(verify_auth.ReadOnlyClient, "get_positions", lambda self, **k: {"positions": []})
    monkeypatch.setattr(verify_auth.ReadOnlyClient, "list_active_orders", lambda self, **k: {"orders": []})
    assert verify_auth.main() == 0
    assert preflight.check(LIVE, repo.here) == []


def test_verify_auth_failure_writes_no_marker(repo, monkeypatch):
    monkeypatch.setattr(verify_auth, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(verify_auth, "HERE", repo.here)
    monkeypatch.setenv("GEMINI_API_KEY", "account-abc")
    monkeypatch.setenv("GEMINI_API_SECRET", "s")

    def boom(self):
        raise RuntimeError("HTTP 400")

    monkeypatch.setattr(verify_auth.ReadOnlyClient, "get_balances", boom)
    assert verify_auth.main() == 1
    assert not (repo.here / "state" / "verify_auth_ok.json").exists()


# --------------------------------------------------------------- startup enforcement


def test_server_refuses_to_start_live_when_preflight_fails(monkeypatch):
    import server
    monkeypatch.setattr(server, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(preflight, "check", lambda *a, **k: ["fee_confirmed is false"])
    monkeypatch.setenv("DRY_RUN", "false")
    built = []
    monkeypatch.setattr(server, "build", lambda *a, **k: built.append(1))
    with pytest.raises(SystemExit) as e:
        server.main()
    assert e.value.code == 1 and built == []


def test_server_starts_in_dry_run_with_warnings(monkeypatch, capsys):
    import server
    monkeypatch.setattr(server, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(preflight, "check", lambda *a, **k: ["fee_confirmed is false"])
    monkeypatch.setenv("DRY_RUN", "true")
    ran = []

    class Stub:
        def observe_kill(self):
            pass

        def run(self):
            ran.append(1)

    monkeypatch.setattr(server, "build", lambda *a, **k: (Stub(), Stub()))
    monkeypatch.setattr(server, "create_server", lambda m, g: Stub())
    server.main()
    assert ran == [1] and "fee_confirmed" in capsys.readouterr().err


def test_runner_refuses_to_start_live_when_preflight_fails(monkeypatch):
    import runner
    monkeypatch.setattr(preflight, "check", lambda *a, **k: ["allowed_event_tickers is empty"])
    monkeypatch.setenv("DRY_RUN", "false")
    started = []
    monkeypatch.setattr(runner, "run_with_server", lambda *a, **k: started.append(1))
    assert runner.main([]) == 1 and started == []


def test_runner_continues_in_dry_run_with_warnings(monkeypatch, capsys):
    import anthropic

    import runner
    monkeypatch.setattr(preflight, "check", lambda *a, **k: ["allowed_event_tickers is empty"])
    monkeypatch.setenv("DRY_RUN", "true")
    monkeypatch.setattr(anthropic, "Anthropic", lambda *a, **k: object())

    async def fake_run(make_runner):
        return []

    monkeypatch.setattr(runner, "run_with_server", fake_run)
    assert runner.main([]) == 0
    assert "allowed_event_tickers" in capsys.readouterr().err


def test_max_trades_per_day_bound(repo):
    repo.config(max_trades_per_day=21)
    fails = preflight.check(DRY, repo.here)
    assert len(fails) == 1 and "max_trades_per_day" in fails[0]
    repo.config(max_trades_per_day=20)
    assert preflight.check(DRY, repo.here) == []


def test_old_starting_balance_name_passes_with_a_visible_note(repo, capsys):
    import yaml
    cfg = {**GOOD, "initial_deposit_usd": 100}
    cfg.pop("starting_balance_usd")
    (repo.here / "config.yaml").write_text(yaml.safe_dump(cfg))
    fails, notes = preflight.check_with_notes(DRY, repo.here)
    assert fails == [] and any("initial_deposit_usd is deprecated" in n for n in notes)
    import sys
    assert preflight.enforce(DRY, repo.here, out=sys.stdout) is True
    assert "initial_deposit_usd is deprecated" in capsys.readouterr().out

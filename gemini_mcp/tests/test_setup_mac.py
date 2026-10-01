"""setup_mac.sh: idempotent, never overwrites or prints .env, chmod 600, no secrets in the script."""

import hashlib
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "setup_mac.sh"
# macOS ships bash 3.2.57. Set BASH32=/path/to/bash-3.2.57 to run every test under it as well (built from
# ftp.gnu.org/gnu/bash/bash-3.2.57.tar.gz for this review); without it those cases are skipped.
BASH32 = os.environ.get("BASH32")
SHELLS = ["bash", pytest.param(BASH32 or "bash32-missing", marks=pytest.mark.skipif(
    not (BASH32 and Path(BASH32).exists()), reason="set BASH32 to a bash 3.2 binary"), id="bash3.2")]


@pytest.fixture(params=SHELLS)
def shell(request):
    return request.param


@pytest.fixture
def checkout(tmp_path, shell):
    """A minimal git checkout of the gemini_mcp folder (no venv, no .env)."""
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / ".gitignore").write_text(".env\nstate/\n.venv/\n")
    here = tmp_path / "gm"
    here.mkdir()
    for name in ("setup_mac.sh", ".env.example", "requirements.txt", "preflight.py", "guardrails.py", "config.yaml"):
        shutil.copy(ROOT / name, here / name)
    SHELL_FOR[str(here)] = shell
    return here


SHELL_FOR: dict[str, str] = {}  # checkout path -> which bash runs its setup_mac.sh


def run(here, **env):
    e = {**os.environ, "SKIP_PIP": "1", "PYTHON": sys.executable, **env}
    e = {k: v for k, v in e.items() if v is not None}
    return subprocess.run([SHELL_FOR[str(here)], str(here / "setup_mac.sh")], capture_output=True, text=True, env=e,
                          timeout=300)


def mode(p):
    return stat.S_IMODE(p.stat().st_mode)


@pytest.mark.parametrize("sh", SHELLS)
def test_syntax_is_valid(sh):
    subprocess.run([sh, "-n", str(SCRIPT)], check=True)


BASH4_ONLY = [r"declare\s+-[a-zA-Z]*[An]", r"local\s+-[a-zA-Z]*[An]", r"\bmapfile\b", r"\breadarray\b",
              r"\$\{[A-Za-z_][A-Za-z0-9_]*(,,?|\^\^?)\}", r"&>>", r"\|&", r"\bcoproc\b", r"globstar", r";;&",
              r";&", r"\$\{[A-Za-z_][A-Za-z0-9_]*@[QEPAa]\}", r"\[\[\s*-v\b", r"EPOCHSECONDS", r"EPOCHREALTIME",
              r"\[-1\]", r"\bwait\s+-n\b", r"\{\d+\.\.\d+\.\.\d+\}", r"\$\{[A-Za-z_]+\[@\]:-?\d"]


def test_no_bash4_only_constructs():
    text = "\n".join(l for l in SCRIPT.read_text().splitlines() if not l.lstrip().startswith("#"))
    for pat in BASH4_ONLY:
        assert not re.search(pat, text), pat


def test_first_run_creates_env_600_and_venv(checkout):
    r = run(checkout)
    assert r.returncode == 0, r.stderr
    assert (checkout / ".env").read_text() == (checkout / ".env.example").read_text()
    assert mode(checkout / ".env") == 0o600 and mode(checkout / "state") == 0o700
    assert (checkout / ".venv" / "bin" / "python").exists()
    assert "preflight (DRY_RUN) says" in r.stdout


def test_never_overwrites_or_prints_an_existing_env(checkout):
    secret = "GEMINI_API_KEY=account-REALKEY123\nGEMINI_API_SECRET=SUPERSECRET456\n"
    (checkout / ".env").write_text(secret)
    os.chmod(checkout / ".env", 0o644)
    before = hashlib.sha256(secret.encode()).hexdigest()
    for _ in range(2):  # idempotent
        r = run(checkout)
        assert r.returncode == 0, r.stderr
        assert hashlib.sha256((checkout / ".env").read_bytes()).hexdigest() == before
        assert mode(checkout / ".env") == 0o600
        assert "REALKEY123" not in r.stdout + r.stderr and "SUPERSECRET456" not in r.stdout + r.stderr
        assert "left untouched" in r.stdout


def test_refuses_a_symlinked_env(checkout, tmp_path):
    target = tmp_path / "elsewhere.env"
    target.write_text("X=1\n")
    (checkout / ".env").symlink_to(target)
    r = run(checkout)
    assert r.returncode != 0 and "symlink" in r.stderr
    assert target.read_text() == "X=1\n"


def test_fails_if_env_not_gitignored(checkout):
    (checkout.parent / ".gitignore").write_text("state/\n")
    r = run(checkout)
    assert r.returncode != 0 and ".gitignore" in r.stderr


def test_fails_if_a_key_file_is_tracked(checkout):
    (checkout / "api.pem").write_text("x")
    subprocess.run(["git", "-C", str(checkout), "add", "api.pem"], check=True)
    r = run(checkout)
    assert r.returncode != 0 and "api.pem" in r.stderr


def fake_python(path, version="3.9.6"):
    """A python3 that reports an old version (like the macOS Command Line Tools' 3.9.6)."""
    path.write_text("#!/bin/sh\n"
                    f"if [ \"$1\" = \"-c\" ]; then echo '{version}'; exit 1; fi\n"
                    f"echo 'Python {version}'\n")
    path.chmod(0o755)
    return path


def test_old_python_is_refused_with_clear_instructions(checkout, tmp_path):
    fake = fake_python(tmp_path / "python3")
    r = run(checkout, PYTHON=str(fake))
    assert r.returncode != 0 and not (checkout / ".env").exists()
    err = r.stderr
    assert "3.10" in err and "3.9.6" in err  # what's needed, and what was found
    assert "Command Line Tools" in err and "brew install python@3.12" in err and "python.org" in err
    assert "PYTHON=" in err


def test_minimum_python_matches_what_the_dependencies_need():
    text = SCRIPT.read_text()
    m = re.search(r'^MIN_PY_MINOR=(\d+)$', text, flags=re.M)
    assert m and m.group(1) == "10"  # mcp>=1.20 needs 3.10; the suite was run green on 3.10 for this review


def test_finds_a_newer_python_when_python3_is_too_old(checkout, tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    fake_python(bindir / "python3")
    (bindir / "python3.12").symlink_to(sys.executable)
    env_path = f"{bindir}:{os.environ['PATH']}"
    r = run(checkout, PYTHON=None, PATH=env_path)
    assert r.returncode == 0, r.stderr
    assert "python3 is 3.9.6" in r.stdout
    assert re.search(r"using \S*python3\.1[0-9]", r.stdout), r.stdout  # first 3.10+ found (3.13 here, if present)


def test_script_holds_no_secrets_and_never_reads_env_contents():
    text = SCRIPT.read_text()
    assert not re.search(r"(account|master)-[A-Za-z0-9]{6,}|sk-ant-", text)
    for bad in ("cat .env", "source .env", ". .env", "<.env", "< .env", "echo $GEMINI", "set -x"):
        assert bad not in text, bad

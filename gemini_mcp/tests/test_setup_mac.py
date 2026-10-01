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


@pytest.fixture
def checkout(tmp_path):
    """A minimal git checkout of the gemini_mcp folder (no venv, no .env)."""
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / ".gitignore").write_text(".env\nstate/\n.venv/\n")
    here = tmp_path / "gm"
    here.mkdir()
    for name in ("setup_mac.sh", ".env.example", "requirements.txt", "preflight.py", "guardrails.py", "config.yaml"):
        shutil.copy(ROOT / name, here / name)
    return here


def run(here, **env):
    e = {**os.environ, "SKIP_PIP": "1", "PYTHON": sys.executable, **env}
    return subprocess.run(["bash", str(here / "setup_mac.sh")], capture_output=True, text=True, env=e, timeout=300)


def mode(p):
    return stat.S_IMODE(p.stat().st_mode)


def test_syntax_is_valid():
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


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


def test_old_python_is_refused(checkout, tmp_path):
    fake = tmp_path / "python3.9"
    fake.write_text("#!/bin/sh\nif [ \"$1\" = \"-c\" ]; then exit 1; fi\necho 'Python 3.9.0'\n")
    fake.chmod(0o755)
    r = run(checkout, PYTHON=str(fake))
    assert r.returncode != 0 and "3.11" in r.stderr
    assert not (checkout / ".env").exists()


def test_script_holds_no_secrets_and_never_reads_env_contents():
    text = SCRIPT.read_text()
    assert not re.search(r"(account|master)-[A-Za-z0-9]{6,}|sk-ant-", text)
    for bad in ("cat .env", "source .env", ". .env", "<.env", "< .env", "echo $GEMINI", "set -x"):
        assert bad not in text, bad

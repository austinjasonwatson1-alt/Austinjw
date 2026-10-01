"""Pre-flight checks before trading. Exits non-zero and prints every failure.

    python preflight.py

server.py and runner.py run these at startup. In live mode (DRY_RUN=false) any
failure stops them from starting. In DRY_RUN they print the failures as warnings
and continue.

Checks:
- config.yaml loads; starting_balance_usd is set and positive
- fee_confirmed is true (set it after checking Gemini's fee schedule)
- allowed_event_tickers is not empty
- sane bounds: max_order_pct_of_balance <= 0.15, max_daily_spend_pct <= 0.5,
  max_drawdown_pct <= 0.35, equity_floor_pct >= 0.4, kelly_multiplier <= 0.5,
  max_trades_per_day <= 20, max_exits_per_day <= 30
- warnings only (never fail): max_days_to_expiry > 30
- .env and key files (.env.*, *.pem, *.key, *.p12, *.pfx) are not tracked by git
  and are covered by .gitignore
- live only: verify_auth.py succeeded for this GEMINI_ENV in the last 24 hours
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import warnings
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

from guardrails import ConfigError, load_config, parse_dry_run, parse_env

HERE = Path(__file__).resolve().parent
MARKER = Path("state") / "verify_auth_ok.json"
MARKER_MAX_AGE_S = 24 * 3600
_KEY_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
_SKIP_DIRS = {".git", ".venv", "venv", "__pycache__", ".pytest_cache", "node_modules"}

BOUNDS = (  # (config key, comparison, limit, description)
    ("max_order_pct_of_balance", "gt", Decimal("0.15"), "must be at most 0.15"),
    ("max_daily_spend_pct", "gt", Decimal("0.5"), "must be at most 0.5"),
    ("max_drawdown_pct", "gt", Decimal("0.35"), "must be at most 0.35"),
    ("equity_floor_pct", "lt", Decimal("0.4"), "must be at least 0.4 (floor at 40% of starting_balance_usd)"),
    ("kelly_multiplier", "gt", Decimal("0.5"), "must be at most 0.5"),
    ("max_trades_per_day", "gt", Decimal("20"), "must be at most 20"),
    ("max_exits_per_day", "gt", Decimal("30"), "must be at most 30"),
)

WARN_BOUNDS = (  # (config key, limit, description): above the limit is a warning (note), not a failure
    ("max_days_to_expiry", Decimal("30"), "above 30 days; the short-dated focus is off (long-dated contracts tie up "
                                          "cash and settle too slowly to learn from)"),
)


def is_key_file(name: str) -> bool:
    return (name == ".env" or (name.startswith(".env.") and name != ".env.example")
            or name.endswith(_KEY_SUFFIXES))


def is_live(environ: Any) -> bool:
    """Live unless DRY_RUN parses as dry run. A malformed DRY_RUN counts as live (strictest)."""
    try:
        return not parse_dry_run(environ.get("DRY_RUN"))
    except ConfigError:
        return True


def _git(here: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(here), *args], capture_output=True, text=True, timeout=20)


def _git_checks(here: Path, git: Callable[..., subprocess.CompletedProcess]) -> list[str]:
    try:
        top = git(here, "rev-parse", "--show-toplevel")
    except (OSError, subprocess.SubprocessError) as e:
        return [f"can't run git to verify secrets aren't committed: {type(e).__name__}"]
    if top.returncode != 0:
        return ["not inside a git repository; can't verify .env / key files are untracked and ignored"]
    fails = []
    tracked = git(here, "ls-files", "-z", "--", ".")
    if tracked.returncode != 0:
        return ["git ls-files failed; can't verify .env / key files are untracked"]
    for rel in filter(None, tracked.stdout.split("\0")):
        if is_key_file(Path(rel).name):
            fails.append(f"{rel} is tracked by git: remove it (git rm --cached {rel}), rotate the key, "
                         "and add it to .gitignore")
    on_disk = {here / ".env"} | {p for p in here.rglob("*") if p.is_file() and is_key_file(p.name)
                                 and not _SKIP_DIRS.intersection(p.relative_to(here).parts)}
    for path in sorted(on_disk):
        rel = os.path.relpath(path, here)
        if git(here, "check-ignore", "-q", "--no-index", "--", rel).returncode != 0:
            fails.append(f"{rel} is not covered by .gitignore")
    return fails


def _marker_failure(here: Path, env: str | None, now: float) -> str | None:
    path = here / MARKER
    if not path.is_file():
        return "verify_auth.py has not succeeded yet (no state/verify_auth_ok.json); run python verify_auth.py"
    try:
        m = json.loads(path.read_text())
        age = now - float(m["epoch"])
        marker_env = m.get("env")
    except (ValueError, KeyError, TypeError, OSError):
        return "state/verify_auth_ok.json is unreadable; run python verify_auth.py again"
    if marker_env != env:
        return (f"verify_auth.py last succeeded for GEMINI_ENV={marker_env}, not {env}; "
                "run python verify_auth.py again")
    if age < -300:
        return "state/verify_auth_ok.json is dated in the future (clock skew?); run python verify_auth.py again"
    if age > MARKER_MAX_AGE_S:
        return f"verify_auth.py last succeeded {age / 3600:.1f} h ago (max 24 h); run python verify_auth.py again"
    return None


def check(environ: Any = os.environ, here: Path = HERE, now: float | None = None,
          git: Callable[..., subprocess.CompletedProcess] = _git) -> list[str]:
    """Every failure as a human-readable line. Empty list = all checks passed."""
    return check_with_notes(environ, here, now, git)[0]


def check_with_notes(environ: Any = os.environ, here: Path = HERE, now: float | None = None,
                     git: Callable[..., subprocess.CompletedProcess] = _git) -> tuple[list[str], list[str]]:
    """(failures, notes). Notes never fail the check (e.g. deprecated config key names)."""
    now = time.time() if now is None else now
    fails: list[str] = []
    env: str | None = None
    try:
        parse_dry_run(environ.get("DRY_RUN"))
    except ConfigError as e:
        fails.append(str(e))
    try:
        env = parse_env(environ.get("GEMINI_ENV"))
    except ConfigError as e:
        fails.append(str(e))

    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            cfg = load_config(here / "config.yaml")
        notes = [str(w.message) for w in caught if issubclass(w.category, DeprecationWarning)]
    except ConfigError as e:
        notes = []
        cfg = None
        fails.append(f"config.yaml: {e}")
    if cfg is not None:
        if not cfg.starting_balance_usd:
            fails.append("starting_balance_usd is unset or zero: set it in config.yaml to the account balance "
                         "you start trading with")
        if not cfg.fee_confirmed:
            fails.append(f"fee_confirmed is false: check fee_per_contract ({cfg.fee_per_contract}) against "
                         "Gemini's fee schedule, then set fee_confirmed: true in config.yaml")
        if not cfg.allowed_event_tickers:
            fails.append("allowed_event_tickers is empty: nothing can trade")
        for key, op, limit, desc in BOUNDS:
            v = getattr(cfg, key)
            if (op == "gt" and v > limit) or (op == "lt" and v < limit):
                fails.append(f"{key} is {v}; {desc}")
        for key, limit, desc in WARN_BOUNDS:
            v = getattr(cfg, key)
            if v > limit:
                notes.append(f"{key} is {v}; {desc}")

    fails += _git_checks(here, git)

    if is_live(environ):
        m = _marker_failure(here, env, now)
        if m:
            fails.append(m)
    return fails, notes


def enforce(environ: Any = os.environ, here: Path = HERE, out: Any = None) -> bool:
    """Run at startup. Returns False (caller must exit) when checks fail in live mode."""
    out = out or sys.stderr
    fails, notes = check_with_notes(environ, here)
    for n in notes:
        print(f"preflight note: {n}", file=out)
    if not fails:
        return True
    live = is_live(environ)
    head = ("PREFLIGHT FAILED (live mode): refusing to start." if live
            else "preflight warnings (DRY_RUN, continuing; these block live mode):")
    print(head, file=out)
    for f in fails:
        print(f"  FAIL: {f}", file=out)
    return not live


def main() -> int:
    from dotenv import load_dotenv

    load_dotenv(HERE / ".env", override=False)
    fails, notes = check_with_notes(os.environ)
    for n in notes:
        print(f"NOTE: {n}")
    mode = "live" if is_live(os.environ) else "dry run"
    for f in fails:
        print(f"FAIL: {f}")
    print(f"preflight ({mode}): {'FAILED, ' + str(len(fails)) + ' problem(s)' if fails else 'OK'}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

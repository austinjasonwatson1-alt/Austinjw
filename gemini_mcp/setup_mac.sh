#!/usr/bin/env bash
# First-time (and repeat) setup for gemini_mcp on macOS. Idempotent: safe to run again at any time.
#
#   cd gemini_mcp && ./setup_mac.sh
#
# What it does:
#   - checks for Python 3.10+ (override with PYTHON=/path/to/python3); if python3 is too old (macOS's Command
#     Line Tools ship 3.9) it looks for python3.13 ... python3.10 and Homebrew's python3, else explains how to install
#   - creates .venv if missing and installs requirements.txt into it (skip with SKIP_PIP=1)
#   - creates .env from .env.example ONLY if .env doesn't exist. It never overwrites, edits or prints .env.
#   - chmod 600 .env, chmod 700 state/
#   - checks that .env is ignored by git and that no .env or key file is tracked
#   - runs preflight.py in DRY_RUN to show what's still missing (it will list failures; that's expected at first)
# It handles no secrets and never calls Gemini or Anthropic. Written for /bin/bash 3.2 (what macOS ships): no
# bash 4 features.

set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [ "$(uname -s)" != "Darwin" ]; then
  say "note: this script is written for macOS; continuing anyway on $(uname -s)."
fi

# --- Python. The minimum is set by the MCP SDK (mcp>=1.20 needs Python 3.10+); the test suite runs green on 3.10.
# macOS's Command Line Tools ship Python 3.9, which is too old.
MIN_PY_MAJOR=3
MIN_PY_MINOR=10

py_version() { "$1" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null; }
py_ok() {
  "$1" -c "import sys; sys.exit(0 if sys.version_info >= ($MIN_PY_MAJOR, $MIN_PY_MINOR) else 1)" >/dev/null 2>&1
}
too_old() {
  found=$(py_version "$1" || true)
  printf 'ERROR: Python %s.%s or newer is required (the MCP SDK, mcp>=1.20, needs it); %s is %s.\n' \
    "$MIN_PY_MAJOR" "$MIN_PY_MINOR" "$1" "${found:-not runnable}" >&2
  printf '%s\n' \
    "macOS's Command Line Tools ship Python 3.9, which is too old for this project. Install a newer one:" \
    '  Homebrew:   brew install python@3.12' \
    '              then rerun:  PYTHON="$(brew --prefix)/bin/python3.12" ./setup_mac.sh' \
    '  python.org: download the macOS installer from https://www.python.org/downloads/' \
    '              then rerun:  PYTHON=/usr/local/bin/python3.12 ./setup_mac.sh' >&2
  exit 1
}

if [ -n "${PYTHON:-}" ]; then
  PY="$PYTHON"
  command -v "$PY" >/dev/null 2>&1 || fail "PYTHON=$PY was not found."
  py_ok "$PY" || too_old "$PY"
elif command -v python3 >/dev/null 2>&1 && py_ok python3; then
  PY=python3
else
  # python3 is missing or too old (e.g. the Command Line Tools' 3.9): look for a newer one.
  old=$(py_version python3 || true)
  PY=""
  for cand in python3.13 python3.12 python3.11 python3.10 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    if command -v "$cand" >/dev/null 2>&1 && py_ok "$cand"; then
      PY="$cand"
      break
    fi
  done
  [ -n "$PY" ] || too_old python3
  say "note: python3 is ${old:-missing}; using $PY ($(py_version "$PY"))"
fi
say "ok   Python $(py_version "$PY") ($PY)"

[ -f .env.example ] || fail ".env.example is missing; run this from the gemini_mcp folder of a full checkout."
[ -f requirements.txt ] || fail "requirements.txt is missing."

# --- virtualenv
if [ -x .venv/bin/python ]; then
  say "ok   .venv exists"
else
  "$PY" -m venv .venv
  say "ok   created .venv"
fi
if [ "${SKIP_PIP:-0}" = "1" ]; then
  say "skip pip install (SKIP_PIP=1)"
else
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet -r requirements.txt
  say "ok   installed requirements.txt into .venv"
fi

# --- .env: create once from the example, never overwrite
if [ -L .env ]; then
  fail ".env is a symlink; refusing to touch it. Make it a regular file in this folder."
elif [ -e .env ]; then
  say "ok   .env already exists; left untouched"
else
  ( umask 077 && cp .env.example .env )
  say "ok   created .env from .env.example (empty keys; DRY_RUN=true). Fill in your keys with an editor."
fi
chmod 600 .env
say "ok   .env is chmod 600"

mkdir -p state
chmod 700 state
say "ok   state/ is chmod 700"

# --- git hygiene: .env must be ignored and nothing secret tracked
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git check-ignore -q --no-index .env || fail ".env is NOT covered by .gitignore. Add it before going further."
  tracked=$(git ls-files -- . | grep -E '(^|/)\.env($|\.)|\.(pem|key|p12|pfx)$' | grep -v '\.env\.example$' || true)
  [ -z "$tracked" ] || fail "secret-looking files are tracked by git: $tracked"
  say "ok   .env is gitignored and no key files are tracked"
else
  say "warn not inside a git checkout; couldn't verify .gitignore"
fi

# --- show what's still missing (never fails the setup in DRY_RUN)
say ""
say "preflight (DRY_RUN) says:"
DRY_RUN=true .venv/bin/python preflight.py || true

say ""
say "Next: edit .env (keys), then config.yaml (starting_balance_usd, allowed_event_tickers, fee check -> fee_confirmed),"
say "then run: .venv/bin/python verify_auth.py  and  .venv/bin/python -m pytest -q tests   (see RUNBOOK.md)."

#!/usr/bin/env bash
# First-time (and repeat) setup for gemini_mcp on macOS. Idempotent: safe to run again at any time.
#
#   cd gemini_mcp && ./setup_mac.sh
#
# What it does:
#   - checks for Python 3.11+ (override with PYTHON=/path/to/python3)
#   - creates .venv if missing and installs requirements.txt into it (skip with SKIP_PIP=1)
#   - creates .env from .env.example ONLY if .env doesn't exist. It never overwrites, edits or prints .env.
#   - chmod 600 .env, chmod 700 state/
#   - checks that .env is ignored by git and that no .env or key file is tracked
#   - runs preflight.py in DRY_RUN to show what's still missing (it will list failures; that's expected at first)
# It handles no secrets and never calls Gemini or Anthropic.

set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [ "$(uname -s)" != "Darwin" ]; then
  say "note: this script is written for macOS; continuing anyway on $(uname -s)."
fi

PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || fail "$PY not found. Install Python 3.11+ (e.g. brew install python@3.12) or set PYTHON=..."
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || fail "Python 3.11+ is required; $("$PY" --version 2>&1) found. Set PYTHON=/path/to/python3.11+."

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

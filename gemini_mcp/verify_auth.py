"""Read-only check that request signing works, before any order is ever sent.

    python verify_auth.py

Uses ReadOnlyClient only, so it can't reach order or cancel endpoints. Runs
each step in order and stops at the first failure, printing Gemini's exact
error. It doesn't try alternative signing schemes.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from gemini_client import ReadOnlyClient
from guardrails import parse_env

HERE = Path(__file__).resolve().parent


def main() -> int:
    load_dotenv(HERE / ".env", override=False)
    env = parse_env(os.environ.get("GEMINI_ENV"))
    key = os.environ.get("GEMINI_API_KEY", "")
    client = ReadOnlyClient(env, key, os.environ.get("GEMINI_API_SECRET"), os.environ.get("GEMINI_ACCOUNT"))
    print(f"environment: {env} ({client.base_url})")
    if not client.has_credentials:
        print("FAIL: GEMINI_API_KEY and GEMINI_API_SECRET must both be set.")
        return 1
    print(f"key type: {key.split('-', 1)[0]}-...")  # prefix only (account/master); never the key itself

    steps = [
        ("balances (POST /v1/balances)", lambda: client.get_balances()),
        ("positions, no params (POST /v1/prediction-markets/positions)", lambda: client.get_positions()),
        ("open orders (POST /v1/prediction-markets/orders/active)", lambda: client.list_active_orders(limit=1)),
    ]
    results = {}
    for name, call in steps:
        try:
            results[name] = call()
        except Exception as e:  # noqa: BLE001
            print(f"FAIL at step '{name}':\n  {e}")
            print("Stopping. No other signing variants will be tried.")
            return 1
        print(f"OK   {name}")

    # Confirm that parameters placed in the signed payload are honored.
    try:
        limited = client.get_positions(limit=1)
    except Exception as e:  # noqa: BLE001
        print(f"FAIL at step 'positions with limit=1 in signed payload':\n  {e}")
        return 1
    all_positions = results[steps[1][0]].get("positions") or []
    got = limited.get("positions") or []
    if len(all_positions) >= 2:
        verdict = "honored" if len(got) <= 1 else "NOT honored"
        print(f"{'OK  ' if len(got) <= 1 else 'WARN'} positions limit=1 returned {len(got)} of {len(all_positions)}: payload params {verdict}")
    else:
        print(f"INFO positions limit=1 accepted (returned {len(got)}); need 2+ positions to prove the param is honored")

    print("\nSigned read-only calls work. Prediction-market terms: check and accept them on the Gemini website;")
    print("an order will fail with TERMS_NOT_ACCEPTED otherwise.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

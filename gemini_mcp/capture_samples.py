"""Read-only capture of two real Gemini responses, to check them against docs/real_response_check.md.

    python capture_samples.py              # writes samples/real/positions.json and samples/real/active_orders.json

It uses the allowlisted, signing ReadOnlyClient (which can't place or cancel) and makes exactly two calls:
POST /v1/prediction-markets/positions and POST /v1/prediction-markets/orders/active.

Safety:
- It never prints or writes credentials. API errors are reported by HTTP status only, not the body.
- If any value in either response looks like a secret (your configured keys, Gemini or Anthropic key formats,
  private keys, JWTs, long opaque tokens), it refuses, prints only the field path, and writes nothing.
- Sensitive values are redacted by field name (account, email, name, address, key, secret, token, password,
  signature, phone, user, owner) and email addresses are redacted anywhere. Every field NAME, the nesting and
  each value's TYPE are kept: strings become "REDACTED", numbers 0, booleans false.
- It writes only into an output directory that git ignores (samples/real/ is in .gitignore), as 0600 files.

Afterwards it prints, for every field the code reads (the list in docs/real_response_check.md), whether it was
present, absent or empty in the real response. An empty list proves nothing about field names, so place a
small order first if you have no positions or open orders.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE / "samples" / "real"
REDACTED = "REDACTED"

# Every Gemini field the guardrails read from these two responses (docs/real_response_check.md).
FIELDS = {
    "positions": ["positions", "positions[].symbol", "positions[].outcome", "positions[].totalQuantity",
                  "positions[].quantityOnHold", "positions[].avgPrice", "positions[].marketValue",
                  "positions[].contractMetadata", "positions[].contractMetadata.eventTicker",
                  "positions[].contractMetadata.category", "positions[].contractMetadata.expiryDate"],
    "orders": ["orders", "orders[].side", "orders[].outcome", "orders[].symbol", "orders[].remainingQuantity",
               "orders[].price", "orders[].contractMetadata", "orders[].contractMetadata.eventTicker",
               "orders[].contractMetadata.category", "orders[].orderId"],
}

SENSITIVE_NAME = re.compile(r"account|e-?mail|name|address|key|secret|token|password|passwd|signature|phone|"
                            r"user|owner", re.IGNORECASE)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SECRET_PATTERNS = [
    ("Gemini API key", re.compile(r"\b(?:account|master)-[A-Za-z0-9]{8,}")),
    ("Anthropic API key", re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}")),
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("long opaque token", re.compile(r"(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{40,}(?![A-Za-z0-9+/=_-])")),
]


# --------------------------------------------------------------------------- scanning and redaction


def _walk(value: Any, path: str = "") -> Any:
    """Yield (path, leaf) for every leaf value."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield from _walk(v, f"{path}.{k}" if path else str(k))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from _walk(v, f"{path}[{i}]")
    else:
        yield path, value


def find_secrets(responses: dict[str, Any], known: list[str]) -> list[tuple[str, str]]:
    """(field path, what it looks like) for every value that looks like a secret. Never returns the value."""
    known = [k for k in known if k and len(k) >= 8]
    hits = []
    for name, body in responses.items():
        for path, leaf in _walk(body):
            text = leaf if isinstance(leaf, str) else ""
            if not text:
                continue
            if any(k in text for k in known):
                hits.append((path, "one of your configured keys"))
                continue
            for label, rx in SECRET_PATTERNS:
                if rx.search(text):
                    hits.append((path, label))
                    break
    return hits


def _blank(value: Any) -> Any:
    """Same type, no content."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return 0
    if isinstance(value, float):
        return 0.0
    if isinstance(value, str):
        return REDACTED
    if isinstance(value, dict):
        return {k: _blank(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_blank(v) for v in value]
    return value  # None stays None


def redact(value: Any) -> Any:
    """Redact sensitive values; keep every field name, the nesting and each value's type."""
    if isinstance(value, dict):
        return {k: (_blank(v) if SENSITIVE_NAME.search(str(k)) else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return EMAIL.sub(REDACTED, value)
    return value


# --------------------------------------------------------------------------- comparison table


def _get(entry: Any, dotted: str) -> tuple[bool, Any]:
    cur = entry
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return False, None
        cur = cur[part]
    return True, cur


def _is_empty(v: Any) -> bool:
    return v is None or (isinstance(v, (str, list, dict)) and len(v) == 0)


def field_status(body: Any, field: str) -> str:
    top, _, rest = field.partition("[].")
    entries = body.get(top) if isinstance(body, dict) else None
    if field == top:
        if entries is None:
            return "ABSENT (top-level key missing)"
        if not isinstance(entries, list):
            return f"UNEXPECTED (not a list: {type(entries).__name__})"
        return f"present, {len(entries)} entries" if entries else "empty list (proves nothing about fields)"
    if not isinstance(entries, list) or not entries:
        return "unknown (no entries to inspect)"
    n = len(entries)
    present = empty = 0
    for e in entries:
        ok, v = _get(e, rest)
        if ok:
            present += 1
            empty += _is_empty(v)
    if present == 0:
        return f"ABSENT in all {n}"
    if present < n:
        return f"ABSENT in {n - present} of {n}"
    if empty:
        return f"EMPTY in {empty} of {n}"
    return f"present in all {n}"


def comparison_table(responses: dict[str, Any]) -> str:
    lines = ["", "Fields the code reads (docs/real_response_check.md) vs the real response:", ""]
    width = max(len(f) for fs in FIELDS.values() for f in fs) + 2
    lines.append(f"  {'field'.ljust(width)}status")
    for name, fields in FIELDS.items():
        body = responses["positions" if name == "positions" else "orders"]
        for f in fields:
            lines.append(f"  {f.ljust(width)}{field_status(body, f)}")
    lines += ["", "NOTE: an empty list proves nothing about field names. If positions or orders is empty, the fields",
              "      inside it weren't checked; capture again while you hold a position and have a resting buy and",
              "      a resting sell.",
              "ABSENT or EMPTY on a required field means the guardrails will refuse every order (see the doc)."]
    return "\n".join(lines)


# --------------------------------------------------------------------------- output


def _git_ignores(path: Path) -> bool | None:
    """True/False if inside a git checkout, None if git can't tell."""
    try:
        top = subprocess.run(["git", "-C", str(path.parent), "rev-parse", "--show-toplevel"], capture_output=True,
                             text=True, timeout=20)
        if top.returncode != 0:
            return None
        probe = path / "positions.json"
        r = subprocess.run(["git", "-C", top.stdout.strip(), "check-ignore", "-q", "--no-index", str(probe)],
                           capture_output=True, timeout=20)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return None


def _write(path: Path, data: Any) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=False)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def make_client(environ: Any):
    from gemini_client import ReadOnlyClient
    from guardrails import parse_env

    return ReadOnlyClient(parse_env(environ.get("GEMINI_ENV")), environ.get("GEMINI_API_KEY"),
                          environ.get("GEMINI_API_SECRET"), environ.get("GEMINI_ACCOUNT"))


def main(argv: list[str] | None = None, environ: Any = None, out: Callable[[str], None] = print) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory (must be gitignored)")
    ap.add_argument("--no-git-check", action="store_true", help=argparse.SUPPRESS)  # tests only
    args = ap.parse_args(argv)
    if environ is None:
        from dotenv import load_dotenv

        load_dotenv(HERE / ".env", override=False)
        environ = os.environ
    key, secret = environ.get("GEMINI_API_KEY") or "", environ.get("GEMINI_API_SECRET") or ""
    if not key or not secret:
        out("GEMINI_API_KEY and GEMINI_API_SECRET must both be set (in .env). Nothing was called.")
        return 1
    dest = args.out.resolve()
    if not args.no_git_check and _git_ignores(dest) is not True:
        out(f"refusing: {dest} is not covered by .gitignore (add samples/real/ to it). Nothing was called.")
        return 2

    client = make_client(environ)
    out(f"environment: {client.env} (read-only client; 2 calls)")
    responses: dict[str, Any] = {}
    try:
        responses["positions"] = client.get_positions()
        responses["orders"] = client.list_active_orders(limit=100)
    except Exception as e:  # noqa: BLE001 - report the status, never the body (it could echo request data)
        status = getattr(e, "status", None)
        out(f"request failed: {type(e).__name__}" + (f" (HTTP {status})" if status is not None else "")
            + ". Nothing was written.")
        return 1

    hits = find_secrets(responses, [key, secret, environ.get("ANTHROPIC_API_KEY") or ""])
    if hits:
        out("REFUSING: the response contains values that look like secrets. Nothing was written.")
        for path, label in hits:
            out(f"  {path}: looks like a {label}")
        return 2

    dest.mkdir(parents=True, exist_ok=True)
    os.chmod(dest, 0o700)
    _write(dest / "positions.json", redact(responses["positions"]))
    _write(dest / "active_orders.json", redact(responses["orders"]))
    out(f"wrote {dest / 'positions.json'} and {dest / 'active_orders.json'} (redacted, 0600)")
    out(comparison_table(responses))
    return 0


if __name__ == "__main__":
    sys.exit(main())

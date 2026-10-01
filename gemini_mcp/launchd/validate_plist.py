"""Validate the launchd job with Python's plistlib (plutil only exists on macOS).

    python launchd/validate_plist.py ~/Library/LaunchAgents/com.gemini-mcp.dryrun.plist   # installed copy
    python launchd/validate_plist.py --template launchd/com.gemini-mcp.dryrun.plist.template

It checks that the file parses as a property list (what `plutil -lint` checks), then launchd's structure rules
for the keys this job uses, and the job's own safety rules:
- it is DRY_RUN only (DRY_RUN=true and GEMINI_MCP_SCHEDULE=dry_run_only);
- there is no --auto-confirm and no KeepAlive;
- it holds no secrets in EnvironmentVariables.

For an installed copy it also checks that the /ABS/PATH and YOUR_USER placeholders were replaced, that the paths
are absolute, that the Python, runner and working directory exist, and that the log folder exists.
Exit status: 0 if valid, 1 if not (every problem is printed).
"""

from __future__ import annotations

import argparse
import plistlib
import re
import sys
import xml.parsers.expat
from pathlib import Path
from typing import Any

PLACEHOLDERS = ("/ABS/PATH", "YOUR_USER")
SECRET_ENV = re.compile(r"KEY|SECRET|TOKEN|PASSWORD|ANTHROPIC|GEMINI_API", re.IGNORECASE)
CALENDAR_RANGES = {"Minute": (0, 59), "Hour": (0, 23), "Day": (1, 31), "Weekday": (0, 7), "Month": (1, 12)}


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate(path: Path, template: bool = False) -> list[str]:
    try:
        d = plistlib.loads(Path(path).read_bytes())
    except (OSError, plistlib.InvalidFileException, ValueError, xml.parsers.expat.ExpatError) as e:
        return [f"not a valid plist: {type(e).__name__}: {e}"]
    if not isinstance(d, dict):
        return ["not a valid plist: the top level must be a dict"]
    errors: list[str] = []

    # --- launchd's structure rules for the keys this job uses
    if not isinstance(d.get("Label"), str) or not d.get("Label"):
        errors.append("Label must be a non-empty string")
    for key in ("Disabled", "RunAtLoad"):
        if key in d and not isinstance(d[key], bool):
            errors.append(f"{key} must be <true/> or <false/>, not {type(d[key]).__name__}")
    args = d.get("ProgramArguments")
    if not isinstance(args, list) or not args or not all(isinstance(a, str) for a in args):
        errors.append("ProgramArguments must be a non-empty array of strings")
        args = []
    for key in ("WorkingDirectory", "StandardOutPath", "StandardErrorPath"):
        if key in d and not isinstance(d[key], str):
            errors.append(f"{key} must be a string")
    env = d.get("EnvironmentVariables")
    if not isinstance(env, dict):
        errors.append("EnvironmentVariables must be a dict")
        env = {}
    for k, v in env.items():
        if not isinstance(v, str):
            errors.append(f"EnvironmentVariables.{k} must be a string, not {type(v).__name__}")
    cal = d.get("StartCalendarInterval")
    entries = cal if isinstance(cal, list) else [cal] if isinstance(cal, dict) else None
    if entries is None:
        errors.append("StartCalendarInterval must be a dict or an array of dicts")
        entries = []
    for i, e in enumerate(entries):
        if not isinstance(e, dict) or not e:
            errors.append(f"StartCalendarInterval[{i}] must be a non-empty dict")
            continue
        for k, v in e.items():
            if k not in CALENDAR_RANGES:
                errors.append(f"StartCalendarInterval[{i}] has an unknown key {k!r} (allowed: "
                              f"{', '.join(CALENDAR_RANGES)})")
            elif not _is_int(v):
                errors.append(f"StartCalendarInterval[{i}].{k} must be an integer")
            elif not CALENDAR_RANGES[k][0] <= v <= CALENDAR_RANGES[k][1]:
                errors.append(f"StartCalendarInterval[{i}].{k}={v} is out of range {CALENDAR_RANGES[k]}")

    # --- this job's safety rules
    if env.get("DRY_RUN") != "true":
        errors.append("EnvironmentVariables.DRY_RUN must be \"true\": this schedule is DRY_RUN only")
    if env.get("GEMINI_MCP_SCHEDULE") != "dry_run_only":
        errors.append("EnvironmentVariables.GEMINI_MCP_SCHEDULE must be \"dry_run_only\" (runner.py's interlock)")
    for k in env:
        if SECRET_ENV.search(k):
            errors.append(f"EnvironmentVariables.{k} looks like a secret; keys belong in gemini_mcp/.env only")
    if any("auto-confirm" in a for a in args):
        errors.append("ProgramArguments must not contain --auto-confirm: scheduled runs never confirm live orders")
    if "KeepAlive" in d:
        errors.append("KeepAlive must not be set: the runner is a one-shot job on a schedule")
    if args and not args[-1].endswith("runner.py"):
        errors.append("the last ProgramArguments entry must be the path to runner.py")

    # --- installed copy: placeholders replaced, absolute paths that exist
    if not template:
        raw = Path(path).read_text(errors="replace")
        for ph in PLACEHOLDERS:
            if ph in raw:
                errors.append(f"placeholder {ph} is still in the file: replace it with your real path / user name")
        for a in args:
            if not a.startswith("/"):
                errors.append(f"ProgramArguments entry {a!r} must be an absolute path")
            elif not any(ph in a for ph in PLACEHOLDERS) and not Path(a).exists():
                errors.append(f"{a} does not exist")
        wd = d.get("WorkingDirectory")
        if isinstance(wd, str) and not any(ph in wd for ph in PLACEHOLDERS) and not Path(wd).is_dir():
            errors.append(f"WorkingDirectory {wd} does not exist")
        for key in ("StandardOutPath", "StandardErrorPath"):
            p = d.get(key)
            if isinstance(p, str) and not any(ph in p for ph in PLACEHOLDERS) and not Path(p).parent.is_dir():
                errors.append(f"{key}: the log folder {Path(p).parent} does not exist (mkdir -p it)")
    return errors


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("plist", type=Path)
    ap.add_argument("--template", action="store_true", help="validate the template (placeholders allowed)")
    args = ap.parse_args(argv)
    errors = validate(args.plist, template=args.template)
    if errors:
        print(f"INVALID: {args.plist}")
        for e in errors:
            print(f"  - {e}")
        return 1
    d = plistlib.loads(args.plist.read_bytes())
    state = "DISABLED (launchd won't run it)" if d.get("Disabled") else "ENABLED"
    print(f"OK: {args.plist} is a valid DRY_RUN-only launchd job; Disabled key says: {state}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

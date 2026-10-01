# Scheduled runs (launchd): DRY_RUN only

`com.gemini-mcp.dryrun.plist.template` runs `runner.py` three times a day in **DRY_RUN**. It ships **disabled** (`<key>Disabled</key><true/>`). Install steps are in `../RUNBOOK.md` under "Scheduling".

Before `launchctl bootstrap`, validate your filled-in copy:
- `python launchd/validate_plist.py ~/Library/LaunchAgents/com.gemini-mcp.dryrun.plist` checks it with Python's `plistlib` (works anywhere). It covers launchd's structure rules, the DRY_RUN-only rules, that no placeholders or secrets are left, and that the paths exist.
- `plutil -lint` is macOS's own syntax check.

## Why it can't go live

- It sets `DRY_RUN=true` and `GEMINI_MCP_SCHEDULE=dry_run_only` in its environment.
- `runner.py` refuses to start (exit code 3) whenever `GEMINI_MCP_SCHEDULE` is set and `DRY_RUN` isn't dry. Changing the plist's `DRY_RUN` to `false` therefore doesn't make the schedule live; the run just refuses to start.
- Even without that marker, a run with no terminal never confirms a live order unless **both** of these are true:
  - the runner is started with `--auto-confirm`;
  - `config.yaml` sets `runner_auto_confirm_live: true`.

  Without both, live proposals are logged as `proposed_not_confirmed` and nothing is placed.

## Live scheduling is not provided

Doing it would take a deliberate edit:
- remove `GEMINI_MCP_SCHEDULE`;
- set `DRY_RUN=false`;
- add `--auto-confirm` to `ProgramArguments`;
- set `runner_auto_confirm_live: true` in `config.yaml`.

Don't do this until the going-live criteria in the RUNBOOK are met, and you've run live from a terminal, approving each order, for a while.

## Stopping it

```bash
launchctl bootout gui/$(id -u)/com.gemini-mcp.dryrun   # unload now
launchctl disable gui/$(id -u)/com.gemini-mcp.dryrun   # keep it from loading at login
```

`touch gemini_mcp/KILL` also stops every order tool, scheduled or not.

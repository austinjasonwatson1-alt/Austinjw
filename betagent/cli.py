"""Command-line entry point: python -m betagent <command> [options]."""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import date, datetime
from typing import List, Optional
from zoneinfo import ZoneInfo

from . import config as cfgmod
from .display import render_slate
from .slate import build_slate


def _today(tz: str) -> date:
    return datetime.now(ZoneInfo(tz)).date()


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--date", help="slate date YYYY-MM-DD (default: today in config timezone)")
    p.add_argument("--league", action="append", help="limit to a league (repeatable): NFL, NCAAF, MLB, NHL")
    p.add_argument("--game", help="limit to games matching this text, e.g. 'yankees' or 'espn:401...'")
    p.add_argument("--config", help="path to config.yaml")
    p.add_argument("--dry-run", action="store_true", help="no paid API calls (cached data only) and no DB writes")
    p.add_argument("--refresh", action="store_true", help="ignore the cache and refetch everything")
    p.add_argument("-v", "--verbose", action="store_true")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="betagent", description="Sports betting research agent (recommends only; never bets).")
    sub = ap.add_subparsers(dest="command", required=True)

    s = sub.add_parser("slate", help="pull the day's games and odds, price the market, print it")
    _common(s)
    s.add_argument("--all-lines", action="store_true", help="show alternate spreads/totals too, not just the main line")
    return ap


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    cfg = cfgmod.load_config(args.config)
    day = date.fromisoformat(args.date) if args.date else _today(cfg["timezone"])
    leagues = [lg.upper() for lg in args.league] if args.league else None

    if args.command == "slate":
        slate = build_slate(cfg, day, leagues, args.game, cache_mode="refresh" if args.refresh else "normal",
                            allow_paid=not args.dry_run)
        print(render_slate(slate, cfg["timezone"], all_lines=args.all_lines))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())

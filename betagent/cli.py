"""Command-line entry point: python -m betagent <command> [options]."""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import date, datetime
from typing import List, Optional
from zoneinfo import ZoneInfo

from . import config as cfgmod
from .display import render_evaluation, render_slate
from .research.estimates import EstimatesError, evaluate, load_estimates
from .research.packet import build_packet, write_packet
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

    p = sub.add_parser("packet", help="write the research packet (priced slate) for the researcher")
    _common(p)

    e = sub.add_parser("evaluate", help="check the researcher's estimates against live prices (EV, edge, flags)")
    _common(e)
    e.add_argument("--estimates", help="path to estimates.json (default: data/research/<date>/estimates.json)")
    return ap


def research_dir(cfg, day: date):
    return cfgmod.resolve_path(cfg["research"]["dir"]) / day.isoformat()


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    cfg = cfgmod.load_config(args.config)
    day = date.fromisoformat(args.date) if args.date else _today(cfg["timezone"])
    leagues = [lg.upper() for lg in args.league] if args.league else None

    slate = build_slate(cfg, day, leagues, args.game, cache_mode="refresh" if args.refresh else "normal",
                        allow_paid=not args.dry_run)

    if args.command == "slate":
        print(render_slate(slate, cfg["timezone"], all_lines=args.all_lines))
        return 0

    if args.command == "packet":
        packet = build_packet(slate, cfg)
        jp, mp = write_packet(packet, research_dir(cfg, day))
        print(f"Research packet: {len(packet['games'])} games to research, {len(packet['skipped'])} skipped")
        print(f"  {mp}\n  {jp}")
        print(f"Researcher writes: {research_dir(cfg, day) / 'estimates.json'}  (instructions: prompts/research.md)")
        return 0

    if args.command == "evaluate":
        path = args.estimates or research_dir(cfg, day) / "estimates.json"
        try:
            research, warnings = load_estimates(path)
        except EstimatesError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        evaluated, more = evaluate(research, slate, cfg)
        print(render_evaluation(evaluated, warnings + more, cfg))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())

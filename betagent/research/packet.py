"""Research packet: the priced slate written out for the researcher (a Claude Code session).

The packet is the researcher's only view of the market. It lists every upcoming game with the
no-vig fair probability, the best price and book, every book's price, and line movement since
open for each main line. Games already started or without odds are listed as skipped.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .. import oddsmath as om
from ..display import fmt_point, local_time, side_label
from ..models import PricedGame, PricedSide
from ..slate import Slate


def _side_dict(pg: PricedGame, ps: PricedSide) -> Dict[str, Any]:
    return {
        "side": ps.side,
        "label": side_label(pg, ps),
        "point": ps.point,
        "fair_prob": round(ps.fair_prob, 4) if ps.fair_prob is not None else None,
        "best_price": om.fmt_decimal_as_american(ps.best_decimal),
        "best_book": ps.best_book,
        "prices": {b: om.fmt_decimal_as_american(d) for b, d in sorted(ps.prices.items())},
        "open": (f"{fmt_point(ps.market, ps.open_point)} " if ps.market != "moneyline" and ps.open_point is not None else "")
                + om.fmt_decimal_as_american(ps.open_decimal) if ps.open_decimal else None,
    }


def game_dict(pg: PricedGame, tz: str) -> Dict[str, Any]:
    g = pg.game
    return {
        "game_id": g.game_id,
        "league": g.league,
        "start": local_time(g.start, tz),
        "start_utc": g.start.isoformat(),
        "matchup": g.label,
        "away": g.away.name,
        "home": g.home.name,
        "venue": g.venue,
        "city": g.city,
        "indoor": g.indoor,
        "neutral_site": g.neutral_site,
        "season_type": g.season_type,
        "markets": [
            {"market": m.market, "line": m.point_key, "books": m.n_books,
             "sides": [_side_dict(pg, ps) for ps in m.sides.values()]}
            for m in pg.markets if m.is_main
        ],
        "alt_lines": sorted({f"{m.market} {m.point_key:g}" for m in pg.markets if not m.is_main and m.point_key is not None}),
    }


def build_packet(slate: Slate, cfg: Dict[str, Any], feedback: str = "") -> Dict[str, Any]:
    tz = cfg["timezone"]
    games: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []
    for pg in slate.games:
        g = pg.game
        if not g.is_upcoming:
            skipped.append({"game_id": g.game_id, "matchup": g.label, "reason": f"status {g.status} ({g.status_detail})"})
        elif not any(m.is_main for m in pg.markets):
            skipped.append({"game_id": g.game_id, "matchup": g.label, "reason": "no odds posted"})
        else:
            games.append(game_dict(pg, tz))
    cap = cfg["research"]["max_games"]
    for extra in games[cap:]:
        skipped.append({"game_id": extra["game_id"], "matchup": extra["matchup"], "reason": f"over research.max_games={cap}"})
    return {
        "date": slate.day.isoformat(),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "timezone": tz,
        "bet_types": cfg["bet_types"],
        "games": games[:cap],
        "skipped": skipped,
        "source_notes": slate.notes,
        "performance_feedback": feedback or "No graded history yet.",
    }


def render_packet_md(packet: Dict[str, Any]) -> str:
    out = [f"# Research packet - {packet['date']}", "",
           f"{len(packet['games'])} games to research. Prices are American odds; fair = no-vig consensus probability.", ""]
    out += ["## Recent performance (read before estimating)", "", packet["performance_feedback"], ""]
    for g in packet["games"]:
        flags = []
        if g["season_type"] and g["season_type"] != "regular-season":
            flags.append(g["season_type"])
        if g["indoor"] is False:
            flags.append("OUTDOOR - check weather")
        elif g["indoor"]:
            flags.append("indoor")
        if g["neutral_site"]:
            flags.append("neutral site")
        out.append(f"## {g['league']} - {g['matchup']}")
        out.append(f"`{g['game_id']}` - {g['start']} - {g['venue']}, {g['city']}" + (f" - {', '.join(flags)}" if flags else ""))
        out.append("")
        out.append("| market | side | fair | best | book | open | all books |")
        out.append("|---|---|---|---|---|---|---|")
        for m in g["markets"]:
            for s in m["sides"]:
                fair = f"{s['fair_prob'] * 100:.1f}%" if s["fair_prob"] is not None else "-"
                books = ", ".join(f"{b} {p}" for b, p in s["prices"].items())
                out.append(f"| {m['market']} | {s['label']} | {fair} | {s['best_price']} | {s['best_book']} | {s['open'] or ''} | {books} |")
        if g["alt_lines"]:
            out.append(f"\nAlternate lines available: {', '.join(g['alt_lines'])}")
        out.append("")
    if packet["skipped"]:
        out += ["## Not researched", ""] + [f"- {s['matchup']}: {s['reason']}" for s in packet["skipped"]] + [""]
    if packet["source_notes"]:
        out += ["## Source notes", ""] + [f"- {n}" for n in packet["source_notes"]]
    return "\n".join(out)


def write_packet(packet: Dict[str, Any], day_dir: Path) -> tuple[Path, Path]:
    day_dir.mkdir(parents=True, exist_ok=True)
    jp, mp = day_dir / "packet.json", day_dir / "packet.md"
    jp.write_text(json.dumps(packet, indent=2))
    mp.write_text(render_packet_md(packet))
    return jp, mp


def load_packet(day_dir: Path) -> Optional[Dict[str, Any]]:
    p = day_dir / "packet.json"
    return json.loads(p.read_text()) if p.exists() else None

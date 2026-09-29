"""Terminal rendering helpers for the priced slate."""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional
from zoneinfo import ZoneInfo

from . import oddsmath as om
from .models import PricedGame, PricedMarket, PricedSide
from .slate import Slate


def local_time(dt: datetime, tz: str) -> str:
    return dt.astimezone(ZoneInfo(tz)).strftime("%a %-I:%M %p %Z")


def fmt_point(market: str, point: Optional[float]) -> str:
    if point is None:
        return ""
    if market == "total":
        return f"{point:g}"
    return f"{point:+g}" if point != 0 else "PK"


def side_label(pg: PricedGame, ps: PricedSide) -> str:
    if ps.market == "total":
        return f"{ps.side.capitalize()} {fmt_point('total', ps.point)}"
    team = pg.game.team(ps.side)
    name = team.abbr or team.name
    return f"{name} {fmt_point(ps.market, ps.point)}".strip()


def fmt_prob(p: Optional[float]) -> str:
    return f"{p * 100:5.1f}%" if p is not None else "   -  "


def fmt_move(ps: PricedSide) -> str:
    if ps.open_decimal is None:
        return ""
    open_txt = om.fmt_decimal_as_american(ps.open_decimal)
    if ps.market != "moneyline" and ps.open_point is not None and ps.open_point != ps.point:
        open_txt = f"{fmt_point(ps.market, ps.open_point)} {open_txt}"
    return f"open {open_txt}"


def render_market(pg: PricedGame, m: PricedMarket) -> List[str]:
    lines = []
    for ps in m.sides.values():
        others = ", ".join(f"{b} {om.fmt_decimal_as_american(d)}" for b, d in sorted(ps.prices.items()) if b != ps.best_book)
        ev = ps.best_ev
        ev_txt = f"{ev * 100:+5.1f}%" if ev is not None else "   -  "
        lines.append(
            f"    {m.market[:5]:<5} {side_label(pg, ps):<14} fair {fmt_prob(ps.fair_prob)}"
            f"  best {om.fmt_decimal_as_american(ps.best_decimal):>5} {ps.best_book:<11}"
            f" mktEV {ev_txt}  {fmt_move(ps):<14} {('| ' + others) if others else ''}"
        )
    return lines


def render_slate(slate: Slate, tz: str, all_lines: bool = False) -> str:
    out = [f"SLATE {slate.day.isoformat()}  ({len(slate.games)} games)", ""]
    for pg in slate.games:
        g = pg.game
        tag = f" [{g.season_type}]" if g.season_type and g.season_type != "regular-season" else ""
        where = f" - {g.venue}" if g.venue else ""
        indoor = " (indoor)" if g.indoor else ""
        status = "" if g.is_upcoming else f"  <{g.status.upper()}: {g.status_detail}>"
        out.append(f"{g.league:<5} {local_time(g.start, tz):<16} {g.label}{where}{indoor}{tag}{status}")
        shown = [m for m in pg.markets if all_lines or m.is_main]
        if not shown:
            out.append("    (no odds posted)")
        for m in shown:
            out.extend(render_market(pg, m))
        out.append("")
    if slate.notes:
        out.append("Notes:")
        out.extend(f"  - {n}" for n in slate.notes)
    out.append("mktEV = EV at the best price if the no-vig consensus were exactly right (it is ~0 or negative "
               "unless one book is off-market). Real edge comes from research, not this column.")
    return "\n".join(out)


def bet_label(pg: PricedGame, ps: PricedSide) -> str:
    """Human description of the bet, e.g. 'New York Yankees ML', 'Boston Red Sox +1.5', 'BOS@NYY Over 8.5'."""
    if ps.market == "total":
        g = pg.game
        return f"{g.away.abbr or g.away.name}@{g.home.abbr or g.home.name} {ps.side.capitalize()} {fmt_point('total', ps.point)}"
    team = pg.game.team(ps.side).name
    return f"{team} ML" if ps.market == "moneyline" else f"{team} {fmt_point('spread', ps.point)}"


def render_evaluation(evaluated, warnings, cfg) -> str:
    """Every estimate vs the market, sorted by EV at the best price."""
    min_edge = cfg["selection"]["min_edge"]
    rows = sorted(evaluated, key=lambda e: e.ev, reverse=True)
    out = [f"{'bet':<34} {'ours':>6} {'fair':>6} {'diff':>6} {'best':>6} {'book':<11} {'EV':>6}  conf    notes", "-" * 104]
    for e in rows:
        fair = e.priced.fair_prob
        diff = e.edge_vs_fair
        mark = "EDGE" if e.ev >= min_edge and not e.flags else ""
        notes = ", ".join(([mark] if mark else []) + (["derived"] if e.derived else []) + e.flags)
        out.append(
            f"{e.game.game.league + ' ' + bet_label(e.game, e.priced):<34.34} {e.prob * 100:5.1f}% "
            f"{fmt_prob(fair)} {(f'{diff * 100:+5.1f}' if diff is not None else '   - '):>6} "
            f"{om.fmt_decimal_as_american(e.priced.best_decimal):>6} {e.priced.best_book:<11} {e.ev * 100:+5.1f}%  "
            f"{e.estimate.confidence:<7} {notes}"
        )
    n_edge = sum(1 for e in rows if e.ev >= min_edge and not e.flags)
    out += ["", f"{len(rows)} priced estimates, {n_edge} clear the {min_edge:.0%} EV bar at the best available price."]
    if warnings:
        out += ["", "Warnings:"] + [f"  - {w}" for w in warnings]
    return "\n".join(out)

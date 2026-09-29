"""ESPN public scoreboard: schedule, status, venue, final scores and DraftKings lines (open + current).

No API key. Endpoint: https://site.api.espn.com/apis/site/v2/sports/<path>/scoreboard?dates=YYYYMMDD
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from .. import oddsmath as om
from ..http import get_json
from ..leagues import League
from ..models import Game, Quote, Team

log = logging.getLogger(__name__)

BASE = "https://site.api.espn.com/apis/site/v2/sports"

_STATE = {"pre": "pre", "in": "in", "post": "post"}


def fetch_scoreboard(session, league: League, day: date) -> Dict[str, Any]:
    params = {"dates": day.strftime("%Y%m%d"), **league.espn_params}
    data, _ = get_json(session, f"{BASE}/{league.espn_path}/scoreboard", params=params)
    return data


def parse_scoreboard(data: Dict[str, Any], league: League) -> List[Game]:
    games: List[Game] = []
    for ev in data.get("events", []) or []:
        try:
            games.append(_parse_event(ev, league))
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            log.warning("Skipping malformed ESPN event %s: %s", ev.get("id"), exc)
    return games


def _parse_team(comp: Dict[str, Any]) -> Team:
    t = comp["team"]
    aliases = tuple(
        x for x in (t.get("shortDisplayName"), t.get("location"), t.get("name"),
                    f"{t.get('location', '')} {t.get('name', '')}".strip()) if x
    )
    score = comp.get("score")
    try:
        score_i = int(float(score)) if score not in (None, "") else None
    except (TypeError, ValueError):
        score_i = None
    return Team(name=t["displayName"], abbr=t.get("abbreviation", ""), aliases=aliases, score=score_i)


def _status(comp: Dict[str, Any]) -> tuple[str, str]:
    st = comp.get("status", {}).get("type", {})
    name = st.get("name", "")
    if name in ("STATUS_POSTPONED", "STATUS_SUSPENDED", "STATUS_DELAYED"):
        return "postponed", st.get("detail", name)
    if name in ("STATUS_CANCELED", "STATUS_CANCELLED"):
        return "canceled", st.get("detail", name)
    return _STATE.get(st.get("state", "pre"), "pre"), st.get("shortDetail") or st.get("detail", "")


def _parse_event(ev: Dict[str, Any], league: League) -> Game:
    comp = ev["competitions"][0]
    teams = {c["homeAway"]: c for c in comp["competitors"]}
    status, detail = _status(comp)
    venue = comp.get("venue") or {}
    addr = venue.get("address") or {}
    start = datetime.fromisoformat(ev["date"].replace("Z", "+00:00")).astimezone(timezone.utc)
    game = Game(
        league=league.code,
        start=start,
        home=_parse_team(teams["home"]),
        away=_parse_team(teams["away"]),
        game_id=f"espn:{ev['id']}",
        status=status,
        status_detail=detail,
        venue=venue.get("fullName", ""),
        city=", ".join(x for x in (addr.get("city"), addr.get("state")) if x),
        indoor=venue.get("indoor"),
        neutral_site=bool(comp.get("neutralSite")),
        season_type=(ev.get("season") or {}).get("slug", ""),
        source_ids={"espn": str(ev["id"])},
    )
    odds = comp.get("odds") or []
    if odds:
        game.quotes.extend(parse_odds(odds[0]))
    return game


def _num(x) -> Optional[float]:
    if x is None:
        return None
    s = str(x).strip().lower().lstrip("ou")
    if s in ("", "off", "--"):
        return None
    if s in ("pk", "pick", "even"):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return None


def _dec(american) -> Optional[float]:
    if american in (None, "", "OFF", "--"):
        return None
    try:
        return om.american_to_decimal(om.parse_american(american))
    except (ValueError, om.OddsError):
        return None


def parse_odds(o: Dict[str, Any]) -> List[Quote]:
    """Parse one ESPN odds provider block into quotes (current + opening)."""
    book = (o.get("provider") or {}).get("name") or "ESPN"
    quotes: List[Quote] = []

    def add(market, side, block, is_open, point_field=True):
        if not block:
            return
        d = _dec(block.get("odds"))
        if d is None:
            return
        point = _num(block.get("line")) if point_field else None
        if point_field and point is None:
            return
        quotes.append(Quote(book=book, market=market, side=side, decimal=d, point=point, is_open=is_open))

    for key, is_open in (("close", False), ("open", True)):
        ml = o.get("moneyline") or {}
        add("moneyline", "home", (ml.get("home") or {}).get(key), is_open, point_field=False)
        add("moneyline", "away", (ml.get("away") or {}).get(key), is_open, point_field=False)
        ps = o.get("pointSpread") or {}
        add("spread", "home", (ps.get("home") or {}).get(key), is_open)
        add("spread", "away", (ps.get("away") or {}).get(key), is_open)
        tot = o.get("total") or {}
        add("total", "over", (tot.get("over") or {}).get(key), is_open)
        add("total", "under", (tot.get("under") or {}).get(key), is_open)

    if not any(not q.is_open for q in quotes):
        quotes.extend(_parse_legacy_odds(o, book))
    return quotes


def _parse_legacy_odds(o: Dict[str, Any], book: str) -> List[Quote]:
    """Older ESPN format: homeTeamOdds.moneyLine / spreadOdds, overUnder / overOdds / underOdds."""
    out: List[Quote] = []
    h, a = o.get("homeTeamOdds") or {}, o.get("awayTeamOdds") or {}
    for side, blk in (("home", h), ("away", a)):
        d = _dec(blk.get("moneyLine"))
        if d:
            out.append(Quote(book, "moneyline", side, d))
    spread = o.get("spread")
    if spread is not None:
        home_pt = float(spread)  # ESPN's `spread` is the home line ("ND -21" at UNC -> +21.0)
        for side, blk, pt in (("home", h, home_pt), ("away", a, -home_pt)):
            d = _dec(blk.get("spreadOdds"))
            if d:
                out.append(Quote(book, "spread", side, d, point=pt))
    ou = o.get("overUnder")
    if ou is not None:
        for side, key in (("over", "overOdds"), ("under", "underOdds")):
            d = _dec(o.get(key))
            if d:
                out.append(Quote(book, "total", side, d, point=float(ou)))
    return out

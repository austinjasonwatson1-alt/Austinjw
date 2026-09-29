"""Polymarket (Gamma API): moneyline / spread / total prices on the market you actually bet into.

No API key. A share bought at price p pays $1, so decimal odds = 1 / p.
bestBid / bestAsk on a market refer to its FIRST outcome; the second outcome is
bought at 1 - bestBid.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from .. import oddsmath as om
from ..http import SourceError, get_json
from ..leagues import League
from ..models import Game, Quote
from ..teams import match_game, match_side

log = logging.getLogger(__name__)

BASE = "https://gamma-api.polymarket.com"
BOOK = "Polymarket"
_TYPES = {"moneyline": "moneyline", "spreads": "spread", "totals": "total"}
PAGE = 100


def fetch_series_id(session, league: League) -> str:
    try:
        data, _ = get_json(session, f"{BASE}/sports")
        for s in data:
            if s.get("sport") == league.polymarket_sport and s.get("series"):
                return str(s["series"])
    except SourceError as exc:
        log.warning("Polymarket /sports lookup failed (%s); using built-in series id", exc)
    return league.polymarket_series


def fetch_events(session, series_id: str, start_utc: datetime, end_utc: datetime, max_pages: int = 10) -> List[Dict[str, Any]]:
    """All open game events whose game start time falls in [start_utc, end_utc].

    Filter on start_time, not end_date: postseason events carry an end date days after the game.
    """
    out: List[Dict[str, Any]] = []
    for page in range(max_pages):
        params = {
            "series_id": series_id,
            "closed": "false",
            "limit": PAGE,
            "offset": page * PAGE,
            "start_time_min": start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "start_time_max": end_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        batch, _ = get_json(session, f"{BASE}/events", params=params)
        out.extend(_slim_event(e) for e in batch if _is_game_event(e))
        if len(batch) < PAGE:
            break
    return out


def _is_game_event(e: Dict[str, Any]) -> bool:
    return any(m.get("sportsMarketType") in _TYPES for m in e.get("markets") or [])


def _slim_event(e: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only what we need so the cache stays small."""
    keep = ("question", "outcomes", "outcomePrices", "sportsMarketType", "line", "bestBid", "bestAsk",
            "liquidityNum", "active", "closed", "gameStartTime", "slug")
    return {
        "title": e.get("title"), "slug": e.get("slug"), "startTime": e.get("startTime") or e.get("endDate"),
        "gameId": e.get("gameId"),
        "markets": [{k: m.get(k) for k in keep} for m in e.get("markets") or [] if m.get("sportsMarketType") in _TYPES],
    }


def _outcomes(m: Dict[str, Any]) -> List[str]:
    o = m.get("outcomes")
    if isinstance(o, str):
        try:
            o = json.loads(o)
        except json.JSONDecodeError:
            return []
    return list(o or [])


def _f(x) -> Optional[float]:
    try:
        return float(x) if x not in (None, "") else None
    except (TypeError, ValueError):
        return None


def attach_quotes(events: List[Dict[str, Any]], games: List[Game], min_liquidity: float = 1000.0,
                  max_spread: float = 0.05, fee: float = 0.0) -> int:
    """Match Polymarket events to games and append Quote objects. Returns markets attached."""
    attached = 0
    for e in events:
        mkts = e.get("markets") or []
        ml = next((m for m in mkts if m.get("sportsMarketType") == "moneyline"), None)
        names = _outcomes(ml) if ml else []
        if len(names) != 2:
            title = e.get("title") or ""
            names = [p.strip() for p in title.split(" vs. ")] if " vs. " in title else []
        if len(names) != 2:
            continue
        start = None
        if e.get("startTime"):
            start = datetime.fromisoformat(e["startTime"].replace("Z", "+00:00"))
        game = match_game(names, games, start=start)
        if game is None:
            log.debug("Polymarket event %s matched no game", e.get("slug"))
            continue
        game.source_ids.setdefault("polymarket", e.get("slug") or "")
        for m in mkts:
            quotes = market_quotes(m, game, min_liquidity, max_spread, fee)
            if quotes:
                game.quotes.extend(quotes)
                attached += 1
    return attached


def market_quotes(m: Dict[str, Any], game: Game, min_liquidity: float, max_spread: float, fee: float) -> List[Quote]:
    market = _TYPES.get(m.get("sportsMarketType"))
    if market is None or m.get("closed") or m.get("active") is False:
        return []
    bid, ask, liq = _f(m.get("bestBid")), _f(m.get("bestAsk")), _f(m.get("liquidityNum")) or 0.0
    if bid is None or ask is None or not 0 < bid < ask < 1:
        return []
    if liq < min_liquidity or ask - bid > max_spread:
        return []
    outs = _outcomes(m)
    if len(outs) != 2:
        return []

    if market == "total":
        line = _f(m.get("line"))
        if line is None:
            return []
        sides, points = ("over", "under"), (line, line)
        if [o.lower() for o in outs] != ["over", "under"]:
            return []
    else:
        s0 = match_side(outs[0], game)
        s1 = match_side(outs[1], game)
        if s0 is None or s1 is None or s0 == s1:
            return []
        sides = (s0, s1)
        if market == "spread":
            line = _f(m.get("line"))
            if line is None:
                return []
            points = (line, -line)
        else:
            points = (None, None)

    mid0 = (bid + ask) / 2.0
    try:
        d0 = om.share_price_to_decimal(ask, fee)
        d1 = om.share_price_to_decimal(1.0 - bid, fee)
    except om.OddsError:
        return []
    return [
        Quote(BOOK, market, sides[0], d0, points[0], liquidity=liq, mid_prob=mid0),
        Quote(BOOK, market, sides[1], d1, points[1], liquidity=liq, mid_prob=1.0 - mid0),
    ]

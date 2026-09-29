"""The Odds API (the-odds-api.com): multi-book prices for line shopping. Optional; needs ODDS_API_KEY.

Credit cost per call = (#markets) x (#regions). One call per league per day
(h2h,spreads,totals x us) = 3 credits; the cache makes same-day reruns free.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from ..http import get_json
from ..leagues import League
from ..models import Game, Quote, Team
from ..teams import match_game, match_side

log = logging.getLogger(__name__)

BASE = "https://api.the-odds-api.com/v4"
_MARKETS = {"h2h": "moneyline", "spreads": "spread", "totals": "total"}


def fetch_odds(session, api_key: str, league: League, start_utc: datetime, end_utc: datetime,
               regions: str = "us", bookmakers: Optional[List[str]] = None) -> Dict[str, Any]:
    params = {
        "apiKey": api_key,
        "markets": "h2h,spreads,totals",
        "oddsFormat": "decimal",
        "dateFormat": "iso",
        "commenceTimeFrom": start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "commenceTimeTo": end_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if bookmakers:
        params["bookmakers"] = ",".join(bookmakers)
    else:
        params["regions"] = regions
    data, headers = get_json(session, f"{BASE}/sports/{league.odds_api_key}/odds", params=params)
    remaining = headers.get("x-requests-remaining")
    if remaining is not None:
        log.info("Odds API credits remaining: %s", remaining)
    return {"events": data, "credits_remaining": remaining}


def event_to_game(ev: Dict[str, Any], league: League) -> Game:
    start = datetime.fromisoformat(ev["commence_time"].replace("Z", "+00:00"))
    return Game(league=league.code, start=start, home=Team(ev["home_team"]), away=Team(ev["away_team"]),
                game_id=f"oddsapi:{ev['id']}", source_ids={"odds_api": ev["id"]})


def attach_quotes(events: List[Dict[str, Any]], games: List[Game], league: League) -> List[Game]:
    """Attach bookmaker quotes to matching games. Events with no ESPN match become new games.

    Returns the list of newly created games (used when ESPN is unavailable).
    """
    new_games: List[Game] = []
    for ev in events:
        start = datetime.fromisoformat(ev["commence_time"].replace("Z", "+00:00"))
        game = match_game([ev["away_team"], ev["home_team"]], games, start=start)
        if game is None:
            game = event_to_game(ev, league)
            new_games.append(game)
        game.source_ids.setdefault("odds_api", ev["id"])
        for bm in ev.get("bookmakers", []):
            game.quotes.extend(bookmaker_quotes(bm, game, ev))
    return new_games


def bookmaker_quotes(bm: Dict[str, Any], game: Game, ev: Dict[str, Any]) -> List[Quote]:
    book = bm.get("title") or bm.get("key", "?")
    out: List[Quote] = []
    for mk in bm.get("markets", []):
        market = _MARKETS.get(mk.get("key"))
        if market is None:
            continue
        for oc in mk.get("outcomes", []):
            name, price, point = oc.get("name", ""), oc.get("price"), oc.get("point")
            if price is None or price <= 1.0:
                continue
            if market == "total":
                side = name.lower()
                if side not in ("over", "under"):
                    continue
            else:
                # Odds API names teams exactly as in home_team / away_team.
                if name == ev.get("home_team"):
                    side = "home"
                elif name == ev.get("away_team"):
                    side = "away"
                else:
                    side = match_side(name, game)
                    if side is None:
                        continue
            if market in ("spread", "total") and point is None:
                continue
            out.append(Quote(book, market, side, float(price), None if market == "moneyline" else float(point)))
    return out

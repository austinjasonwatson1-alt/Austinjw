"""Build the day's priced slate: schedule + odds from every source, merged and priced per game."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from . import config as cfgmod
from .cache import Cache
from .http import SourceError, make_session
from .leagues import League, get_league
from .market import price_game
from .models import Game, PricedGame
from .sources import espn, oddsapi, polymarket

log = logging.getLogger(__name__)


@dataclass
class Slate:
    day: date
    games: List[PricedGame]
    notes: List[str] = field(default_factory=list)       # source health, credits, fallbacks


def day_window_utc(day: date, tz: str) -> tuple[datetime, datetime]:
    z = ZoneInfo(tz)
    start = datetime.combine(day, time(0, 0), tzinfo=z)
    end = start + timedelta(days=1) - timedelta(seconds=1)
    return start.astimezone(ZoneInfo("UTC")), end.astimezone(ZoneInfo("UTC"))


def game_matches(game: Game, needle: Optional[str]) -> bool:
    if not needle:
        return True
    n = needle.lower()
    hay = " ".join([game.game_id, *game.home.all_names(), *game.away.all_names()]).lower()
    return all(part in hay for part in n.split())


def load_games(cfg: Dict[str, Any], league: League, day: date, cache: Cache, session,
               allow_paid: bool, notes: List[str]) -> List[Game]:
    src = cfg["sources"]
    free_ttl = cfg["cache"]["free_ttl_minutes"]
    start_utc, end_utc = day_window_utc(day, cfg["timezone"])
    games: List[Game] = []

    if src["espn"]["enabled"]:
        try:
            raw = cache.fetch("espn", league.code, lambda: espn.fetch_scoreboard(session, league, day), free_ttl)
            if raw is not None:
                games = espn.parse_scoreboard(raw, league)
        except SourceError as exc:
            notes.append(f"{league.code}: ESPN unavailable ({exc}); schedule falls back to other sources")

    key = cfgmod.odds_api_key()
    oa_enabled = src["odds_api"]["enabled"]
    if key and oa_enabled in (True, "auto"):
        if allow_paid or cache.get("odds_api", league.code) is not None:
            prev_mode = cache.mode
            if not allow_paid:
                cache.mode = "offline"   # dry-run: cached data only, never spend credits
            try:
                raw = cache.fetch(
                    "odds_api", league.code,
                    lambda: oddsapi.fetch_odds(session, key, league, start_utc, end_utc,
                                               src["odds_api"]["regions"], src["odds_api"]["bookmakers"]),
                    cfg["cache"]["paid_ttl_minutes"],
                )
                if raw is not None:
                    games.extend(oddsapi.attach_quotes(raw["events"], games, league))
                    if raw.get("credits_remaining") is not None:
                        notes.append(f"Odds API credits remaining: {raw['credits_remaining']}")
            except SourceError as exc:
                notes.append(f"{league.code}: Odds API unavailable ({exc})")
            finally:
                cache.mode = prev_mode
        else:
            notes.append(f"{league.code}: dry run - skipped Odds API (no cached copy)")
    elif oa_enabled is True and not key:
        notes.append("Odds API enabled but ODDS_API_KEY is not set")

    pm = src["polymarket"]
    if pm["enabled"] and games:
        try:
            series = cache.fetch("polymarket", f"series_{league.code}",
                                 lambda: polymarket.fetch_series_id(session, league), ttl_minutes=24 * 60)
            # Pad the window: ESPN and Polymarket disagree on TBD/late kickoff times; matching checks time anyway.
            pad = timedelta(hours=6)
            events = cache.fetch("polymarket", league.code,
                                 lambda: polymarket.fetch_events(session, series, start_utc - pad, end_utc + pad), free_ttl)
            if events:
                polymarket.attach_quotes(events, games, pm["min_liquidity"], pm["max_spread"], pm["fee_per_share"])
        except SourceError as exc:
            notes.append(f"{league.code}: Polymarket unavailable ({exc})")
    return games


def build_slate(cfg: Dict[str, Any], day: date, leagues: Optional[List[str]] = None, game_filter: Optional[str] = None,
                cache_mode: str = "normal", allow_paid: bool = True, session=None) -> Slate:
    session = session or make_session()
    cache = Cache(cfgmod.resolve_path(cfg["cache"]["dir"]), day.isoformat(), cache_mode)
    notes: List[str] = []
    priced: List[PricedGame] = []
    for code in leagues or cfg["leagues"]:
        league = get_league(code)
        games = [g for g in load_games(cfg, league, day, cache, session, allow_paid, notes) if game_matches(g, game_filter)]
        for g in games:
            priced.append(price_game(g, cfg["pricing"]["devig_method"], cfg["pricing"]["book_weights"]))
    priced.sort(key=lambda pg: (pg.game.start, pg.game.league))
    return Slate(day=day, games=priced, notes=notes)

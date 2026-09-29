"""League registry: how each league is addressed by each data source."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict


@dataclass(frozen=True)
class League:
    code: str
    name: str
    espn_path: str               # site.api.espn.com/apis/site/v2/sports/<espn_path>/scoreboard
    odds_api_key: str            # The Odds API sport key
    polymarket_sport: str        # gamma-api.polymarket.com/sports "sport" code
    polymarket_series: str       # fallback series id if /sports lookup fails
    espn_params: Dict[str, str] = field(default_factory=dict)
    outdoor: bool = True         # weather matters (per-venue indoor flag from ESPN overrides)


LEAGUES: Dict[str, League] = {
    "NFL": League("NFL", "NFL", "football/nfl", "americanfootball_nfl", "nfl", "12185"),
    "NCAAF": League(
        "NCAAF", "College Football", "football/college-football", "americanfootball_ncaaf", "cfb", "12756",
        # Without groups=80 ESPN only returns Top-25 games.
        espn_params={"groups": "80", "limit": "400"},
    ),
    "MLB": League("MLB", "MLB", "baseball/mlb", "baseball_mlb", "mlb", "3"),
    "NHL": League("NHL", "NHL", "hockey/nhl", "icehockey_nhl", "nhl", "10346", outdoor=False),
}


def get_league(code: str) -> League:
    try:
        return LEAGUES[code.upper()]
    except KeyError:
        raise KeyError(f"Unknown league {code!r}; supported: {sorted(LEAGUES)}") from None

"""Core data types shared by the odds pipeline, research, cards and tracking."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Tuple

# Market keys and the sides each one has.
MARKETS = ("moneyline", "spread", "total")
SIDES = {"moneyline": ("away", "home"), "spread": ("away", "home"), "total": ("over", "under")}


@dataclass
class Team:
    name: str                                  # full display name, e.g. "New York Yankees"
    abbr: str = ""
    aliases: Tuple[str, ...] = ()              # other names sources use ("Yankees", "NY Yankees")
    score: Optional[int] = None

    def all_names(self) -> Tuple[str, ...]:
        return (self.name, self.abbr, *self.aliases)


@dataclass
class Quote:
    """One price for one side of one market at one book.

    `point` is from the perspective of `side`: a home spread of -1.5 is
    Quote(side="home", point=-1.5) and the away side is point=+1.5. For totals
    the point is the total for both over and under.
    """
    book: str
    market: str
    side: str
    decimal: float
    point: Optional[float] = None
    is_open: bool = False                      # opening line (for line movement), not a live price
    liquidity: Optional[float] = None          # prediction markets only
    mid_prob: Optional[float] = None           # prediction markets: mid-price probability


@dataclass
class Game:
    league: str
    start: datetime                            # timezone-aware UTC
    home: Team
    away: Team
    game_id: str                               # stable id (ESPN event id when available)
    status: str = "pre"                        # pre | in | post | postponed | canceled
    status_detail: str = ""
    venue: str = ""
    city: str = ""
    indoor: Optional[bool] = None
    neutral_site: bool = False
    season_type: str = ""                      # "regular-season", "post-season", ...
    quotes: List[Quote] = field(default_factory=list)
    source_ids: Dict[str, str] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)

    @property
    def label(self) -> str:
        sep = " vs " if self.neutral_site else " @ "
        return f"{self.away.name}{sep}{self.home.name}"

    @property
    def is_upcoming(self) -> bool:
        return self.status == "pre"

    def team(self, side: str) -> Team:
        return self.home if side == "home" else self.away


@dataclass
class PricedSide:
    """One side of one market line, priced across books."""
    market: str
    side: str
    point: Optional[float]
    fair_prob: Optional[float]                 # no-vig consensus probability
    best_decimal: float
    best_book: str
    prices: Dict[str, float]                   # book -> decimal
    n_books_fair: int                          # books that contributed to the fair price
    open_decimal: Optional[float] = None
    open_point: Optional[float] = None

    @property
    def best_ev(self) -> Optional[float]:
        """EV of betting at the best price if the fair price were the true probability."""
        if self.fair_prob is None:
            return None
        return self.fair_prob * self.best_decimal - 1.0


@dataclass
class PricedMarket:
    market: str
    point_key: Optional[float]                 # home spread / total; None for moneyline
    sides: Dict[str, PricedSide]
    is_main: bool = True
    n_books: int = 0


@dataclass
class PricedGame:
    game: Game
    markets: List[PricedMarket]

    def main(self, market: str) -> Optional[PricedMarket]:
        for m in self.markets:
            if m.market == market and m.is_main:
                return m
        return None

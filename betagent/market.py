"""Price the market: group quotes by line, remove vig per book, build a weighted no-vig
consensus ("fair") probability, and find the best available price per side (line shopping)."""
from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional, Tuple

from . import oddsmath as om
from .models import SIDES, Game, PricedGame, PricedMarket, PricedSide, Quote


def line_key(q: Quote) -> Optional[float]:
    """Identify a line from the home-team / total perspective so both sides group together."""
    if q.market == "moneyline":
        return None
    if q.market == "spread":
        return q.point if q.side == "home" else -q.point
    return q.point


def book_weight(book: str, weights: Dict[str, float]) -> float:
    return float(weights.get(book.lower(), weights.get("default", 1.0)))


def book_fair_probs(quotes: Dict[str, Quote], sides: Tuple[str, str], method: str) -> Optional[Dict[str, float]]:
    """No-vig probabilities from one book's two-sided market (None if a side is missing)."""
    if not all(s in quotes for s in sides):
        return None
    a, b = quotes[sides[0]], quotes[sides[1]]
    if a.mid_prob is not None and b.mid_prob is not None:
        # Prediction market: the bid/ask midpoint is already a vig-free probability.
        total = a.mid_prob + b.mid_prob
        return {sides[0]: a.mid_prob / total, sides[1]: b.mid_prob / total}
    fair = om.devig([om.implied_prob(a.decimal), om.implied_prob(b.decimal)], method)
    return dict(zip(sides, fair))


def price_game(game: Game, method: str = "multiplicative", weights: Optional[Dict[str, float]] = None) -> PricedGame:
    weights = weights or {"default": 1.0}
    groups: Dict[Tuple[str, Optional[float]], Dict[str, Dict[str, Quote]]] = defaultdict(lambda: defaultdict(dict))
    for q in game.quotes:
        if q.is_open:
            continue
        book_sides = groups[(q.market, line_key(q))][q.book]
        prev = book_sides.get(q.side)
        if prev is None or q.decimal > prev.decimal:
            book_sides[q.side] = q

    opens: Dict[Tuple[str, str], Quote] = {}
    for q in game.quotes:
        if q.is_open:
            opens.setdefault((q.market, q.side), q)

    markets: List[PricedMarket] = []
    for (market, key), by_book in groups.items():
        sides = SIDES[market]
        fair_parts: Dict[str, List[Tuple[float, float]]] = {s: [] for s in sides}
        for book, qs in by_book.items():
            fp = book_fair_probs(qs, sides, method)
            if fp:
                w = book_weight(book, weights)
                for s in sides:
                    fair_parts[s].append((fp[s], w))
        priced: Dict[str, PricedSide] = {}
        for s in sides:
            prices = {book: qs[s].decimal for book, qs in by_book.items() if s in qs}
            if not prices:
                continue
            best_book = max(prices, key=prices.get)
            parts = fair_parts[s]
            fair = om.weighted_consensus([p for p, _ in parts], [w for _, w in parts]) if parts else None
            op = opens.get((market, s))
            point = None
            if market != "moneyline":
                point = key if (market == "total" or s == "home") else -key
            priced[s] = PricedSide(
                market=market, side=s, point=point, fair_prob=fair,
                best_decimal=prices[best_book], best_book=best_book, prices=prices,
                n_books_fair=len(parts),
                open_decimal=op.decimal if op else None, open_point=op.point if op else None,
            )
        if priced:
            markets.append(PricedMarket(market=market, point_key=key, sides=priced, n_books=len(by_book)))

    _mark_main_lines(markets)
    for m in markets:
        if not m.is_main:  # the opening line refers to the main line only
            for ps in m.sides.values():
                ps.open_decimal = ps.open_point = None
    order = {m: i for i, m in enumerate(SIDES)}
    markets.sort(key=lambda m: (order[m.market], not m.is_main, m.point_key or 0))
    return PricedGame(game=game, markets=markets)


def _balance(m: PricedMarket) -> float:
    fairs = [s.fair_prob for s in m.sides.values() if s.fair_prob is not None]
    return abs(fairs[0] - 0.5) if fairs else 1.0


def _mark_main_lines(markets: List[PricedMarket]) -> None:
    """Main line per market = the line most sportsbooks hang (ties: closest to 50/50).

    Prediction markets list many alternate lines at similar depth, so sportsbook
    count decides first.
    """
    by_market: Dict[str, List[PricedMarket]] = defaultdict(list)
    for m in markets:
        by_market[m.market].append(m)
    for group in by_market.values():
        def rank(m: PricedMarket):
            books = set().union(*(s.prices.keys() for s in m.sides.values()))
            sportsbooks = len([b for b in books if b != "Polymarket"])
            return (-sportsbooks, -len(books), _balance(m))
        group.sort(key=rank)
        for i, m in enumerate(group):
            m.is_main = i == 0

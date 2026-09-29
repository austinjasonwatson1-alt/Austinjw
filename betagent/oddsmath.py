"""Odds math: conversions, implied probability, vig removal, edge, Kelly sizing, parlays.

Everything here is pure and heavily tested, because a silent mistake in this file
corrupts every downstream number (fair prices, edges, stakes, results).

Conventions
-----------
* "decimal" odds include the stake: +150 American == 2.50 decimal.
* Probabilities are floats in (0, 1).
* A prediction-market share price (Polymarket) of p dollars pays $1, so its
  decimal odds are 1 / p.
"""
from __future__ import annotations

import math
from typing import Iterable, List, Sequence

DEVIG_METHODS = ("multiplicative", "additive", "power")


class OddsError(ValueError):
    """Raised for impossible odds or probabilities."""


# --------------------------------------------------------------------------- conversions
def american_to_decimal(american: float) -> float:
    a = float(american)
    if -100 < a < 100:
        raise OddsError(f"American odds must be <= -100 or >= +100, got {american}")
    return 1.0 + (a / 100.0 if a > 0 else 100.0 / -a)


def decimal_to_american(decimal: float) -> float:
    d = float(decimal)
    if d <= 1.0:
        raise OddsError(f"Decimal odds must be > 1.0, got {decimal}")
    return (d - 1.0) * 100.0 if d >= 2.0 else -100.0 / (d - 1.0)


def parse_american(text) -> float:
    """Parse ESPN-style odds strings: '+105', '-125', 'EVEN', 'PK'. Returns American odds."""
    if isinstance(text, (int, float)):
        return float(text)
    s = str(text).strip().upper()
    if s in ("EVEN", "EV", "PK", "PICK"):
        return 100.0
    return float(s.replace("+", ""))


def implied_prob(decimal: float) -> float:
    d = float(decimal)
    if d <= 1.0:
        raise OddsError(f"Decimal odds must be > 1.0, got {decimal}")
    return 1.0 / d


def prob_to_decimal(p: float) -> float:
    _check_prob(p)
    return 1.0 / p


def prob_to_american(p: float) -> float:
    return decimal_to_american(prob_to_decimal(p))


def share_price_to_decimal(price: float, fee: float = 0.0) -> float:
    """Prediction-market share price -> decimal odds. `fee` is a per-share cost added to the price."""
    cost = float(price) + float(fee)
    if not 0.0 < cost < 1.0:
        raise OddsError(f"Share price (+fee) must be in (0, 1), got {cost}")
    return 1.0 / cost


def fmt_american(american: float) -> str:
    a = round(american)
    return f"+{a}" if a > 0 else str(a)


def fmt_decimal_as_american(decimal: float) -> str:
    return fmt_american(decimal_to_american(decimal))


# --------------------------------------------------------------------------- vig removal
def overround(implied: Sequence[float]) -> float:
    """Bookmaker margin: sum of implied probabilities minus 1 (e.g. -110/-110 -> 0.0476)."""
    return sum(implied) - 1.0


def devig(implied: Sequence[float], method: str = "multiplicative") -> List[float]:
    """Remove the bookmaker margin from a complete set of implied probabilities.

    multiplicative: p_i / sum(p)                    (proportional; the standard default)
    additive:       p_i - margin / n                (equal margin per outcome)
    power:          p_i ** k with k s.t. sum = 1    (shades favourite-longshot bias)
    """
    probs = [float(p) for p in implied]
    if len(probs) < 2:
        raise OddsError("Need at least two outcomes to remove vig")
    for p in probs:
        _check_prob(p)
    total = sum(probs)

    if method == "multiplicative":
        return [p / total for p in probs]

    if method == "additive":
        margin = (total - 1.0) / len(probs)
        out = [p - margin for p in probs]
        if min(out) <= 0.0:  # additive can go negative for extreme longshots; fall back
            return devig(probs, "multiplicative")
        return out

    if method == "power":
        if abs(total - 1.0) < 1e-12:
            return list(probs)
        # sum(p_i ** k) is strictly decreasing in k; bisect for sum == 1.
        lo, hi = (1.0, 50.0) if total > 1.0 else (0.01, 1.0)
        for _ in range(200):
            mid = (lo + hi) / 2.0
            s = sum(p ** mid for p in probs)
            if s > 1.0:
                lo = mid
            else:
                hi = mid
        k = (lo + hi) / 2.0
        out = [p ** k for p in probs]
        s = sum(out)
        return [p / s for p in out]

    raise OddsError(f"Unknown devig method {method!r}; choose from {DEVIG_METHODS}")


def devig_two_way_decimal(dec_a: float, dec_b: float, method: str = "multiplicative") -> List[float]:
    return devig([implied_prob(dec_a), implied_prob(dec_b)], method)


def weighted_consensus(probs: Sequence[float], weights: Sequence[float]) -> float:
    if not probs or len(probs) != len(weights):
        raise OddsError("probs and weights must be non-empty and the same length")
    wsum = sum(weights)
    if wsum <= 0:
        raise OddsError("weights must sum to a positive number")
    return sum(p * w for p, w in zip(probs, weights)) / wsum


# --------------------------------------------------------------------------- edge + sizing
def expected_value(p: float, decimal: float) -> float:
    """EV per 1 unit staked: p * (d - 1) - (1 - p) == p * d - 1."""
    _check_prob(p)
    return p * float(decimal) - 1.0


def prob_edge(p_model: float, p_fair: float) -> float:
    """Percentage-point edge of our probability over the no-vig market probability."""
    return p_model - p_fair


def min_decimal_for_edge(p: float, min_ev: float) -> float:
    """Smallest decimal price at which a bet with win probability p still has EV >= min_ev."""
    _check_prob(p)
    return (1.0 + min_ev) / p


def kelly_fraction(p: float, decimal: float) -> float:
    """Full-Kelly fraction of bankroll: (b*p - q) / b with b = d - 1. Zero when EV <= 0."""
    _check_prob(p)
    b = float(decimal) - 1.0
    if b <= 0:
        raise OddsError(f"Decimal odds must be > 1.0, got {decimal}")
    return max(0.0, (b * p - (1.0 - p)) / b)


def kelly_stake_units(
    p: float,
    decimal: float,
    bankroll_units: float,
    kelly_multiplier: float = 0.25,
    max_units: float | None = None,
    round_to: float = 0.0,
) -> float:
    """Fractional-Kelly stake expressed in units, capped at max_units and rounded down."""
    if bankroll_units <= 0:
        raise OddsError("bankroll_units must be positive")
    if not 0.0 < kelly_multiplier <= 1.0:
        raise OddsError("kelly_multiplier must be in (0, 1]")
    stake = kelly_fraction(p, decimal) * kelly_multiplier * bankroll_units
    if max_units is not None:
        stake = min(stake, max_units)
    if round_to and round_to > 0:
        stake = math.floor(stake / round_to + 1e-9) * round_to
    return max(0.0, stake)


def scale_to_cap(stakes: Sequence[float], cap: float | None) -> List[float]:
    """Proportionally shrink a set of stakes so their total does not exceed cap."""
    total = sum(stakes)
    if cap is None or total <= cap or total == 0:
        return list(stakes)
    return [s * cap / total for s in stakes]


# --------------------------------------------------------------------------- parlays
def parlay_decimal(decimals: Iterable[float]) -> float:
    out = 1.0
    for d in decimals:
        if d <= 1.0:
            raise OddsError(f"Decimal odds must be > 1.0, got {d}")
        out *= d
    return out


def parlay_prob(probs: Iterable[float]) -> float:
    """Joint win probability assuming independent legs (only valid across different games)."""
    out = 1.0
    for p in probs:
        _check_prob(p)
        out *= p
    return out


# --------------------------------------------------------------------------- settlement
def profit_units(result: str, stake: float, decimal: float) -> float:
    """Units won/lost for a settled bet. result in {'win','loss','push','void'}."""
    if result == "win":
        return stake * (decimal - 1.0)
    if result == "loss":
        return -stake
    if result in ("push", "void"):
        return 0.0
    raise OddsError(f"Unknown result {result!r}")


def _check_prob(p: float) -> None:
    if not 0.0 < float(p) < 1.0:
        raise OddsError(f"Probability must be in (0, 1), got {p}")

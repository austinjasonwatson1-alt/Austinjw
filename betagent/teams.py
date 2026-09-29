"""Team-name normalization and matching across data sources."""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable, Optional

from .models import Game, Team

# Applied after punctuation is stripped, so patterns see plain lowercase words.
_REPLACEMENTS = [
    (r"\bst\b", "state"),                     # "Michigan St." -> "michigan state"
    (r"\blouisiana monroe\b", "ul monroe"),    # Polymarket "Louisiana-Monroe" == ESPN "UL Monroe"
    (r"\blouisiana lafayette\b", "louisiana"),
    (r"\bmiami fl\b", "miami"),                # "Miami (FL)" == ESPN "Miami"
]


def normalize(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()  # "San José" -> "San Jose"
    s = s.lower().strip().replace("'", "").replace("’", "").replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    for pat, rep in _REPLACEMENTS:
        s = re.sub(pat, rep, s)
    return s


def name_score(candidate: str, team: Team) -> float:
    """1.0 exact match on any known name, 0.8 containment, else token overlap in [0, 0.7]."""
    c = normalize(candidate)
    if not c:
        return 0.0
    best = 0.0
    for known in team.all_names():
        k = normalize(known)
        if not k:
            continue
        if c == k:
            return 1.0
        if len(c) >= 4 and len(k) >= 4 and (c in k or k in c):
            best = max(best, 0.8)
            continue
        ct, kt = set(c.split()), set(k.split())
        overlap = len(ct & kt) / max(1, min(len(ct), len(kt)))
        best = max(best, 0.7 * overlap if overlap >= 0.5 else 0.0)
    return best


def match_side(candidate: str, game: Game, threshold: float = 0.6) -> Optional[str]:
    """Return 'home' / 'away' for the team `candidate` names in `game`, or None if unclear."""
    h, a = name_score(candidate, game.home), name_score(candidate, game.away)
    if max(h, a) < threshold or h == a:
        return None
    return "home" if h > a else "away"


def match_game(names: Iterable[str], games: Iterable[Game], start=None, max_hours: float = 8.0) -> Optional[Game]:
    """Find the game whose two teams match `names` (order-insensitive) and whose start is close."""
    n1, n2 = list(names)[:2]
    best, best_score = None, 0.0
    for g in games:
        if start is not None and abs((g.start - start).total_seconds()) > max_hours * 3600:
            continue
        straight = min(name_score(n1, g.away), name_score(n2, g.home))
        swapped = min(name_score(n1, g.home), name_score(n2, g.away))
        score = max(straight, swapped)
        if score > best_score:
            best, best_score = g, score
    return best if best_score >= 0.6 else None

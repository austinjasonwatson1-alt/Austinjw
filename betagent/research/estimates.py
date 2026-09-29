"""The researcher's estimates file: schema, loading, validation, and evaluation against live prices.

File: data/research/<date>/estimates.json

{
  "date": "2026-09-29",
  "researcher": "claude-code",
  "games": [
    {
      "game_id": "espn:401...",
      "facts": [{"fact": "Starter X scratched (hamstring)", "source": "https://..."}],
      "judgment": "My read: ... (opinion, clearly separated from the facts)",
      "estimates": [
        {"market": "moneyline", "side": "home", "point": null, "prob": 0.58,
         "confidence": "medium", "rationale": "2-3 sentences", "key_risk": "one line"}
      ],
      "pass_reason": "optional one-liner if nothing in this game is worth betting"
    }
  ]
}
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..models import SIDES, PricedGame, PricedSide
from ..slate import Slate

CONFIDENCE = ("low", "medium", "high")


class EstimatesError(ValueError):
    pass


@dataclass
class Fact:
    fact: str
    source: str = ""


@dataclass
class Estimate:
    market: str
    side: str
    prob: float
    point: Optional[float] = None
    confidence: str = "low"
    rationale: str = ""
    key_risk: str = ""


@dataclass
class GameResearch:
    game_id: str
    facts: List[Fact] = field(default_factory=list)
    judgment: str = ""
    estimates: List[Estimate] = field(default_factory=list)
    pass_reason: str = ""


@dataclass
class Evaluated:
    """One estimate priced against the live market."""
    game: PricedGame
    priced: PricedSide
    research: GameResearch
    estimate: Estimate
    derived: bool = False                     # complement of an estimate on the other side
    flags: List[str] = field(default_factory=list)

    @property
    def prob(self) -> float:
        return self.estimate.prob

    @property
    def ev(self) -> float:
        """Expected value per unit at the best available price, using OUR probability.

    On whole-number lines `prob` excludes pushes, so this is EV per unit given no push; a push
    refunds the stake, so the sign (and whether it clears the bar) is unchanged.
    """
        return self.prob * self.priced.best_decimal - 1.0

    @property
    def edge_vs_fair(self) -> Optional[float]:
        fp = self.priced.fair_prob
        return None if fp is None else self.prob - fp


# --------------------------------------------------------------------------- loading
def _parse_estimate(raw: Dict[str, Any], where: str, warnings: List[str]) -> Optional[Estimate]:
    market, side = raw.get("market"), raw.get("side")
    if market not in SIDES:
        warnings.append(f"{where}: unknown market {market!r}")
        return None
    if side not in SIDES[market]:
        warnings.append(f"{where}: side {side!r} invalid for {market} (use {SIDES[market]})")
        return None
    try:
        prob = float(raw["prob"])
    except (KeyError, TypeError, ValueError):
        warnings.append(f"{where}: missing/invalid prob")
        return None
    if prob > 1.0 and prob < 100.0:        # tolerate "58" meaning 58%
        prob /= 100.0
    if not 0.0 < prob < 1.0:
        warnings.append(f"{where}: prob {raw.get('prob')} out of range")
        return None
    point = raw.get("point")
    if point is not None:
        try:
            point = float(point)
        except (TypeError, ValueError):
            warnings.append(f"{where}: invalid point {point!r}")
            return None
    conf = str(raw.get("confidence", "low")).lower()
    if conf not in CONFIDENCE:
        warnings.append(f"{where}: confidence {conf!r} not in {CONFIDENCE}; using 'low'")
        conf = "low"
    return Estimate(market, side, prob, point, conf, str(raw.get("rationale", "")).strip(), str(raw.get("key_risk", "")).strip())


def parse_estimates(data: Dict[str, Any]) -> Tuple[List[GameResearch], List[str]]:
    warnings: List[str] = []
    out: List[GameResearch] = []
    if not isinstance(data, dict) or not isinstance(data.get("games"), list):
        raise EstimatesError("estimates file must be an object with a 'games' list")
    for i, g in enumerate(data["games"]):
        gid = g.get("game_id")
        if not gid:
            warnings.append(f"games[{i}]: missing game_id")
            continue
        facts = []
        for f in g.get("facts", []) or []:
            if isinstance(f, str):
                f = {"fact": f}
            facts.append(Fact(str(f.get("fact", "")).strip(), str(f.get("source", "")).strip()))
        unsourced = sum(1 for f in facts if not f.source.startswith("http"))
        if unsourced:
            warnings.append(f"{gid}: {unsourced} fact(s) without a source URL")
        gr = GameResearch(gid, facts, str(g.get("judgment", "")).strip(), [], str(g.get("pass_reason", "")).strip())
        for j, e in enumerate(g.get("estimates", []) or []):
            est = _parse_estimate(e, f"{gid} estimates[{j}]", warnings)
            if est:
                gr.estimates.append(est)
        out.append(gr)
    return out, warnings


def load_estimates(path: Path) -> Tuple[List[GameResearch], List[str]]:
    try:
        data = json.loads(Path(path).read_text())
    except FileNotFoundError:
        raise EstimatesError(f"No estimates file at {path}") from None
    except json.JSONDecodeError as exc:
        raise EstimatesError(f"{path} is not valid JSON: {exc}") from None
    return parse_estimates(data)


# --------------------------------------------------------------------------- evaluation
def find_side(pg: PricedGame, market: str, side: str, point: Optional[float]) -> Optional[PricedSide]:
    """The priced side for this bet: exact line if given, else the main line."""
    for m in pg.markets:
        if m.market != market or side not in m.sides:
            continue
        ps = m.sides[side]
        if point is None or market == "moneyline":
            if m.is_main:
                return ps
        elif ps.point is not None and abs(ps.point - point) < 1e-9:
            return ps
    return None


def evaluate(research: List[GameResearch], slate: Slate, cfg: Dict[str, Any]) -> Tuple[List[Evaluated], List[str]]:
    """Attach each estimate to its live priced side; derive complements; flag suspicious numbers."""
    warnings: List[str] = []
    by_id = {pg.game.game_id: pg for pg in slate.games}
    max_dev = cfg["research"]["max_deviation"]
    out: List[Evaluated] = []

    for gr in research:
        pg = by_id.get(gr.game_id)
        if pg is None:
            warnings.append(f"{gr.game_id}: not on the current slate (wrong id, or filtered out)")
            continue
        if not pg.game.is_upcoming:
            warnings.append(f"{gr.game_id} {pg.game.label}: already {pg.game.status}; estimates ignored")
            continue
        explicit = {(e.market, e.side) for e in gr.estimates}
        for est in gr.estimates:
            ps = find_side(pg, est.market, est.side, est.point)
            if ps is None:
                line = "" if est.point is None else f" {est.point:+g}"
                warnings.append(f"{gr.game_id} {pg.game.label}: no price for {est.market} {est.side}{line}")
                continue
            items = [(est, ps, False)]
            other = [s for s in SIDES[est.market] if s != est.side][0]
            # Probabilities exclude pushes (see prompts/research.md), so the other side is always 1 - p.
            if cfg["research"]["complement_two_way"] and (est.market, other) not in explicit:
                opp_point = None if ps.point is None else (ps.point if est.market == "total" else -ps.point)
                ops = find_side(pg, est.market, other, opp_point)
                if ops is not None:
                    comp = Estimate(est.market, other, 1.0 - est.prob, opp_point, est.confidence,
                                    f"Complement of the {est.side} estimate.", est.key_risk)
                    items.append((comp, ops, True))
            for e, side, derived in items:
                ev = Evaluated(pg, side, gr, e, derived)
                if side.fair_prob is None:
                    ev.flags.append("no fair price (one-sided market)")
                elif abs(e.prob - side.fair_prob) > max_dev:
                    ev.flags.append(f"suspect: {abs(e.prob - side.fair_prob) * 100:.0f} pts from market")
                out.append(ev)

    researched = {gr.game_id for gr in research}
    missing = [pg.game.label for pg in slate.games
               if pg.game.is_upcoming and any(m.is_main for m in pg.markets) and pg.game.game_id not in researched]
    if missing:
        warnings.append(f"{len(missing)} upcoming game(s) not researched: " + "; ".join(missing[:8])
                        + (" ..." if len(missing) > 8 else ""))
    return out, warnings

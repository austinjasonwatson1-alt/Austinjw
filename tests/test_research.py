"""Tests for the research packet and the estimates schema / evaluation."""
import json
from datetime import date, datetime, timezone

import pytest

from betagent import oddsmath as om
from betagent.config import DEFAULTS, _deep_merge
from betagent.market import price_game
from betagent.models import Game, Quote, Team
from betagent.research.estimates import EstimatesError, evaluate, load_estimates, parse_estimates
from betagent.research.packet import build_packet, render_packet_md, write_packet
from betagent.slate import Slate

CFG = _deep_merge(DEFAULTS, {})


def am(a):
    return om.american_to_decimal(a)


def game(gid="espn:1", status="pre", spread_point=-1.5, total=8.5):
    q = [
        Quote("DK", "moneyline", "home", am(-150)), Quote("DK", "moneyline", "away", am(+130)),
        Quote("DK", "moneyline", "home", am(-140), is_open=True),
        Quote("DK", "spread", "home", am(+140), spread_point), Quote("DK", "spread", "away", am(-165), -spread_point),
        Quote("DK", "total", "over", am(-110), total), Quote("DK", "total", "under", am(-110), total),
    ]
    g = Game("MLB", datetime(2026, 9, 30, 0, 0, tzinfo=timezone.utc), Team("New York Yankees", "NYY"),
             Team("Boston Red Sox", "BOS"), gid, status=status, venue="Yankee Stadium", indoor=False, quotes=q)
    return price_game(g)


def slate(*pgs):
    return Slate(day=date(2026, 9, 29), games=list(pgs))


def est_file(*games):
    return {"date": "2026-09-29", "researcher": "test", "games": list(games)}


def gr(gid="espn:1", estimates=(), facts=({"fact": "x", "source": "https://a"},)):
    return {"game_id": gid, "facts": list(facts), "judgment": "j", "estimates": list(estimates)}


# ------------------------------------------------------------------ packet
def test_packet_lists_upcoming_games_and_skips_started():
    s = slate(game("espn:1"), game("espn:2", status="in"))
    p = build_packet(s, CFG)
    assert [g["game_id"] for g in p["games"]] == ["espn:1"]
    assert p["skipped"][0]["game_id"] == "espn:2"
    ml = next(m for m in p["games"][0]["markets"] if m["market"] == "moneyline")
    home = next(sd for sd in ml["sides"] if sd["side"] == "home")
    assert home["best_price"] == "-150" and home["open"] == "-140"
    assert 0.5 < home["fair_prob"] < 0.6


def test_packet_markdown_and_files(tmp_path):
    p = build_packet(slate(game()), CFG, feedback="MLB totals: 2-6, overconfident.")
    md = render_packet_md(p)
    assert "Boston Red Sox @ New York Yankees" in md and "OUTDOOR" in md and "overconfident" in md
    jp, mp = write_packet(p, tmp_path)
    assert json.loads(jp.read_text())["games"][0]["game_id"] == "espn:1" and mp.exists()


def test_packet_respects_max_games():
    cfg = _deep_merge(DEFAULTS, {"research": {"max_games": 1}})
    p = build_packet(slate(game("espn:1"), game("espn:2")), cfg)
    assert len(p["games"]) == 1 and "max_games" in p["skipped"][0]["reason"]


# ------------------------------------------------------------------ parsing
def test_parse_valid_estimates():
    research, warnings = parse_estimates(est_file(gr(estimates=[
        {"market": "moneyline", "side": "home", "prob": 0.6, "confidence": "High", "rationale": "r", "key_risk": "k"},
    ])))
    assert warnings == []
    e = research[0].estimates[0]
    assert e.prob == 0.6 and e.confidence == "high" and e.point is None


@pytest.mark.parametrize("bad, msg", [
    ({"market": "parlay", "side": "home", "prob": 0.5}, "unknown market"),
    ({"market": "total", "side": "home", "prob": 0.5}, "invalid for total"),
    ({"market": "moneyline", "side": "home"}, "missing/invalid prob"),
    ({"market": "moneyline", "side": "home", "prob": 1.5e3}, "out of range"),
])
def test_parse_rejects_bad_estimates(bad, msg):
    research, warnings = parse_estimates(est_file(gr(estimates=[bad])))
    assert research[0].estimates == [] and any(msg in w for w in warnings)


def test_parse_tolerates_percent_and_flags_unsourced_facts():
    research, warnings = parse_estimates(est_file(gr(
        estimates=[{"market": "moneyline", "side": "home", "prob": 58, "confidence": "sure"}],
        facts=[{"fact": "rumor"}, "plain string fact"],
    )))
    assert research[0].estimates[0].prob == pytest.approx(0.58)
    assert research[0].estimates[0].confidence == "low"
    assert any("2 fact(s) without a source" in w for w in warnings)


def test_load_estimates_errors(tmp_path):
    with pytest.raises(EstimatesError):
        load_estimates(tmp_path / "missing.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    with pytest.raises(EstimatesError):
        load_estimates(bad)
    with pytest.raises(EstimatesError):
        parse_estimates({"nope": 1})


# ------------------------------------------------------------------ evaluation
def _eval(estimates, s=None, cfg=CFG):
    research, _ = parse_estimates(est_file(gr(estimates=estimates)))
    return evaluate(research, s or slate(game()), cfg)


def test_evaluate_ev_uses_our_prob_and_best_price():
    out, _ = _eval([{"market": "moneyline", "side": "home", "prob": 0.65}])
    home = next(e for e in out if e.priced.side == "home")
    assert home.ev == pytest.approx(0.65 * am(-150) - 1)
    assert home.edge_vs_fair == pytest.approx(0.65 - home.priced.fair_prob)


def test_evaluate_derives_complement_for_no_push_markets():
    out, _ = _eval([{"market": "moneyline", "side": "home", "prob": 0.65}])
    away = next(e for e in out if e.priced.side == "away")
    assert away.derived and away.prob == pytest.approx(0.35)


def test_evaluate_complements_whole_number_line_excluding_pushes():
    s = slate(game(spread_point=-3.0, total=9.0))
    out, _ = _eval([{"market": "total", "side": "over", "point": 9, "prob": 0.47}], s)
    under = next(e for e in out if e.priced.side == "under")
    assert under.derived and under.prob == pytest.approx(0.53) and under.priced.point == 9.0


def test_evaluate_matches_exact_line_and_warns_on_missing_line():
    out, warnings = _eval([
        {"market": "spread", "side": "away", "point": 1.5, "prob": 0.66},
        {"market": "spread", "side": "away", "point": 2.5, "prob": 0.70},
    ])
    assert any(e.priced.side == "away" and e.priced.point == 1.5 for e in out)
    assert any("no price for spread away +2.5" in w for w in warnings)


def test_evaluate_flags_suspect_estimates():
    out, _ = _eval([{"market": "moneyline", "side": "home", "prob": 0.85}])
    home = next(e for e in out if e.priced.side == "home")
    assert any("suspect" in f for f in home.flags)


def test_evaluate_ignores_unknown_and_started_games():
    research, _ = parse_estimates(est_file(
        gr("espn:404", [{"market": "moneyline", "side": "home", "prob": 0.6}]),
        gr("espn:2", [{"market": "moneyline", "side": "home", "prob": 0.6}]),
    ))
    out, warnings = evaluate(research, slate(game("espn:1"), game("espn:2", status="post")), CFG)
    assert out == []
    assert any("not on the current slate" in w for w in warnings)
    assert any("already post" in w for w in warnings)
    assert any("not researched" in w for w in warnings)

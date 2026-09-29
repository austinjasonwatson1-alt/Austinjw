"""Tests for market pricing (fair price, line shopping, main line) and team matching."""
from datetime import datetime, timezone

import pytest

from betagent import oddsmath as om
from betagent.market import line_key, price_game
from betagent.models import Game, Quote, Team
from betagent.teams import match_game, match_side, normalize


def make_game(quotes=()):
    return Game(
        league="MLB",
        start=datetime(2026, 9, 30, 0, 0, tzinfo=timezone.utc),
        home=Team("New York Yankees", "NYY", ("Yankees", "New York")),
        away=Team("Boston Red Sox", "BOS", ("Red Sox", "Boston")),
        game_id="espn:1",
        quotes=list(quotes),
    )


def am(a):
    return om.american_to_decimal(a)


# ------------------------------------------------------------------ line keys
def test_line_key_groups_both_spread_sides():
    home = Quote("DK", "spread", "home", 2.0, point=-1.5)
    away = Quote("DK", "spread", "away", 1.8, point=1.5)
    assert line_key(home) == line_key(away) == -1.5
    assert line_key(Quote("DK", "total", "over", 1.9, point=8.5)) == 8.5
    assert line_key(Quote("DK", "moneyline", "home", 1.9)) is None


# ------------------------------------------------------------------ fair price + line shopping
def test_single_book_fair_price_is_devigged():
    g = make_game([Quote("DK", "moneyline", "home", am(-150)), Quote("DK", "moneyline", "away", am(+130))])
    pg = price_game(g)
    ml = pg.main("moneyline")
    expected = om.devig([om.implied_prob(am(-150)), om.implied_prob(am(130))])
    assert ml.sides["home"].fair_prob == pytest.approx(expected[0])
    assert ml.sides["away"].fair_prob == pytest.approx(expected[1])
    assert ml.sides["home"].fair_prob + ml.sides["away"].fair_prob == pytest.approx(1.0)


def test_best_price_is_line_shopped_across_books():
    g = make_game([
        Quote("DK", "moneyline", "home", am(-150)), Quote("DK", "moneyline", "away", am(+130)),
        Quote("FD", "moneyline", "home", am(-140)), Quote("FD", "moneyline", "away", am(+120)),
    ])
    ml = price_game(g).main("moneyline")
    assert ml.sides["home"].best_book == "FD"
    assert ml.sides["home"].best_decimal == pytest.approx(am(-140))
    assert ml.sides["away"].best_book == "DK"
    assert ml.sides["away"].n_books_fair == 2


def test_book_weights_shift_consensus():
    g = make_game([
        Quote("DK", "moneyline", "home", 2.0), Quote("DK", "moneyline", "away", 2.0),          # 50/50
        Quote("Pinnacle", "moneyline", "home", 1.6), Quote("Pinnacle", "moneyline", "away", 2.6),
    ])
    pin = om.devig([1 / 1.6, 1 / 2.6])[0]
    even = price_game(g, weights={"default": 1.0}).main("moneyline").sides["home"].fair_prob
    heavy = price_game(g, weights={"pinnacle": 3.0, "default": 1.0}).main("moneyline").sides["home"].fair_prob
    assert even == pytest.approx((0.5 + pin) / 2)
    assert heavy == pytest.approx((0.5 + 3 * pin) / 4)


def test_prediction_market_uses_midpoint_as_fair():
    g = make_game([
        Quote("Polymarket", "moneyline", "home", 1 / 0.56, mid_prob=0.555),
        Quote("Polymarket", "moneyline", "away", 1 / 0.45, mid_prob=0.445),
    ])
    ml = price_game(g).main("moneyline")
    assert ml.sides["home"].fair_prob == pytest.approx(0.555)
    assert ml.sides["home"].best_decimal == pytest.approx(1 / 0.56)


def test_one_sided_market_has_no_fair_price():
    g = make_game([Quote("DK", "moneyline", "home", am(-150))])
    ml = price_game(g).main("moneyline")
    assert ml.sides["home"].fair_prob is None
    assert ml.sides["home"].best_ev is None


def test_main_line_prefers_sportsbook_consensus_over_prediction_market_alts():
    q = [
        Quote("DK", "total", "over", am(-110), 8.5), Quote("DK", "total", "under", am(-110), 8.5),
        Quote("FD", "total", "over", am(-105), 8.5), Quote("FD", "total", "under", am(-115), 8.5),
        Quote("Polymarket", "total", "over", 2.0, 7.5, mid_prob=0.5), Quote("Polymarket", "total", "under", 2.0, 7.5, mid_prob=0.5),
        Quote("Polymarket", "total", "over", 2.2, 8.5, mid_prob=0.46), Quote("Polymarket", "total", "under", 1.8, 8.5, mid_prob=0.54),
    ]
    pg = price_game(make_game(q))
    main = pg.main("total")
    assert main.point_key == 8.5
    assert main.sides["over"].best_book == "Polymarket"
    assert sum(1 for m in pg.markets if m.market == "total") == 2


def test_spread_points_are_side_relative():
    q = [Quote("DK", "spread", "home", am(+150), -1.5), Quote("DK", "spread", "away", am(-180), 1.5)]
    m = price_game(make_game(q)).main("spread")
    assert m.sides["home"].point == -1.5
    assert m.sides["away"].point == 1.5


def test_open_line_is_reported_but_not_priced():
    q = [
        Quote("DK", "moneyline", "home", am(-150)), Quote("DK", "moneyline", "away", am(+130)),
        Quote("DK", "moneyline", "home", am(-120), is_open=True),
    ]
    ml = price_game(make_game(q)).main("moneyline")
    assert ml.sides["home"].open_decimal == pytest.approx(am(-120))
    assert ml.sides["home"].best_decimal == pytest.approx(am(-150))


def test_best_ev_uses_fair_prob_and_best_price():
    g = make_game([
        Quote("DK", "moneyline", "home", 2.0), Quote("DK", "moneyline", "away", 2.0),
        Quote("FD", "moneyline", "home", 2.1),
    ])
    home = price_game(g).main("moneyline").sides["home"]
    assert home.fair_prob == pytest.approx(0.5)
    assert home.best_ev == pytest.approx(0.05)


# ------------------------------------------------------------------ team matching
@pytest.mark.parametrize("a, b", [
    ("San José State", "San Jose State"),
    ("Michigan St.", "Michigan State"),
    ("Louisiana-Monroe", "UL Monroe"),
    ("Hawai'i", "Hawaii"),
    ("Texas A&M", "Texas A and M"),
])
def test_normalize_equivalents(a, b):
    assert normalize(a) == normalize(b)


def test_match_side_by_nickname_and_abbr():
    g = make_game()
    assert match_side("Yankees", g) == "home"
    assert match_side("Boston Red Sox", g) == "away"
    assert match_side("BOS", g) == "away"
    assert match_side("Dodgers", g) is None


def test_match_game_is_order_insensitive_and_time_bounded():
    g = make_game()
    other = make_game()
    other.game_id = "espn:2"
    other.start = datetime(2026, 10, 1, 0, 0, tzinfo=timezone.utc)   # next day's game, same teams
    assert match_game(["Yankees", "Red Sox"], [g, other], start=g.start) is g
    assert match_game(["Red Sox", "Yankees"], [g, other], start=other.start) is other
    assert match_game(["Dodgers", "Padres"], [g, other]) is None

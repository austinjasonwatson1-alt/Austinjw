"""Tests for betagent.oddsmath — mistakes here silently corrupt every downstream number."""
import pytest

from betagent import oddsmath as om


# ------------------------------------------------------------------ conversions
@pytest.mark.parametrize(
    "american, decimal",
    [(100, 2.0), (-100, 2.0), (150, 2.5), (-150, 1 + 100 / 150), (-110, 1 + 100 / 110), (-200, 1.5), (1000, 11.0)],
)
def test_american_decimal_roundtrip(american, decimal):
    assert om.american_to_decimal(american) == pytest.approx(decimal)
    back = om.decimal_to_american(decimal)
    # +100 and -100 are the same price; decimal_to_american returns +100.
    assert back == pytest.approx(abs(american) if abs(american) == 100 else american)


@pytest.mark.parametrize("bad", [0, 50, -50, 99.9, -99.9])
def test_american_rejects_impossible(bad):
    with pytest.raises(om.OddsError):
        om.american_to_decimal(bad)


def test_decimal_rejects_le_one():
    with pytest.raises(om.OddsError):
        om.decimal_to_american(1.0)
    with pytest.raises(om.OddsError):
        om.implied_prob(0.9)


@pytest.mark.parametrize("text, expected", [("+105", 105), ("-125", -125), ("EVEN", 100), ("PK", 100), (-110, -110)])
def test_parse_american(text, expected):
    assert om.parse_american(text) == expected


def test_implied_prob_known_values():
    assert om.implied_prob(om.american_to_decimal(-110)) == pytest.approx(0.5238095, abs=1e-6)
    assert om.implied_prob(om.american_to_decimal(+200)) == pytest.approx(1 / 3)
    assert om.implied_prob(2.0) == 0.5


def test_prob_to_american():
    assert om.prob_to_american(0.5) == pytest.approx(100)
    assert om.prob_to_american(2 / 3) == pytest.approx(-200)
    assert om.prob_to_american(0.25) == pytest.approx(300)


def test_share_price_to_decimal():
    assert om.share_price_to_decimal(0.5) == pytest.approx(2.0)
    assert om.share_price_to_decimal(0.25) == pytest.approx(4.0)
    assert om.share_price_to_decimal(0.49, fee=0.01) == pytest.approx(2.0)
    with pytest.raises(om.OddsError):
        om.share_price_to_decimal(1.0)
    with pytest.raises(om.OddsError):
        om.share_price_to_decimal(0.0)


def test_fmt_american():
    assert om.fmt_american(150.4) == "+150"
    assert om.fmt_american(-110.2) == "-110"
    assert om.fmt_decimal_as_american(1.5) == "-200"


# ------------------------------------------------------------------ vig removal
def test_overround_standard_line():
    p = om.implied_prob(om.american_to_decimal(-110))
    assert om.overround([p, p]) == pytest.approx(0.047619, abs=1e-6)


@pytest.mark.parametrize("method", om.DEVIG_METHODS)
def test_devig_symmetric_line_is_fifty_fifty(method):
    p = om.implied_prob(om.american_to_decimal(-110))
    assert om.devig([p, p], method) == pytest.approx([0.5, 0.5])


@pytest.mark.parametrize("method", om.DEVIG_METHODS)
def test_devig_sums_to_one_and_preserves_order(method):
    implied = [om.implied_prob(om.american_to_decimal(a)) for a in (-250, +205)]
    fair = om.devig(implied, method)
    assert sum(fair) == pytest.approx(1.0)
    assert fair[0] > fair[1]
    # removing vig can only lower each probability when the book has a margin
    assert all(f < i for f, i in zip(fair, implied))


def test_devig_multiplicative_known_value():
    # -150 / +130: implied 0.6 and 0.434783 -> sum 1.034783
    implied = [0.6, 100 / 230]
    fair = om.devig(implied, "multiplicative")
    assert fair[0] == pytest.approx(0.6 / (0.6 + 100 / 230))
    assert fair[0] == pytest.approx(0.57983, abs=1e-5)


def test_devig_additive_known_value():
    fair = om.devig([0.55, 0.50], "additive")
    assert fair == pytest.approx([0.525, 0.475])


def test_devig_power_shades_longshot_more_than_multiplicative():
    implied = [om.implied_prob(om.american_to_decimal(a)) for a in (-400, +300)]
    mult = om.devig(implied, "multiplicative")
    power = om.devig(implied, "power")
    assert sum(power) == pytest.approx(1.0)
    assert power[1] < mult[1]  # power method assigns more of the margin to the longshot


def test_devig_three_way():
    fair = om.devig([0.45, 0.30, 0.30])
    assert sum(fair) == pytest.approx(1.0)
    assert fair[1] == pytest.approx(fair[2])


def test_devig_no_margin_is_identity():
    for method in om.DEVIG_METHODS:
        assert om.devig([0.4, 0.6], method) == pytest.approx([0.4, 0.6])


def test_devig_rejects_bad_input():
    with pytest.raises(om.OddsError):
        om.devig([0.5])
    with pytest.raises(om.OddsError):
        om.devig([0.5, 1.2])
    with pytest.raises(om.OddsError):
        om.devig([0.5, 0.5], "nope")


def test_weighted_consensus():
    assert om.weighted_consensus([0.50, 0.56], [1, 2]) == pytest.approx(0.54)
    with pytest.raises(om.OddsError):
        om.weighted_consensus([], [])


# ------------------------------------------------------------------ edge + Kelly
def test_expected_value():
    assert om.expected_value(0.5, 2.0) == pytest.approx(0.0)
    assert om.expected_value(0.55, 2.0) == pytest.approx(0.10)
    assert om.expected_value(0.5, om.american_to_decimal(-110)) == pytest.approx(-0.04545, abs=1e-5)


def test_min_decimal_for_edge():
    d = om.min_decimal_for_edge(0.55, 0.03)
    assert om.expected_value(0.55, d) == pytest.approx(0.03)


def test_kelly_fraction_known_values():
    # even money, 55% -> 2p - 1 = 10%
    assert om.kelly_fraction(0.55, 2.0) == pytest.approx(0.10)
    # +150 (b=1.5), 45%: (1.5*0.45 - 0.55) / 1.5
    assert om.kelly_fraction(0.45, 2.5) == pytest.approx((1.5 * 0.45 - 0.55) / 1.5)


def test_kelly_is_zero_without_edge():
    assert om.kelly_fraction(0.5, 2.0) == 0.0
    assert om.kelly_fraction(0.5, om.american_to_decimal(-110)) == 0.0
    assert om.kelly_fraction(0.2, 3.0) == 0.0


def test_kelly_stake_units_quarter_kelly_and_caps():
    # 10% full Kelly * 0.25 * 100 units = 2.5 units
    assert om.kelly_stake_units(0.55, 2.0, bankroll_units=100, kelly_multiplier=0.25) == pytest.approx(2.5)
    assert om.kelly_stake_units(0.55, 2.0, 100, 0.25, max_units=2.0) == pytest.approx(2.0)
    assert om.kelly_stake_units(0.55, 2.0, 100, 0.25, round_to=1.0) == pytest.approx(2.0)
    assert om.kelly_stake_units(0.5, 2.0, 100, 0.25) == 0.0


def test_kelly_stake_rejects_bad_config():
    with pytest.raises(om.OddsError):
        om.kelly_stake_units(0.55, 2.0, bankroll_units=0)
    with pytest.raises(om.OddsError):
        om.kelly_stake_units(0.55, 2.0, 100, kelly_multiplier=1.5)


def test_scale_to_cap():
    assert om.scale_to_cap([2, 2, 1], None) == [2, 2, 1]
    assert om.scale_to_cap([2, 2, 1], 10) == [2, 2, 1]
    assert om.scale_to_cap([2, 2, 1], 2.5) == pytest.approx([1.0, 1.0, 0.5])


# ------------------------------------------------------------------ parlays + settlement
def test_parlay_math():
    assert om.parlay_decimal([2.0, 2.0, 2.0]) == pytest.approx(8.0)
    assert om.parlay_prob([0.5, 0.5]) == pytest.approx(0.25)
    # two -110 legs pay about +264
    d = om.parlay_decimal([om.american_to_decimal(-110)] * 2)
    assert om.decimal_to_american(d) == pytest.approx(264.46, abs=0.01)


def test_profit_units():
    assert om.profit_units("win", 2.0, 2.5) == pytest.approx(3.0)
    assert om.profit_units("loss", 2.0, 2.5) == -2.0
    assert om.profit_units("push", 2.0, 2.5) == 0.0
    with pytest.raises(om.OddsError):
        om.profit_units("maybe", 1, 2)

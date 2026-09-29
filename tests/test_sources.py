"""Source parsing (mocked payloads shaped like the real APIs), caching, and an offline end-to-end slate."""
import copy
import json
from datetime import date, datetime, timezone

import pytest

from betagent import oddsmath as om
from betagent.cache import Cache
from betagent.config import DEFAULTS, _deep_merge
from betagent.http import SourceError
from betagent.leagues import get_league
from betagent.models import Game, Team
from betagent.slate import build_slate
from betagent.sources import espn, oddsapi, polymarket

NHL = get_league("NHL")


def espn_event(eid="401", home=("Carolina Hurricanes", "CAR", "Hurricanes"), away=("Florida Panthers", "FLA", "Panthers"),
               date_str="2026-09-29T21:00Z", state="pre", with_odds=True):
    def team(t, ha, score="0"):
        return {"homeAway": ha, "score": score, "team": {
            "displayName": t[0], "abbreviation": t[1], "shortDisplayName": t[2], "name": t[2],
            "location": t[0].replace(" " + t[2], "")}}
    comp = {
        "competitors": [team(home, "home"), team(away, "away")],
        "status": {"type": {"state": state, "name": "STATUS_SCHEDULED", "shortDetail": "9/29 - 5:00 PM EDT"}},
        "venue": {"fullName": "Lenovo Center", "address": {"city": "Raleigh", "state": "NC"}, "indoor": True},
        "neutralSite": False,
    }
    if with_odds:
        comp["odds"] = [{
            "provider": {"name": "DraftKings"},
            "moneyline": {"home": {"close": {"odds": "-125"}, "open": {"odds": "-130"}},
                          "away": {"close": {"odds": "+105"}, "open": {"odds": "+110"}}},
            "pointSpread": {"home": {"close": {"line": "-1.5", "odds": "+190"}},
                            "away": {"close": {"line": "+1.5", "odds": "-230"}}},
            "total": {"over": {"close": {"line": "o6.5", "odds": "+105"}, "open": {"line": "o6.5", "odds": "EVEN"}},
                      "under": {"close": {"line": "u6.5", "odds": "-125"}}},
        }]
    return {"id": eid, "date": date_str, "season": {"slug": "regular-season"}, "competitions": [comp]}


def pm_event(bid=0.46, ask=0.47, liquidity=50000):
    base = {"active": True, "closed": False, "liquidityNum": liquidity}
    return {
        "title": "Panthers vs. Hurricanes", "slug": "nhl-fla-car-2026-09-29", "startTime": "2026-09-29T21:00:00Z",
        "markets": [
            {**base, "sportsMarketType": "moneyline", "outcomes": '["Panthers", "Hurricanes"]', "bestBid": bid, "bestAsk": ask},
            {**base, "sportsMarketType": "spreads", "outcomes": '["Hurricanes", "Panthers"]', "line": -1.5,
             "bestBid": 0.32, "bestAsk": 0.33},
            {**base, "sportsMarketType": "totals", "outcomes": '["Over", "Under"]', "line": 6.5, "bestBid": 0.46, "bestAsk": 0.47},
            {**base, "sportsMarketType": "totals", "outcomes": '["Over", "Under"]', "line": 5.5, "bestBid": 0.40,
             "bestAsk": 0.60},  # too wide -> ignored
        ],
    }


# ------------------------------------------------------------------ ESPN
def test_espn_parse_scoreboard_and_odds():
    games = espn.parse_scoreboard({"events": [espn_event()]}, NHL)
    assert len(games) == 1
    g = games[0]
    assert g.home.name == "Carolina Hurricanes" and g.away.abbr == "FLA"
    assert g.indoor is True and g.city == "Raleigh, NC" and g.is_upcoming
    live = {(q.market, q.side): q for q in g.quotes if not q.is_open}
    assert live[("moneyline", "home")].decimal == pytest.approx(om.american_to_decimal(-125))
    assert live[("spread", "home")].point == -1.5 and live[("spread", "away")].point == 1.5
    assert live[("total", "over")].point == 6.5 and live[("total", "under")].point == 6.5
    opens = {(q.market, q.side): q for q in g.quotes if q.is_open}
    assert opens[("total", "over")].decimal == pytest.approx(2.0)   # "EVEN"


def test_espn_skips_malformed_event():
    bad = {"id": "x", "date": "2026-09-29T21:00Z", "competitions": [{"competitors": []}]}
    assert len(espn.parse_scoreboard({"events": [bad, espn_event()]}, NHL)) == 1


def test_espn_final_scores_and_status():
    ev = espn_event(state="post", with_odds=False)
    ev["competitions"][0]["competitors"][0]["score"] = "4"
    g = espn.parse_scoreboard({"events": [ev]}, NHL)[0]
    assert g.status == "post" and g.home.score == 4 and g.quotes == []


def test_espn_legacy_odds_format():
    o = {"provider": {"name": "ESPN BET"}, "spread": 3.5, "overUnder": 44.5, "overOdds": -110, "underOdds": -110,
         "homeTeamOdds": {"moneyLine": 150, "spreadOdds": -110, "favorite": False},
         "awayTeamOdds": {"moneyLine": -175, "spreadOdds": -110, "favorite": True}}
    qs = {(q.market, q.side): q for q in espn.parse_odds(o)}
    assert qs[("spread", "home")].point == 3.5 and qs[("spread", "away")].point == -3.5
    assert qs[("moneyline", "away")].decimal == pytest.approx(om.american_to_decimal(-175))
    assert qs[("total", "under")].point == 44.5


# ------------------------------------------------------------------ Polymarket
def _game():
    return espn.parse_scoreboard({"events": [espn_event(with_odds=False)]}, NHL)[0]


def test_polymarket_attaches_moneyline_spread_total():
    g = _game()
    n = polymarket.attach_quotes([pm_event()], [g], min_liquidity=1000, max_spread=0.05)
    assert n == 3  # the wide 5.5 total is filtered out
    q = {(q.market, q.side, q.point): q for q in g.quotes}
    # First outcome (Panthers = away) buys at the ask; second outcome buys at 1 - bid.
    assert q[("moneyline", "away", None)].decimal == pytest.approx(1 / 0.47)
    assert q[("moneyline", "home", None)].decimal == pytest.approx(1 / 0.54)
    assert q[("moneyline", "away", None)].mid_prob == pytest.approx(0.465)
    # Spread line applies to the first outcome (Hurricanes = home -1.5).
    assert q[("spread", "home", -1.5)].decimal == pytest.approx(1 / 0.33)
    assert q[("spread", "away", 1.5)].decimal == pytest.approx(1 / 0.68)
    assert ("total", "over", 6.5) in q and ("total", "over", 5.5) not in q
    assert g.source_ids["polymarket"] == "nhl-fla-car-2026-09-29"


def test_polymarket_filters_thin_markets():
    g = _game()
    assert polymarket.attach_quotes([pm_event(liquidity=10)], [g], min_liquidity=1000, max_spread=0.05) == 0


def test_polymarket_unmatched_event_is_ignored():
    g = _game()
    ev = pm_event()
    ev["title"] = "Rangers vs. Bruins"
    ev["markets"][0]["outcomes"] = '["Rangers", "Bruins"]'
    assert polymarket.attach_quotes([ev], [g]) == 0 and g.quotes == []


# ------------------------------------------------------------------ Odds API
def test_oddsapi_attach_quotes_to_existing_game():
    g = _game()
    ev = {"id": "abc", "commence_time": "2026-09-29T21:00:00Z", "home_team": "Carolina Hurricanes",
          "away_team": "Florida Panthers", "bookmakers": [{"key": "fanduel", "title": "FanDuel", "markets": [
              {"key": "h2h", "outcomes": [{"name": "Carolina Hurricanes", "price": 1.8}, {"name": "Florida Panthers", "price": 2.1}]},
              {"key": "spreads", "outcomes": [{"name": "Carolina Hurricanes", "price": 2.9, "point": -1.5},
                                              {"name": "Florida Panthers", "price": 1.45, "point": 1.5}]},
              {"key": "totals", "outcomes": [{"name": "Over", "price": 2.05, "point": 6.5}, {"name": "Under", "price": 1.8, "point": 6.5}]},
          ]}]}
    new = oddsapi.attach_quotes([ev], [g], NHL)
    assert new == []
    q = {(q.book, q.market, q.side): q for q in g.quotes}
    assert q[("FanDuel", "moneyline", "home")].decimal == 1.8
    assert q[("FanDuel", "spread", "away")].point == 1.5
    assert q[("FanDuel", "total", "under")].point == 6.5


def test_oddsapi_unmatched_event_becomes_game():
    ev = {"id": "zzz", "commence_time": "2026-09-29T23:00:00Z", "home_team": "Boston Bruins",
          "away_team": "New York Rangers", "bookmakers": []}
    new = oddsapi.attach_quotes([ev], [_game()], NHL)
    assert len(new) == 1 and new[0].home.name == "Boston Bruins"


# ------------------------------------------------------------------ cache
def test_cache_fetch_ttl_offline_and_stale_fallback(tmp_path):
    calls = []

    def fn():
        calls.append(1)
        return {"n": len(calls)}

    c = Cache(tmp_path, "2026-09-29")
    assert c.fetch("ns", "k", fn, ttl_minutes=10) == {"n": 1}
    assert c.fetch("ns", "k", fn, ttl_minutes=10) == {"n": 1}          # cached
    assert c.fetch("ns", "k", fn, ttl_minutes=0) == {"n": 2}           # expired -> refetch
    assert Cache(tmp_path, "2026-09-29", "offline").fetch("ns", "k", fn) == {"n": 2}
    assert Cache(tmp_path, "2026-09-29", "offline").fetch("ns", "missing", fn) is None
    assert len(calls) == 2

    def boom():
        raise SourceError("down")

    assert c.fetch("ns", "k", boom, ttl_minutes=0) == {"n": 2}          # stale copy beats a crash
    with pytest.raises(SourceError):
        c.fetch("ns", "never", boom)


# ------------------------------------------------------------------ end-to-end (mocked HTTP)
class FakeResp:
    def __init__(self, payload, status=200):
        self.status_code, self._payload, self.headers, self.text = status, payload, {}, json.dumps(payload)

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, fail=()):
        self.fail = fail
        self.urls = []

    def get(self, url, params=None, timeout=None):
        self.urls.append(url)
        if any(f in url for f in self.fail):
            return FakeResp({}, status=503)
        if "espn.com" in url:
            return FakeResp({"events": [espn_event()]})
        if url.endswith("/sports"):
            return FakeResp([{"sport": "nhl", "series": "10346"}])
        if "polymarket" in url:
            return FakeResp([pm_event()])
        raise AssertionError(url)


def _cfg(tmp_path):
    cfg = _deep_merge(DEFAULTS, {"cache": {"dir": str(tmp_path)}, "leagues": ["NHL"]})
    cfg["sources"]["odds_api"]["enabled"] = False
    return cfg


def test_build_slate_end_to_end(tmp_path):
    slate = build_slate(_cfg(tmp_path), date(2026, 9, 29), ["NHL"], session=FakeSession())
    assert len(slate.games) == 1
    ml = slate.games[0].main("moneyline")
    assert set(ml.sides["home"].prices) == {"DraftKings", "Polymarket"}
    assert ml.sides["home"].n_books_fair == 2
    assert 0 < ml.sides["home"].fair_prob < 1


def test_build_slate_survives_polymarket_outage(tmp_path):
    slate = build_slate(_cfg(tmp_path), date(2026, 9, 29), ["NHL"], session=FakeSession(fail=("polymarket",)))
    assert len(slate.games) == 1
    assert any("Polymarket unavailable" in n for n in slate.notes)


def test_build_slate_game_filter(tmp_path):
    assert len(build_slate(_cfg(tmp_path), date(2026, 9, 29), ["NHL"], "hurricanes", session=FakeSession()).games) == 1
    assert build_slate(_cfg(tmp_path), date(2026, 9, 29), ["NHL"], "dodgers", session=FakeSession()).games == []

"""Offline tests for mlb_predictor: sabermetric math, live-API parsing (mocked), edge cases."""
from datetime import date

import pandas as pd
import pytest

import mlb_predictor as mp


# ---------------------------------------------------------------- helpers
def test_parse_innings():
    assert mp.parse_innings("150.1") == pytest.approx(150 + 1 / 3)
    assert mp.parse_innings("6.2") == pytest.approx(6 + 2 / 3)
    assert mp.parse_innings(None) == 0.0
    assert mp.parse_innings("-.--") == 0.0


def test_regress_handles_missing():
    assert mp.regress(None, 100, 4.1, 150) == 4.1
    assert mp.regress(3.0, 0, 4.1, 150) == 4.1
    assert mp.regress(3.0, 150, 4.1, 150) == pytest.approx(3.55)


# ---------------------------------------------------------------- sabermetrics
def test_league_average_line_maps_to_league_constants():
    calc = mp.SabermetricCalculator()
    lg = calc.league_average_line()
    assert calc.siera(lg) == pytest.approx(mp.CONST.lg_siera)
    assert calc.xfip(lg) == pytest.approx(mp.CONST.lg_xfip)


def test_siera_and_xfip_reward_strikeouts_and_punish_walks():
    calc = mp.SabermetricCalculator()
    ace = mp.PitchingLine(bf=700, ip=180, k=210, bb=40, ibb=2, hbp=6, hr=18, go=200, ao=180)
    bad = mp.PitchingLine(bf=700, ip=150, k=110, bb=75, ibb=3, hbp=8, hr=28, go=170, ao=230)
    assert calc.siera(ace) < mp.CONST.lg_siera < calc.siera(bad)
    assert calc.xfip(ace) < mp.CONST.lg_xfip < calc.xfip(bad)


def test_wrc_plus_centered_and_park_adjusted():
    calc = mp.SabermetricCalculator()
    line = mp.BattingLine(pa=600, ab=540, h=135, doubles=27, triples=3, hr=18, bb=50, ibb=2, hbp=6, sf=4)
    woba = calc.woba(line)
    assert calc.wrc_plus(line, woba, 100) == pytest.approx(100.0)
    # Same raw production is worth less in a hitter's park.
    assert calc.wrc_plus(line, woba, 112) < 100 < calc.wrc_plus(line, woba, 93)


# ---------------------------------------------------------------- mocked live API
class FakeClient:
    """Serves canned MLB Stats API payloads keyed by path."""

    def __init__(self, schedule):
        self.schedule = schedule

    def get(self, path, **params):
        if path == "schedule":
            return self.schedule
        if path == "teams":
            return {"teams": [{"id": tid, "abbreviation": ab, "name": ab, "venue": {"id": 1000 + tid}}
                              for tid, ab in mp.TEAM_ABBR_BY_ID.items()]}
        if path == "people":
            ids = params["personIds"].split(",")
            return {"people": [{"id": int(i), "pitchHand": {"code": "L" if i == "2" else "R"}} for i in ids]}
        if path.startswith("people/") and path.endswith("/stats"):
            pid = int(path.split("/")[1])
            if pid == 3:  # a debut with no MLB stats anywhere
                return {"stats": [{"splits": []}]}
            k = 200 if pid == 1 else 120
            stat = {"battersFaced": 650, "inningsPitched": "160.1", "strikeOuts": k, "baseOnBalls": 45,
                    "intentionalWalks": 2, "hitByPitch": 6, "homeRuns": 20, "groundOuts": 190, "airOuts": 170}
            if params.get("stats") == "byDateRange":
                stat = {k2: (v // 6 if isinstance(v, int) else "26.2") for k2, v in stat.items()}
            return {"stats": [{"splits": [{"stat": stat}]}]}
        if path.startswith("teams/") and params.get("group") == "hitting":
            tid = int(path.split("/")[1])
            boost = 12 if tid == 147 else 0
            mk = lambda pa: {"plateAppearances": pa, "atBats": int(pa * .89), "hits": int(pa * .225) + boost,
                             "doubles": int(pa * .045), "triples": 3, "homeRuns": int(pa * .03) + boost,
                             "baseOnBalls": int(pa * .083), "intentionalWalks": 3, "hitByPitch": 8, "sacFlies": 5}
            return {"stats": [{"splits": [{"split": {"code": "vl"}, "stat": mk(1600)},
                                          {"split": {"code": "vr"}, "stat": mk(4200)}]}]}
        if path.startswith("teams/") and params.get("group") == "pitching":
            if params.get("sitCodes") == "rp":
                return {"stats": [{"splits": []}]}  # force the whole-staff fallback
            return {"stats": [{"splits": [{"stat": {"battersFaced": 6000, "inningsPitched": "1400.0",
                                                    "strikeOuts": 1350, "baseOnBalls": 500, "intentionalWalks": 15,
                                                    "hitByPitch": 60, "homeRuns": 180, "groundOuts": 1700,
                                                    "airOuts": 1750}}]}]}
        if path == "standings":
            return {"records": [{"teamRecords": [
                {"team": {"id": tid}, "wins": 83, "losses": 77, "gamesPlayed": 160,
                 "runsScored": 760 if tid == 147 else 700, "runsAllowed": 640 if tid == 147 else 700,
                 "clinched": tid == 147, "eliminationNumber": "E" if tid == 111 else "5",
                 "wildCardEliminationNumber": "E" if tid == 111 else "3",
                 "records": {"splitRecords": [
                    {"type": "home", "wins": 45, "losses": 35}, {"type": "away", "wins": 38, "losses": 42}]}}
                for tid in mp.TEAM_ABBR_BY_ID]}]}
        return None


def _game(pk, away, home, away_pp=None, home_pp=None, status=None, venue=None, **extra):
    side = lambda tid, pp: {"team": {"id": tid}, **({"probablePitcher": pp} if pp else {})}
    g = {"gamePk": pk, "gameDate": "2026-09-24T23:05:00Z",
         "status": status or {"abstractGameState": "Preview", "detailedState": "Scheduled", "codedGameState": "S"},
         "teams": {"away": side(away, away_pp), "home": side(home, home_pp)},
         "venue": venue or {"id": 1000 + home, "name": "Home Park"}, "gameNumber": 1, "doubleHeader": "N"}
    g.update(extra)
    return g


@pytest.fixture(scope="module")
def model():
    return mp.GamePredictor().fit(mp.generate_baseline_training_set(8000, seed=1))


def test_live_provider_end_to_end_with_edge_cases(model):
    schedule = {"dates": [{"games": [
        _game(1, 111, 147, {"id": 2, "fullName": "Lefty Arm"}, {"id": 1, "fullName": "Ace Righty"}),
        _game(2, 119, 137, {"id": 1, "fullName": "Ace Righty"}, None,
              status={"abstractGameState": "Final", "detailedState": "Postponed", "codedGameState": "D",
                      "reason": "Rain"}),
        _game(3, 121, 143, {"id": 3, "fullName": "Debut Kid"}, None),  # TBD home SP, no-data away SP
        _game(4, 135, 119, {"id": 1, "fullName": "Ace Righty"}, {"id": 2, "fullName": "Lefty Arm"},
              venue={"id": 5555, "name": "Estadio Alfredo Harp Helu"}),  # neutral site
        {"gamePk": 5, "teams": {}},  # malformed -> skipped safely
    ]}]}
    games = mp.MLBStatsAPIProvider(client=FakeClient(schedule), max_workers=2).get_slate(date(2026, 9, 24))
    assert [g.game_pk for g in games] == [1, 2, 3, 4]
    by_pk = {g.game_pk: g for g in games}

    assert by_pk[1].home_sp.hand == "R" and by_pk[1].away_sp.hand == "L"
    assert by_pk[1].home_sp.siera < by_pk[1].away_sp.siera  # more strikeouts -> better SIERA
    assert by_pk[1].home.wrc_vs_l > 100  # NYY boosted offense, park-adjusted
    assert by_pk[2].skip_reason and "Postponed" in by_pk[2].skip_reason
    assert by_pk[3].home_sp.tbd and "no MLB data" in by_pk[3].away_sp.notes[0]
    assert by_pk[4].park_factor == 100 and by_pk[4].hr_park_factor == 100 and by_pk[4].notes
    assert by_pk[1].home.pyth_wpct > 0.5 == by_pk[1].away.pyth_wpct
    assert by_pk[1].home.playoff_status == "clinched" and by_pk[1].away.playoff_status == "eliminated"
    assert by_pk[1].home.record == "83-77" and by_pk[1].home.run_diff == 120

    df = mp.predict_slate(games, model)
    assert df.loc[df.game_pk == 2, "pick"].isna().all()
    live = df[df.pick.notna()]
    assert len(live) == 3
    assert live.confidence.between(0.5, 0.99).all()
    assert (live.band_low <= live.confidence).all() and (live.confidence <= live.band_high).all()
    assert live.loc[live.game_pk == 1, "pick"].item() == "NYY"
    assert live.loc[live.game_pk == 1, "playoff_shift"].item() == pytest.approx(0.07)
    assert "SP TBD" in live.loc[live.game_pk == 3, "reason"].item()
    table = mp.render_table(df, width=150)
    assert "POSTPONED" in table and "% Confidence" in table


def test_schedule_unreachable_raises_and_auto_falls_back(monkeypatch):
    class Dead:
        def get(self, *a, **k):
            return None
    with pytest.raises(mp.DataUnavailableError):
        mp.MLBStatsAPIProvider(client=Dead()).get_slate(date(2026, 9, 24))
    real = mp.MLBStatsAPIProvider
    monkeypatch.setattr(mp, "MLBStatsAPIProvider", lambda: real(client=Dead()))
    games, source = mp.load_slate("auto", date(2026, 9, 24), seed=3)
    assert games and source.startswith("SIMULATED")


def test_empty_slate_prints_cleanly(capsys, model):
    df = mp.predict_slate([], model)
    mp.print_report(df, date(2026, 12, 25), "test", model, "test")
    assert "No MLB games scheduled" in capsys.readouterr().out


# ---------------------------------------------------------------- model behaviour
def test_model_is_monotonic_in_pitching_edge(model):
    base = pd.DataFrame([{f: 0.0 for f in mp.FEATURES} | {"venue_split_edge": 0.07, "park_factor": 100.0}])
    better = base.copy()
    better["sp_siera_edge"] = 1.0
    assert model.predict_proba(better)[0] > model.predict_proba(base)[0] > 0.5  # home field


def test_training_rejects_bad_csv_schema():
    with pytest.raises(ValueError):
        mp.GamePredictor().fit(pd.DataFrame({"home_win": [0, 1] * 200}))


def test_cli_simulate_and_csv(tmp_path, capsys):
    out = tmp_path / "picks.csv"
    rc = mp.main(["--source", "simulate", "--n-train", "3000", "--csv-out", str(out), "--width", "140"])
    assert rc == 0 and out.exists()
    assert len(pd.read_csv(out)) == 15
    assert "MLB GAME PREDICTOR" in capsys.readouterr().out


def test_pythag_regression():
    wp, se = mp.pythag_regressed(800, 600, 162)
    assert 0.5 < wp < 800 ** 1.85 / (800 ** 1.85 + 600 ** 1.85)
    assert mp.pythag_regressed(0, 0, 0)[0] == 0.5


def test_hr_prone_flyballer_penalized_more_in_hr_park():
    calc = mp.SabermetricCalculator()
    fly = calc.hr9_projection(0.36, 0.13, 112) - calc.hr9_projection(0.36, 0.13, 100)
    gb = calc.hr9_projection(0.25, 0.09, 112) - calc.hr9_projection(0.25, 0.09, 100)
    assert fly > gb > 0


def test_playoff_shift_direction():
    home = mp.TeamProfile(1, "AAA", "A", playoff_status="eliminated")
    away = mp.TeamProfile(2, "BBB", "B", playoff_status="alive")
    sp = mp.PitcherProfile.unknown("TBD")
    g = mp.GameContext(1, None, "Scheduled", home, away, sp, sp)
    assert mp.playoff_shift(g) == pytest.approx(-0.10)
    assert mp.shift_prob(0.5, -0.10) < 0.5
    home.playoff_status = "alive"
    assert mp.playoff_shift(g) == 0.0


def test_model_rewards_team_strength_and_hr_edge(model):
    base = pd.DataFrame([{f: 0.0 for f in mp.FEATURES} | {"venue_split_edge": 0.07, "park_factor": 100.0}])
    for feat, val in (("team_strength_edge", 0.08), ("sp_hr_risk_edge", 0.6)):
        better = base.copy()
        better[feat] = val
        assert model.predict_proba(better)[0] > model.predict_proba(base)[0]

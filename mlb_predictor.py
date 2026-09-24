#!/usr/bin/env python3
"""
MLB Game Predictor
==================

A modular, sabermetrics-driven win-probability engine for today's MLB slate.

Pipeline
--------
1. DATA INGESTION      -> ``MLBStatsAPIProvider`` pulls the schedule, probable
                          starters, pitcher/team stat lines and standings from the
                          free MLB Stats API (statsapi.mlb.com). ``SimulatedProvider``
                          produces a realistic synthetic slate for offline use and is
                          the automatic fallback when the API is unreachable.
2. FEATURE ENGINEERING -> ``SabermetricCalculator`` derives SIERA, xFIP, K-BB%
                          (season + last 30 days), platoon wRC+ vs the opposing
                          starter's hand, bullpen SIERA, home/road splits and park
                          factors. Every rate stat is regressed toward league average
                          by sample size, and carries a standard error.
3. PREDICTION ENGINE   -> ``GamePredictor`` blends a Logistic Regression (interpretable,
                          drives the "Reason Why") with a monotonic-constrained
                          HistGradientBoosting classifier. By default it is trained on a
                          structural baseline (``generate_baseline_training_set``): games
                          simulated from a run-expectancy + Pythagenpat model with
                          realistic measurement noise. Pass ``--train-csv`` to train on
                          your own historical feature rows instead.
4. OUTPUT              -> A scannable terminal table: pick, win probability with an
                          80% uncertainty band (Monte Carlo over stat sample-size error),
                          and a "Reason Why" built from per-feature log-odds contributions.

Usage
-----
    python mlb_predictor.py                         # today's slate (ET), live API w/ fallback
    python mlb_predictor.py --date 2026-09-24
    python mlb_predictor.py --source simulate --seed 7
    python mlb_predictor.py --train-csv history.csv --csv-out picks.csv

Dependencies: pandas, numpy, scikit-learn, requests (Python 3.9+).
"""
from __future__ import annotations

import argparse
import logging
import math
import shutil
import sys
import textwrap
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, fields
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from urllib3.util.retry import Retry

LOG = logging.getLogger("mlb_predictor")
ET = ZoneInfo("America/New_York")

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class LeagueConstants:
    """League-level constants. Refresh yearly from FanGraphs' Guts! page."""

    # wOBA linear weights
    w_bb: float = 0.689
    w_hbp: float = 0.720
    w_1b: float = 0.882
    w_2b: float = 1.254
    w_3b: float = 1.590
    w_hr: float = 2.050
    woba_scale: float = 1.24
    lg_woba: float = 0.312
    lg_r_per_pa: float = 0.118

    # Pitching environment
    fip_constant: float = 3.15
    lg_hr_per_fb: float = 0.105  # HR per air ball (FB+PU+HR) under our batted-ball estimate
    lg_siera: float = 4.10
    lg_xfip: float = 4.10
    lg_bullpen_siera: float = 4.05
    lg_kbb_pct: float = 14.0  # K-BB%, in percentage points

    # League-average plate-appearance outcome rates (used to re-center SIERA/xFIP)
    lg_k_rate: float = 0.224
    lg_bb_rate: float = 0.083
    lg_ibb_rate: float = 0.003
    lg_hbp_rate: float = 0.011
    lg_hr_rate: float = 0.030
    lg_go_share: float = 0.47  # groundOuts / (groundOuts + airOuts)
    lg_bf_per_ip: float = 4.27
    non_ld_share: float = 0.79  # share of balls in play that are not line drives

    # Home/road baselines
    lg_home_wpct: float = 0.535

    # Regression-to-the-mean prior sample sizes
    sp_prior_bf: float = 150.0
    kbb30_prior_bf: float = 60.0
    kbb_season_prior_bf: float = 120.0
    bullpen_prior_bf: float = 300.0
    wrc_prior_pa: float = 200.0
    split_prior_games: float = 20.0
    pyth_prior_games: float = 50.0
    air_rate_prior_bf: float = 150.0
    hr_per_air_prior: float = 250.0  # air balls of league-average HR/FB added to each pitcher

    # Share of today's opponents that are RHP; used when a starter's hand is unknown
    rhp_share: float = 0.72


CONST = LeagueConstants()

# Late-season motivation / roster-usage adjustment, applied as a log-odds shift on top
# of the model (the structural baseline cannot learn it). Eliminated clubs give
# at-bats to call-ups and rest regulars; clubs that have clinched may do the same.
PLAYOFF_LOGIT_SHIFT: Dict[str, float] = {"alive": 0.0, "clinched": -0.03, "eliminated": -0.10, "unknown": 0.0}

# Approximate multi-year run park factors (100 = neutral), keyed by MLB Stats API
# team abbreviation of the *home* club. Refresh from FanGraphs/Statcast each season.
PARK_FACTORS: Dict[str, int] = {
    "COL": 112, "CIN": 105, "BOS": 104, "KC": 103, "ATH": 103, "OAK": 103,
    "ARI": 101, "AZ": 101, "LAA": 101, "PHI": 101, "NYY": 101, "BAL": 100,
    "TEX": 100, "ATL": 100, "CWS": 100, "WSH": 100, "TOR": 100, "MIN": 100,
    "CHC": 100, "LAD": 100, "HOU": 99, "MIL": 99, "PIT": 98, "STL": 98,
    "DET": 98, "CLE": 98, "SF": 97, "MIA": 97, "TB": 97, "NYM": 96, "SD": 96,
    "SEA": 93,
}

# Approximate multi-year HOME RUN park factors (100 = neutral), same keys as above.
HR_PARK_FACTORS: Dict[str, int] = {
    "CIN": 123, "LAD": 118, "NYY": 117, "ATH": 112, "OAK": 112, "PHI": 113, "COL": 112,
    "LAA": 110, "CWS": 108, "MIL": 108, "HOU": 105, "TOR": 105, "BAL": 104, "TB": 104,
    "ATL": 102, "TEX": 101, "MIN": 98, "WSH": 98, "CHC": 97, "NYM": 97, "SD": 97,
    "BOS": 96, "SEA": 95, "ARI": 92, "AZ": 92, "CLE": 92, "STL": 88, "DET": 88,
    "MIA": 88, "KC": 84, "PIT": 83, "SF": 82,
}

TEAM_ABBR_BY_ID: Dict[int, str] = {
    108: "LAA", 109: "AZ", 110: "BAL", 111: "BOS", 112: "CHC", 113: "CIN",
    114: "CLE", 115: "COL", 116: "DET", 117: "HOU", 118: "KC", 119: "LAD",
    120: "WSH", 121: "NYM", 133: "ATH", 134: "PIT", 135: "SD", 136: "SEA",
    137: "SF", 138: "STL", 139: "TB", 140: "TEX", 141: "TOR", 142: "MIN",
    143: "PHI", 144: "ATL", 145: "CWS", 146: "MIA", 147: "NYY", 158: "MIL",
}

# Model features, all oriented so that a POSITIVE value favors the HOME team.
FEATURES: List[str] = [
    "sp_siera_edge",       # away SP SIERA - home SP SIERA
    "sp_xfip_edge",        # away SP xFIP  - home SP xFIP
    "sp_kbb30_edge",       # home SP K-BB% (L30) - away SP K-BB% (L30), pct points
    "platoon_wrc_edge",    # home wRC+ vs away SP hand - away wRC+ vs home SP hand
    "bullpen_siera_edge",  # away bullpen SIERA - home bullpen SIERA
    "venue_split_edge",    # home team's home W% - away team's road W%
    "team_strength_edge",  # home Pythagorean W% - away Pythagorean W% (regressed)
    "sp_hr_risk_edge",     # away SP projected HR/9 at this park - home SP projected HR/9
    "park_factor",         # run park factor of today's venue (context, not directional)
]
MONOTONIC = [1, 1, 1, 1, 1, 1, 1, 1, 0]

FEATURE_LABELS = {
    "sp_siera_edge": "SP SIERA",
    "sp_xfip_edge": "SP xFIP",
    "sp_kbb30_edge": "SP K-BB% (L30)",
    "platoon_wrc_edge": "Platoon wRC+",
    "bullpen_siera_edge": "Bullpen SIERA",
    "venue_split_edge": "Home/Road split",
    "team_strength_edge": "Team strength (Pythag)",
    "sp_hr_risk_edge": "SP HR risk x park",
    "park_factor": "Park factor",
}

SKIP_STATES = ("postponed", "cancelled", "canceled", "suspended")

# ----------------------------------------------------------------------------
# Small numeric helpers
# ----------------------------------------------------------------------------


def _num(value: Any, default: float = 0.0) -> float:
    """Coerce API values ('.250', '12', None, '-.--') to float safely."""
    if value is None:
        return default
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def parse_innings(ip: Any) -> float:
    """Convert baseball innings notation ('150.2' = 150 2/3) to a true decimal."""
    if ip is None or ip == "":
        return 0.0
    text = str(ip).strip()
    try:
        whole, _, frac = text.partition(".")
        outs = int(frac[:1]) if frac else 0
        if outs not in (0, 1, 2):
            return _num(text)
        return int(whole or 0) + outs / 3.0
    except ValueError:
        return 0.0


def regress(value: Optional[float], n: float, prior: float, n0: float) -> float:
    """Empirical-Bayes style shrinkage of an observed rate toward a prior."""
    if value is None or not math.isfinite(value) or n <= 0:
        return prior
    return (value * n + prior * n0) / (n + n0)


def fmt_wpct(p: float) -> str:
    """Baseball-style winning percentage: 0.552 -> '.552'."""
    return f"{p:.3f}".lstrip("0")


def _present(value: Any) -> bool:
    """True for a real value (pandas turns missing entries into NaN/NaT/None)."""
    if value is None:
        return False
    try:
        return not pd.isna(value)
    except (TypeError, ValueError):
        return True


def short_name(full_name: str) -> str:
    parts = (full_name or "").split()
    if len(parts) < 2:
        return full_name or "TBD"
    return f"{parts[0][0]}. {' '.join(parts[1:])}"


# ----------------------------------------------------------------------------
# Stat lines & sabermetric calculations
# ----------------------------------------------------------------------------


@dataclass
class PitchingLine:
    bf: float = 0.0
    ip: float = 0.0
    k: float = 0.0
    bb: float = 0.0
    ibb: float = 0.0
    hbp: float = 0.0
    hr: float = 0.0
    go: float = 0.0
    ao: float = 0.0

    @classmethod
    def from_api(cls, stat: Optional[dict]) -> Optional["PitchingLine"]:
        if not stat:
            return None
        line = cls(
            bf=_num(stat.get("battersFaced")),
            ip=parse_innings(stat.get("inningsPitched")),
            k=_num(stat.get("strikeOuts")),
            bb=_num(stat.get("baseOnBalls")),
            ibb=_num(stat.get("intentionalWalks")),
            hbp=_num(stat.get("hitByPitch")),
            hr=_num(stat.get("homeRuns")),
            go=_num(stat.get("groundOuts")),
            ao=_num(stat.get("airOuts")),
        )
        return line if line.bf > 0 and line.ip > 0 else None

    def __add__(self, other: "PitchingLine") -> "PitchingLine":
        return PitchingLine(**{f.name: getattr(self, f.name) + getattr(other, f.name) for f in fields(self)})

    def scaled(self, weight: float) -> "PitchingLine":
        return PitchingLine(**{f.name: getattr(self, f.name) * weight for f in fields(self)})

    @property
    def k_bb_pct(self) -> Optional[float]:
        return None if self.bf <= 0 else (self.k - self.bb) / self.bf * 100.0


@dataclass
class BattingLine:
    pa: float = 0.0
    ab: float = 0.0
    h: float = 0.0
    doubles: float = 0.0
    triples: float = 0.0
    hr: float = 0.0
    bb: float = 0.0
    ibb: float = 0.0
    hbp: float = 0.0
    sf: float = 0.0

    @classmethod
    def from_api(cls, stat: Optional[dict]) -> Optional["BattingLine"]:
        if not stat:
            return None
        line = cls(
            pa=_num(stat.get("plateAppearances")),
            ab=_num(stat.get("atBats")),
            h=_num(stat.get("hits")),
            doubles=_num(stat.get("doubles")),
            triples=_num(stat.get("triples")),
            hr=_num(stat.get("homeRuns")),
            bb=_num(stat.get("baseOnBalls")),
            ibb=_num(stat.get("intentionalWalks")),
            hbp=_num(stat.get("hitByPitch")),
            sf=_num(stat.get("sacFlies")),
        )
        return line if line.pa > 0 else None

    def __add__(self, other: "BattingLine") -> "BattingLine":
        return BattingLine(**{f.name: getattr(self, f.name) + getattr(other, f.name) for f in fields(self)})


class SabermetricCalculator:
    """SIERA, xFIP, wOBA and wRC+ from raw counting stats.

    The MLB Stats API exposes groundOuts/airOuts rather than full batted-ball
    counts, so GB and FB (incl. pop-ups) are estimated by splitting non-line-drive
    balls in play by the pitcher's ground-out share. Because that estimate is
    biased, SIERA and xFIP are re-centered so a league-average line maps exactly
    onto the configured league values.
    """

    def __init__(self, const: LeagueConstants = CONST):
        self.c = const
        league = self.league_average_line()
        self._siera_offset = self._siera_raw(league) - const.lg_siera
        self._xfip_offset = self._xfip_raw(league) - const.lg_xfip

    def league_average_line(self, bf: float = 1000.0) -> PitchingLine:
        c = self.c
        bip = bf * (1 - c.lg_k_rate - c.lg_bb_rate - c.lg_hbp_rate - c.lg_hr_rate)
        return PitchingLine(
            bf=bf, ip=bf / c.lg_bf_per_ip, k=bf * c.lg_k_rate, bb=bf * c.lg_bb_rate,
            ibb=bf * c.lg_ibb_rate, hbp=bf * c.lg_hbp_rate, hr=bf * c.lg_hr_rate,
            go=bip * 0.7 * c.lg_go_share, ao=bip * 0.7 * (1 - c.lg_go_share),
        )

    @property
    def lg_air_rate(self) -> float:
        lg = self.league_average_line()
        return self.batted_balls(lg)[1] / lg.bf

    @property
    def bf_per_9(self) -> float:
        return self.c.lg_bf_per_ip * 9.0

    def hr9_projection(self, air_rate: float, hr_per_air: float, hr_park_factor: float) -> float:
        """Projected HR/9 for a pitcher's air-ball rate and HR/air skill in a given park."""
        return self.bf_per_9 * air_rate * hr_per_air * hr_park_factor / 100.0

    def batted_balls(self, line: PitchingLine) -> Tuple[float, float]:
        """Estimate (ground balls, air balls incl. PU and HR)."""
        bip = max(line.bf - line.k - line.bb - line.hbp - line.hr, 0.0)
        outs = line.go + line.ao
        gb_share = line.go / outs if outs > 0 else self.c.lg_go_share
        tracked = bip * self.c.non_ld_share
        return tracked * gb_share, tracked * (1 - gb_share) + line.hr

    def _siera_raw(self, line: PitchingLine) -> float:
        pa = line.bf
        gb, air = self.batted_balls(line)
        so, bb, net = line.k / pa, (line.bb - line.ibb) / pa, (gb - air) / pa
        # FanGraphs SIERA; the squared net-GB term is added for fly-ball pitchers
        # (net < 0) and subtracted for ground-ball pitchers.
        return (
            6.145 - 16.986 * so + 11.434 * bb - 1.858 * net + 7.653 * so ** 2
            - 6.664 * net * abs(net) + 10.130 * so * net - 5.195 * bb * net
        )

    def _xfip_raw(self, line: PitchingLine) -> float:
        _, air = self.batted_balls(line)
        return (
            13 * air * self.c.lg_hr_per_fb + 3 * (line.bb - line.ibb + line.hbp) - 2 * line.k
        ) / line.ip + self.c.fip_constant

    def siera(self, line: Optional[PitchingLine]) -> Optional[float]:
        if line is None or line.bf <= 0:
            return None
        return float(np.clip(self._siera_raw(line) - self._siera_offset, 0.5, 9.0))

    def xfip(self, line: Optional[PitchingLine]) -> Optional[float]:
        if line is None or line.ip <= 0:
            return None
        return float(np.clip(self._xfip_raw(line) - self._xfip_offset, 0.5, 9.0))

    def woba(self, line: BattingLine) -> Optional[float]:
        c = self.c
        denom = line.ab + line.bb - line.ibb + line.sf + line.hbp
        if denom <= 0:
            return None
        singles = max(line.h - line.doubles - line.triples - line.hr, 0.0)
        num = (
            c.w_bb * (line.bb - line.ibb) + c.w_hbp * line.hbp + c.w_1b * singles
            + c.w_2b * line.doubles + c.w_3b * line.triples + c.w_hr * line.hr
        )
        return num / denom

    def wrc_plus(self, line: Optional[BattingLine], lg_woba: float, park_factor: float) -> Optional[float]:
        """Park-adjusted wRC+ (half of a team's games are at its home park)."""
        if line is None:
            return None
        woba = self.woba(line)
        if woba is None:
            return None
        lg_rpa = self.c.lg_r_per_pa
        pf_half = (park_factor / 100.0 + 1.0) / 2.0
        wraa_pa = (woba - lg_woba) / self.c.woba_scale
        return 100.0 * (wraa_pa + lg_rpa + (lg_rpa - pf_half * lg_rpa)) / lg_rpa


# ----------------------------------------------------------------------------
# Domain objects
# ----------------------------------------------------------------------------


@dataclass
class PitcherProfile:
    name: str
    hand: str  # "L", "R" or "?"
    siera: float
    xfip: float
    kbb_season: float
    kbb30: float
    bf_season: float = 0.0
    bf30: float = 0.0
    siera_se: float = 0.9
    xfip_se: float = 1.0
    kbb30_se: float = 5.0
    air_rate: float = 0.303  # air balls (FB + PU + HR) per batter faced, regressed
    hr_per_air: float = CONST.lg_hr_per_fb  # regressed HR per air ball
    hr9_se: float = 0.35
    tbd: bool = False
    notes: List[str] = field(default_factory=list)

    @classmethod
    def unknown(cls, name: str = "TBD", const: LeagueConstants = CONST) -> "PitcherProfile":
        """Replacement-level proxy for an unannounced or data-less starter."""
        return cls(
            name=name, hand="?", siera=const.lg_siera + 0.30, xfip=const.lg_xfip + 0.30,
            kbb_season=const.lg_kbb_pct - 2.0, kbb30=const.lg_kbb_pct - 2.0,
            siera_se=0.9, xfip_se=1.0, kbb30_se=5.0, hr_per_air=const.lg_hr_per_fb * 1.05,
            hr9_se=0.45, tbd=name == "TBD",
            notes=["SP TBD" if name == "TBD" else f"no MLB data for {short_name(name)}"],
        )


@dataclass
class TeamProfile:
    team_id: int
    abbr: str
    name: str
    wrc_vs_l: float = 100.0
    wrc_vs_r: float = 100.0
    wrc_vs_l_se: float = 15.0
    wrc_vs_r_se: float = 15.0
    bullpen_siera: float = CONST.lg_bullpen_siera
    bullpen_se: float = 0.4
    home_wpct: float = CONST.lg_home_wpct
    away_wpct: float = 1 - CONST.lg_home_wpct
    home_games: float = 0.0
    away_games: float = 0.0
    pyth_wpct: float = 0.5
    pyth_se: float = 0.06
    wins: int = 0
    losses: int = 0
    run_diff: int = 0
    playoff_status: str = "unknown"  # alive | clinched | eliminated | unknown
    notes: List[str] = field(default_factory=list)

    @property
    def record(self) -> str:
        return f"{self.wins}-{self.losses}" if self.wins or self.losses else ""

    def wrc_vs(self, hand: str) -> Tuple[float, float]:
        if hand == "L":
            return self.wrc_vs_l, self.wrc_vs_l_se
        if hand == "R":
            return self.wrc_vs_r, self.wrc_vs_r_se
        w = CONST.rhp_share
        return (w * self.wrc_vs_r + (1 - w) * self.wrc_vs_l,
                math.hypot(w * self.wrc_vs_r_se, (1 - w) * self.wrc_vs_l_se))


@dataclass
class GameContext:
    game_pk: int
    start_time: Optional[datetime]
    status: str
    home: TeamProfile
    away: TeamProfile
    home_sp: PitcherProfile
    away_sp: PitcherProfile
    park_factor: float = 100.0
    hr_park_factor: float = 100.0
    venue: str = ""
    game_number: int = 1
    doubleheader: bool = False
    skip_reason: Optional[str] = None
    home_score: Optional[int] = None
    away_score: Optional[int] = None
    is_final: bool = False
    notes: List[str] = field(default_factory=list)


# ----------------------------------------------------------------------------
# Data ingestion: MLB Stats API
# ----------------------------------------------------------------------------


class MLBStatsAPIClient:
    """Thin, fault-tolerant wrapper around statsapi.mlb.com with retries + cache."""

    BASE_URL = "https://statsapi.mlb.com/api/v1"

    def __init__(self, timeout: float = 10.0, retries: int = 3):
        self.timeout = timeout
        self.session = requests.Session()
        retry = Retry(total=retries, backoff_factor=0.6, status_forcelist=(429, 500, 502, 503, 504),
                      allowed_methods=frozenset({"GET"}))
        adapter = HTTPAdapter(max_retries=retry, pool_maxsize=16)
        self.session.mount("https://", adapter)
        self.session.headers.update({"User-Agent": "mlb-predictor/1.0"})
        self._cache: Dict[Tuple[str, Tuple], Optional[dict]] = {}

    def get(self, path: str, **params: Any) -> Optional[dict]:
        key = (path, tuple(sorted(params.items())))
        if key in self._cache:
            return self._cache[key]
        url = f"{self.BASE_URL}/{path.lstrip('/')}"
        try:
            resp = self.session.get(url, params=params, timeout=self.timeout)
            resp.raise_for_status()
            data = resp.json()
        except (requests.RequestException, ValueError) as exc:
            LOG.debug("GET %s %s failed: %s", url, params, exc)
            data = None
        self._cache[key] = data
        return data


def first_split_stat(payload: Optional[dict]) -> Optional[dict]:
    """Return the first ``stats[0].splits[0].stat`` dict of a stats payload, if any."""
    try:
        splits = payload["stats"][0]["splits"]  # type: ignore[index]
    except (KeyError, IndexError, TypeError):
        return None
    return splits[0].get("stat") if splits else None


def splits_by_code(payload: Optional[dict]) -> Dict[str, dict]:
    """Map ``split.code`` -> stat dict for a ``statSplits`` payload."""
    out: Dict[str, dict] = {}
    try:
        for block in payload.get("stats", []):  # type: ignore[union-attr]
            for sp in block.get("splits", []):
                code = (sp.get("split") or {}).get("code")
                if code and sp.get("stat"):
                    out[code] = sp["stat"]
    except AttributeError:
        pass
    return out


class DataUnavailableError(RuntimeError):
    """Raised when a provider cannot produce a schedule at all."""


class MLBStatsAPIProvider:
    """Builds ``GameContext`` objects for a date from the public MLB Stats API."""

    def __init__(self, client: Optional[MLBStatsAPIClient] = None,
                 calc: Optional[SabermetricCalculator] = None, max_workers: int = 12):
        self.api = client or MLBStatsAPIClient()
        self.calc = calc or SabermetricCalculator()
        self.c = self.calc.c
        self.max_workers = max_workers

    # -- public -----------------------------------------------------------
    def get_slate(self, game_date: date) -> List[GameContext]:
        season = game_date.year
        schedule = self.api.get("schedule", sportId=1, date=game_date.isoformat(),
                                hydrate="probablePitcher,team,venue")
        if schedule is None:
            raise DataUnavailableError("MLB Stats API schedule endpoint unreachable")
        raw_games = [g for d in schedule.get("dates", []) for g in d.get("games", [])]
        if not raw_games:
            return []

        teams_meta = self._teams(season)
        slate_team_ids = {g["teams"][side]["team"]["id"] for g in raw_games for side in ("home", "away")
                          if g.get("teams", {}).get(side, {}).get("team", {}).get("id")}
        pitcher_ids = {g["teams"][side]["probablePitcher"]["id"] for g in raw_games for side in ("home", "away")
                       if (g.get("teams", {}).get(side, {}).get("probablePitcher") or {}).get("id")}

        hands = self._pitcher_hands(pitcher_ids)
        pitchers = self._pitcher_profiles(pitcher_ids, hands, season, game_date)
        standings = self._standings(season)
        offense = self._offense_profiles(set(teams_meta) | slate_team_ids, teams_meta, season)
        bullpens = self._bullpens(slate_team_ids, season)

        games = []
        for g in raw_games:
            try:
                games.append(self._build_game(g, teams_meta, pitchers, standings, offense, bullpens))
            except Exception as exc:  # one malformed game must never sink the slate
                LOG.warning("Skipping malformed game %s: %s", g.get("gamePk"), exc)
        return games

    # -- fetchers ------------------------------------------------------------
    def _parallel(self, fn, items: Iterable) -> Dict[Any, Any]:
        items = list(items)
        with ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            return dict(zip(items, pool.map(fn, items)))

    def _teams(self, season: int) -> Dict[int, dict]:
        payload = self.api.get("teams", sportId=1, season=season) or {}
        out = {}
        for t in payload.get("teams", []):
            if t.get("id"):
                out[t["id"]] = {
                    "abbr": t.get("abbreviation") or TEAM_ABBR_BY_ID.get(t["id"], str(t["id"])),
                    "name": t.get("name", ""),
                    "venue_id": (t.get("venue") or {}).get("id"),
                }
        if not out:
            LOG.warning("Team directory unavailable; using built-in abbreviations")
            out = {tid: {"abbr": ab, "name": ab, "venue_id": None} for tid, ab in TEAM_ABBR_BY_ID.items()}
        return out

    def _pitcher_hands(self, pitcher_ids: Iterable[int]) -> Dict[int, str]:
        ids = sorted(pitcher_ids)
        hands: Dict[int, str] = {}
        for i in range(0, len(ids), 50):
            chunk = ids[i:i + 50]
            payload = self.api.get("people", personIds=",".join(map(str, chunk))) or {}
            for p in payload.get("people", []):
                code = (p.get("pitchHand") or {}).get("code")
                hands[p.get("id")] = code if code in ("L", "R") else "?"
        return hands

    def _pitching_line(self, pid: int, **params: Any) -> Optional[PitchingLine]:
        payload = self.api.get(f"people/{pid}/stats", group="pitching", **params)
        return PitchingLine.from_api(first_split_stat(payload))

    def _pitcher_profiles(self, pitcher_ids: Iterable[int], hands: Dict[int, str],
                          season: int, game_date: date) -> Dict[int, PitcherProfile]:
        start30 = (game_date - timedelta(days=30)).isoformat()
        end30 = (game_date - timedelta(days=1)).isoformat()

        def build(pid: int) -> Optional[PitcherProfile]:
            season_line = self._pitching_line(pid, stats="season", season=season)
            notes = []
            # Early season / call-ups: blend in half-weighted prior-season data.
            if season_line is None or season_line.bf < 100:
                prior = self._pitching_line(pid, stats="season", season=season - 1)
                if prior is not None:
                    season_line = prior.scaled(0.5) if season_line is None else season_line + prior.scaled(0.5)
                    notes.append("blended w/ prior season")
            if season_line is None:
                return None
            l30 = self._pitching_line(pid, stats="byDateRange", season=season,
                                      startDate=start30, endDate=end30)
            return build_pitcher_profile("", hands.get(pid, "?"), season_line, l30, self.calc, notes)

        return {pid: prof for pid, prof in self._parallel(build, pitcher_ids).items() if prof is not None}

    def _standings(self, season: int) -> Dict[int, dict]:
        payload = self.api.get("standings", leagueId="103,104", season=season,
                               standingsTypes="regularSeason") or {}
        out: Dict[int, dict] = {}
        for rec in payload.get("records", []):
            for tr in rec.get("teamRecords", []):
                tid = (tr.get("team") or {}).get("id")
                splits = {s.get("type"): s for s in (tr.get("records") or {}).get("splitRecords", [])}
                if tid:
                    if tr.get("clinched"):
                        status = "clinched"
                    elif tr.get("eliminationNumber") == "E" and tr.get("wildCardEliminationNumber") == "E":
                        status = "eliminated"
                    else:
                        status = "alive"
                    out[tid] = {
                        "wins": int(_num(tr.get("wins"))), "losses": int(_num(tr.get("losses"))),
                        "rs": _num(tr.get("runsScored")), "ra": _num(tr.get("runsAllowed")),
                        "gp": _num(tr.get("gamesPlayed")) or _num(tr.get("wins")) + _num(tr.get("losses")),
                        "status": status,
                        "home_w": _num((splits.get("home") or {}).get("wins")),
                        "home_l": _num((splits.get("home") or {}).get("losses")),
                        "away_w": _num((splits.get("away") or {}).get("wins")),
                        "away_l": _num((splits.get("away") or {}).get("losses")),
                    }
        return out

    def _offense_profiles(self, team_ids: Iterable[int], teams_meta: Dict[int, dict],
                          season: int) -> Dict[int, dict]:
        def fetch(tid: int) -> Dict[str, Optional[BattingLine]]:
            payload = self.api.get(f"teams/{tid}/stats", stats="statSplits", group="hitting",
                                   season=season, sitCodes="vl,vr")
            by_code = splits_by_code(payload)
            return {"vl": BattingLine.from_api(by_code.get("vl")), "vr": BattingLine.from_api(by_code.get("vr"))}

        raw = self._parallel(fetch, team_ids)
        # League wOBA per pitcher hand from the aggregate of every club (self-consistent baseline).
        lg_woba: Dict[str, float] = {}
        for code in ("vl", "vr"):
            lines = [r[code] for r in raw.values() if r.get(code) is not None]
            total = sum(lines[1:], lines[0]) if len(lines) >= 20 else None
            lg_woba[code] = (self.calc.woba(total) if total else None) or self.c.lg_woba

        out: Dict[int, dict] = {}
        for tid, r in raw.items():
            abbr = teams_meta.get(tid, {}).get("abbr") or TEAM_ABBR_BY_ID.get(tid, "")
            pf = PARK_FACTORS.get(abbr, 100)
            entry = {}
            for code in ("vl", "vr"):
                line = r.get(code)
                wrc = self.calc.wrc_plus(line, lg_woba[code], pf)
                pa = line.pa if line else 0.0
                entry[code] = regress(wrc, pa, 100.0, self.c.wrc_prior_pa)
                entry[f"{code}_se"] = 342.0 / math.sqrt(pa + self.c.wrc_prior_pa)
                entry[f"{code}_missing"] = line is None
            out[tid] = entry
        return out

    def _bullpens(self, team_ids: Iterable[int], season: int) -> Dict[int, dict]:
        def fetch(tid: int) -> dict:
            payload = self.api.get(f"teams/{tid}/stats", stats="statSplits", group="pitching",
                                   season=season, sitCodes="rp")
            line = PitchingLine.from_api(splits_by_code(payload).get("rp"))
            source = "bullpen"
            if line is None:  # fall back to whole-staff numbers
                line = PitchingLine.from_api(first_split_stat(
                    self.api.get(f"teams/{tid}/stats", stats="season", group="pitching", season=season)))
                source = "staff"
            siera = self.calc.siera(line)
            bf = line.bf if line else 0.0
            return {
                "siera": regress(siera, bf, self.c.lg_bullpen_siera, self.c.bullpen_prior_bf),
                "se": 0.85 * math.sqrt(100.0 / (bf + self.c.bullpen_prior_bf)),
                "source": source if line else "missing",
            }

        return self._parallel(fetch, team_ids)

    # -- assembly -------------------------------------------------------------
    def _team_profile(self, tid: int, teams_meta: Dict[int, dict], standings: Dict[int, dict],
                      offense: Dict[int, dict], bullpens: Dict[int, dict]) -> TeamProfile:
        meta = teams_meta.get(tid, {})
        abbr = meta.get("abbr") or TEAM_ABBR_BY_ID.get(tid, str(tid))
        team = TeamProfile(team_id=tid, abbr=abbr, name=meta.get("name", abbr))
        off = offense.get(tid)
        if off:
            team.wrc_vs_l, team.wrc_vs_r = off["vl"], off["vr"]
            team.wrc_vs_l_se, team.wrc_vs_r_se = off["vl_se"], off["vr_se"]
            if off["vl_missing"] or off["vr_missing"]:
                team.notes.append(f"{abbr} platoon splits imputed")
        else:
            team.notes.append(f"{abbr} offense imputed")
        bp = bullpens.get(tid)
        if bp:
            team.bullpen_siera, team.bullpen_se = bp["siera"], bp["se"]
            if bp["source"] == "missing":
                team.notes.append(f"{abbr} bullpen imputed")
        st = standings.get(tid)
        if st:
            k = self.c.split_prior_games
            team.home_games = st["home_w"] + st["home_l"]
            team.away_games = st["away_w"] + st["away_l"]
            team.home_wpct = (st["home_w"] + self.c.lg_home_wpct * k) / (team.home_games + k)
            team.away_wpct = (st["away_w"] + (1 - self.c.lg_home_wpct) * k) / (team.away_games + k)
            team.wins, team.losses = st["wins"], st["losses"]
            team.run_diff = int(st["rs"] - st["ra"])
            team.playoff_status = st["status"]
            team.pyth_wpct, team.pyth_se = pythag_regressed(st["rs"], st["ra"], st["gp"], self.c)
        else:
            team.notes.append(f"{abbr} splits imputed")
        return team

    def _build_game(self, g: dict, teams_meta, pitchers, standings, offense, bullpens) -> GameContext:
        status = g.get("status") or {}
        detailed = status.get("detailedState", "Scheduled")
        coded = status.get("codedGameState", "")
        abstract = status.get("abstractGameState", "")
        sides = {}
        for side in ("home", "away"):
            t = g["teams"][side]
            tid = t["team"]["id"]
            team = self._team_profile(tid, teams_meta, standings, offense, bullpens)
            pp = t.get("probablePitcher") or {}
            if pp.get("id") and pp["id"] in pitchers:
                sp = pitchers[pp["id"]]
                sp.name = pp.get("fullName", "Unknown")
            elif pp.get("id"):
                sp = PitcherProfile.unknown(pp.get("fullName", "Unknown"), self.c)
            else:
                sp = PitcherProfile.unknown("TBD", self.c)
            sides[side] = (team, sp, t.get("score"))

        home, home_sp, home_score = sides["home"]
        away, away_sp, away_score = sides["away"]
        venue = g.get("venue") or {}
        home_venue_id = teams_meta.get(home.team_id, {}).get("venue_id")
        pf = PARK_FACTORS.get(home.abbr, 100)
        hr_pf = HR_PARK_FACTORS.get(home.abbr, 100)
        notes = []
        if home_venue_id and venue.get("id") and venue["id"] != home_venue_id:
            pf = hr_pf = 100  # neutral-site / alternate venue (London, Little League Classic, ...)
            notes.append(f"alt venue: {venue.get('name', '?')}")

        skip = None
        if coded in ("D", "C") or any(s in detailed.lower() for s in SKIP_STATES):
            reason = status.get("reason")
            skip = f"{detailed}{f' ({reason})' if reason and reason not in detailed else ''}"

        start = None
        if g.get("gameDate"):
            try:
                start = datetime.fromisoformat(g["gameDate"].replace("Z", "+00:00"))
            except ValueError:
                pass

        return GameContext(
            game_pk=int(g.get("gamePk", 0)), start_time=start, status=detailed,
            home=home, away=away, home_sp=home_sp, away_sp=away_sp, park_factor=pf,
            hr_park_factor=hr_pf, venue=venue.get("name", ""), game_number=int(g.get("gameNumber", 1) or 1),
            doubleheader=g.get("doubleHeader", "N") in ("Y", "S"), skip_reason=skip,
            home_score=home_score, away_score=away_score,
            is_final=abstract == "Final" and skip is None, notes=notes,
        )


def pythag_regressed(rs: float, ra: float, gp: float, const: LeagueConstants = CONST) -> Tuple[float, float]:
    """Pythagenpat W% from runs scored/allowed, regressed toward .500. Returns (wpct, se)."""
    k = const.pyth_prior_games
    if gp <= 0 or rs <= 0 or ra <= 0:
        return 0.5, 0.5 / math.sqrt(k)
    x = ((rs + ra) / gp) ** 0.287
    raw = rs ** x / (rs ** x + ra ** x)
    return (raw * gp + 0.5 * k) / (gp + k), 0.42 / math.sqrt(gp + k)


def build_pitcher_profile(name: str, hand: str, season_line: PitchingLine, l30: Optional[PitchingLine],
                          calc: SabermetricCalculator, notes: Optional[List[str]] = None) -> PitcherProfile:
    c = calc.c
    bf = season_line.bf
    siera = regress(calc.siera(season_line), bf, c.lg_siera, c.sp_prior_bf)
    xfip = regress(calc.xfip(season_line), bf, c.lg_xfip, c.sp_prior_bf)
    kbb_season = regress(season_line.k_bb_pct, bf, c.lg_kbb_pct, c.kbb_season_prior_bf)
    bf30 = l30.bf if l30 else 0.0
    kbb30 = regress(l30.k_bb_pct if l30 else None, bf30, kbb_season, c.kbb30_prior_bf)
    _, air = calc.batted_balls(season_line)
    air_rate = regress(air / bf, bf, calc.lg_air_rate, c.air_rate_prior_bf)
    hr_per_air = regress(season_line.hr / air if air > 0 else None, air, c.lg_hr_per_fb, c.hr_per_air_prior)
    notes = list(notes or [])
    if bf30 == 0:
        notes.append("no L30 appearances")
    return PitcherProfile(
        name=name, hand=hand, siera=siera, xfip=xfip, kbb_season=kbb_season, kbb30=kbb30,
        bf_season=bf, bf30=bf30,
        siera_se=0.85 * math.sqrt(100.0 / (bf + c.sp_prior_bf)),
        xfip_se=0.95 * math.sqrt(100.0 / (bf + c.sp_prior_bf)),
        kbb30_se=100.0 * math.sqrt(0.18 / (bf30 + c.kbb30_prior_bf)),
        air_rate=air_rate, hr_per_air=hr_per_air,
        hr9_se=calc.bf_per_9 * math.sqrt(0.03 / (bf + c.hr_per_air_prior)),
        notes=notes,
    )


# ----------------------------------------------------------------------------
# Data ingestion: simulated slate (offline mode / fallback)
# ----------------------------------------------------------------------------


class SimulatedProvider:
    """Generates a plausible synthetic slate. Clearly labeled as simulated in output."""

    def __init__(self, seed: int = 42, n_games: int = 15, const: LeagueConstants = CONST):
        self.rng = np.random.default_rng(seed)
        self.n_games = n_games
        self.c = const

    def _team(self, tid: int, abbr: str) -> TeamProfile:
        r = self.rng
        base = r.normal(100, 9)
        home_g, away_g = r.integers(70, 81, size=2)
        quality = r.normal(0, 0.05)
        games = int(home_g + away_g)
        pyth = float(np.clip(0.5 + quality + r.normal(0, 0.03), 0.3, 0.7))
        wins = int(round(games * float(np.clip(pyth + r.normal(0, 0.03), 0.25, 0.75))))
        status = "eliminated" if wins / games < 0.47 else "clinched" if wins / games > 0.58 else "alive"
        return TeamProfile(
            team_id=tid, abbr=abbr, name=abbr,
            wrc_vs_l=base + r.normal(0, 8), wrc_vs_r=base + r.normal(0, 5),
            wrc_vs_l_se=342 / math.sqrt(1600), wrc_vs_r_se=342 / math.sqrt(4200),
            bullpen_siera=r.normal(self.c.lg_bullpen_siera, 0.30), bullpen_se=0.17,
            home_wpct=float(np.clip(self.c.lg_home_wpct + quality + r.normal(0, 0.04), 0.3, 0.72)),
            away_wpct=float(np.clip(1 - self.c.lg_home_wpct + quality + r.normal(0, 0.04), 0.28, 0.7)),
            home_games=float(home_g), away_games=float(away_g),
            pyth_wpct=(pyth * games + 0.5 * self.c.pyth_prior_games) / (games + self.c.pyth_prior_games),
            pyth_se=0.42 / math.sqrt(games + self.c.pyth_prior_games),
            wins=wins, losses=games - wins, run_diff=int(round((pyth - 0.5) * 10 * games)),
            playoff_status=status,
        )

    def _pitcher(self, abbr: str, slot: int) -> PitcherProfile:
        r = self.rng
        siera = float(np.clip(r.normal(4.05, 0.55), 2.5, 6.0))
        kbb_season = self.c.lg_kbb_pct - 8.0 * (siera - self.c.lg_siera) + r.normal(0, 1.5)
        bf, bf30 = float(r.integers(250, 800)), float(r.integers(40, 120))
        return PitcherProfile(
            name=f"{abbr}-SP{slot}", hand="L" if r.random() < 0.28 else "R",
            siera=siera, xfip=siera + r.normal(0.05, 0.30),
            kbb_season=kbb_season, kbb30=kbb_season + r.normal(0, 4.0),
            bf_season=bf, bf30=bf30,
            siera_se=0.85 * math.sqrt(100 / (bf + 150)), xfip_se=0.95 * math.sqrt(100 / (bf + 150)),
            kbb30_se=100 * math.sqrt(0.18 / (bf30 + 60)),
            air_rate=float(r.normal(0.303, 0.03)), hr_per_air=float(r.normal(self.c.lg_hr_per_fb, 0.008)),
            hr9_se=38.4 * math.sqrt(0.03 / (bf + 250)),
        )

    def get_slate(self, game_date: date) -> List[GameContext]:
        ids = list(TEAM_ABBR_BY_ID.items())
        order = self.rng.permutation(len(ids))[: 2 * self.n_games]
        games = []
        for i in range(self.n_games):
            (hid, habbr), (aid, aabbr) = ids[order[2 * i]], ids[order[2 * i + 1]]
            hour, minute = divmod(13 * 60 + 5 + int(self.rng.integers(0, 10)) * 55, 60)
            start = datetime(game_date.year, game_date.month, game_date.day, hour % 24, minute, tzinfo=ET)
            game = GameContext(
                game_pk=900000 + i, start_time=start, status="Scheduled",
                home=self._team(hid, habbr), away=self._team(aid, aabbr),
                home_sp=self._pitcher(habbr, int(self.rng.integers(1, 6))),
                away_sp=self._pitcher(aabbr, int(self.rng.integers(1, 6))),
                park_factor=PARK_FACTORS.get(habbr, 100), hr_park_factor=HR_PARK_FACTORS.get(habbr, 100),
                venue=f"{habbr} home park",
            )
            games.append(game)
        # Deliberately exercise edge cases in the simulated slate.
        if len(games) >= 3:
            games[1].skip_reason = "Postponed (Rain)"
            games[1].status = "Postponed"
            games[2].away_sp = PitcherProfile.unknown("TBD", self.c)
        return sorted(games, key=lambda g: g.start_time or datetime.max.replace(tzinfo=ET))


# ----------------------------------------------------------------------------
# Feature engineering
# ----------------------------------------------------------------------------


_CALC = SabermetricCalculator()


def game_features(g: GameContext) -> Tuple[Dict[str, float], Dict[str, float], Dict[str, Any]]:
    """Return (features, feature standard errors, display metadata) for one game."""
    home_hr9 = _CALC.hr9_projection(g.home_sp.air_rate, g.home_sp.hr_per_air, g.hr_park_factor)
    away_hr9 = _CALC.hr9_projection(g.away_sp.air_rate, g.away_sp.hr_per_air, g.hr_park_factor)
    home_off, home_off_se = g.home.wrc_vs(g.away_sp.hand)
    away_off, away_off_se = g.away.wrc_vs(g.home_sp.hand)
    feats = {
        "sp_siera_edge": g.away_sp.siera - g.home_sp.siera,
        "sp_xfip_edge": g.away_sp.xfip - g.home_sp.xfip,
        "sp_kbb30_edge": g.home_sp.kbb30 - g.away_sp.kbb30,
        "platoon_wrc_edge": home_off - away_off,
        "bullpen_siera_edge": g.away.bullpen_siera - g.home.bullpen_siera,
        "venue_split_edge": g.home.home_wpct - g.away.away_wpct,
        "team_strength_edge": g.home.pyth_wpct - g.away.pyth_wpct,
        "sp_hr_risk_edge": away_hr9 - home_hr9,
        "park_factor": float(g.park_factor),
    }
    ses = {
        "sp_siera_edge": math.hypot(g.home_sp.siera_se, g.away_sp.siera_se),
        "sp_xfip_edge": math.hypot(g.home_sp.xfip_se, g.away_sp.xfip_se),
        "sp_kbb30_edge": math.hypot(g.home_sp.kbb30_se, g.away_sp.kbb30_se),
        "platoon_wrc_edge": math.hypot(home_off_se, away_off_se),
        "bullpen_siera_edge": math.hypot(g.home.bullpen_se, g.away.bullpen_se),
        "venue_split_edge": math.hypot(0.5 / math.sqrt(g.home.home_games + CONST.split_prior_games),
                                       0.5 / math.sqrt(g.away.away_games + CONST.split_prior_games)),
        "team_strength_edge": math.hypot(g.home.pyth_se, g.away.pyth_se),
        "sp_hr_risk_edge": math.hypot(g.home_sp.hr9_se, g.away_sp.hr9_se),
        "park_factor": 0.0,
    }
    meta = {
        "home_wrc": home_off, "away_wrc": away_off, "home_hr9": home_hr9, "away_hr9": away_hr9,
        "home_faces": g.away_sp.hand, "away_faces": g.home_sp.hand,
    }
    return feats, ses, meta


# ----------------------------------------------------------------------------
# Baseline training data (structural simulation)
# ----------------------------------------------------------------------------


def generate_baseline_training_set(n: int = 30000, seed: int = 42,
                                   const: LeagueConstants = CONST) -> pd.DataFrame:
    """Simulate games from a structural run model to create a labeled baseline.

    True talent drives runs via a run-expectancy model (offense wRC+ x opposing
    pitching RA9 x park x home field) and a Pythagenpat win expectancy. The
    *observed* features the model trains on include realistic sample noise, so
    the fitted coefficients are appropriately shrunk rather than over-confident.
    """
    rng = np.random.default_rng(seed)
    norm = rng.normal

    sp_true = {s: np.clip(norm(const.lg_siera, 0.50, n), 2.4, 6.2) for s in ("h", "a")}
    form = {s: norm(0, 0.30, n) for s in ("h", "a")}  # current-form deviation, visible in L30 K-BB%
    bp_true = {s: norm(const.lg_bullpen_siera, 0.30, n) for s in ("h", "a")}
    off_true = {s: norm(100, 10, n) for s in ("h", "a")}  # wRC+ vs today's starter hand
    resid = {s: norm(0, 0.35, n) for s in ("h", "a")}  # defense/baserunning/depth, runs per game
    parks = sorted(PARK_FACTORS)
    idx = rng.integers(0, len(parks), n)
    pf = np.array([PARK_FACTORS[parks[i]] for i in idx], dtype=float)
    hr_mult = np.array([HR_PARK_FACTORS.get(parks[i], 100) for i in idx], dtype=float) / 100.0
    games_played = rng.integers(40, 163, n).astype(float)

    calc = SabermetricCalculator(const)
    lg_air, lg_hrfb, bf9 = calc.lg_air_rate, const.lg_hr_per_fb, calc.bf_per_9
    ref_ra9 = (5.4 * const.lg_siera + 3.6 * const.lg_bullpen_siera) / 9.0

    # Home-run proneness x park: runs a starter allows beyond what SIERA (neutral park,
    # league HR/FB) implies. ~1.4 runs per home run.
    air_true = {s: norm(lg_air, 0.035, n) for s in ("h", "a")}
    hrfb_true = {s: norm(lg_hrfb, 0.012, n) for s in ("h", "a")}
    hr_extra = {s: 1.4 * bf9 * ((air_true[s] - lg_air) * lg_hrfb * (hr_mult - 1)
                                + air_true[s] * (hrfb_true[s] - lg_hrfb) * hr_mult) for s in ("h", "a")}

    # Season-long team strength (what a Pythagorean record measures): offense, whole
    # staff and the residual defense/baserunning/depth component.
    pyth_obs = {}
    k = const.pyth_prior_games
    for s in ("h", "a"):
        season_off = off_true[s] + norm(0, 5, n)
        rotation = norm(const.lg_siera, 0.35, n)
        strength = 4.45 * (season_off / 100 - 1) + ref_ra9 - (0.6 * rotation + 0.4 * bp_true[s]) + resid[s]
        raw = 0.5 + 0.1 * strength + norm(0, 1, n) * 0.42 / np.sqrt(games_played)
        pyth_obs[s] = (raw * games_played + 0.5 * k) / (games_played + k)

    obs = {}
    for s in ("h", "a"):
        cur = sp_true[s] + form[s]
        obs[f"siera_{s}"] = sp_true[s] + norm(0, 0.30, n)
        obs[f"xfip_{s}"] = sp_true[s] + norm(0.05, 0.38, n)
        obs[f"kbb30_{s}"] = const.lg_kbb_pct - 8.0 * (cur - const.lg_siera) + norm(0, 4.5, n)
        obs[f"bp_{s}"] = bp_true[s] + norm(0, 0.18, n)
        obs[f"wrc_{s}"] = off_true[s] + norm(0, 8, n)
        air_obs = lg_air + 0.77 * (air_true[s] - lg_air + norm(0, 0.02, n))
        hrfb_obs = lg_hrfb + 0.44 * (hrfb_true[s] - lg_hrfb + norm(0, 0.022, n))
        obs[f"hr9_{s}"] = bf9 * air_obs * hrfb_obs * hr_mult
    home_rec = const.lg_home_wpct + 0.10 * resid["h"] + 0.0025 * (off_true["h"] - 100) + norm(0, 0.055, n)
    away_rec = 1 - const.lg_home_wpct + 0.10 * resid["a"] + 0.0025 * (off_true["a"] - 100) + norm(0, 0.055, n)

    opp_ra_home = (5.4 * (sp_true["a"] + form["a"] + hr_extra["a"]) + 3.6 * bp_true["a"]) / 9.0
    opp_ra_away = (5.4 * (sp_true["h"] + form["h"] + hr_extra["h"]) + 3.6 * bp_true["h"]) / 9.0
    net = resid["h"] - resid["a"]
    runs_h = 4.45 * off_true["h"] / 100 * opp_ra_home / ref_ra9 * pf / 100 * 1.04 + net / 2
    runs_a = 4.45 * off_true["a"] / 100 * opp_ra_away / ref_ra9 * pf / 100 * 0.965 - net / 2
    runs_h, runs_a = np.clip(runs_h, 1.5, None), np.clip(runs_a, 1.5, None)
    exp = (runs_h + runs_a) ** 0.287  # Pythagenpat exponent
    p_home = runs_h ** exp / (runs_h ** exp + runs_a ** exp)

    return pd.DataFrame({
        "sp_siera_edge": obs["siera_a"] - obs["siera_h"],
        "sp_xfip_edge": obs["xfip_a"] - obs["xfip_h"],
        "sp_kbb30_edge": obs["kbb30_h"] - obs["kbb30_a"],
        "platoon_wrc_edge": obs["wrc_h"] - obs["wrc_a"],
        "bullpen_siera_edge": obs["bp_a"] - obs["bp_h"],
        "venue_split_edge": home_rec - away_rec,
        "team_strength_edge": pyth_obs["h"] - pyth_obs["a"],
        "sp_hr_risk_edge": obs["hr9_a"] - obs["hr9_h"],
        "park_factor": pf,
        "home_win": (rng.random(n) < p_home).astype(int),
    })


# ----------------------------------------------------------------------------
# Prediction engine
# ----------------------------------------------------------------------------


class GamePredictor:
    """Logistic Regression + monotonic gradient boosting ensemble."""

    def __init__(self, logit_weight: float = 0.6, seed: int = 42):
        self.logit_weight = logit_weight
        self.seed = seed
        self.logit = Pipeline([
            ("scale", StandardScaler()),
            ("lr", LogisticRegression(C=1.0, max_iter=1000)),
        ])
        self.gbm = HistGradientBoostingClassifier(
            max_iter=250, learning_rate=0.05, max_leaf_nodes=15, l2_regularization=1.0,
            min_samples_leaf=80, monotonic_cst=MONOTONIC, random_state=seed,
        )
        self.metrics: Dict[str, float] = {}

    def fit(self, df: pd.DataFrame, holdout: float = 0.2) -> "GamePredictor":
        missing = [c for c in FEATURES + ["home_win"] if c not in df.columns]
        if missing:
            raise ValueError(f"training data missing columns: {missing}")
        df = df.dropna(subset=FEATURES + ["home_win"])
        if len(df) < 200 or df["home_win"].nunique() < 2:
            raise ValueError("need >= 200 labeled rows containing both outcomes to train")
        rng = np.random.default_rng(self.seed)
        mask = rng.random(len(df)) < holdout
        train, test = df[~mask], df[mask]
        self._fit_models(train)
        if len(test) > 50:
            p = self.predict_proba(test[FEATURES])
            y = test["home_win"].to_numpy()
            self.metrics = {
                "brier": brier_score_loss(y, p), "log_loss": log_loss(y, p),
                "auc": roc_auc_score(y, p), "n_train": float(len(train)), "n_test": float(len(test)),
            }
        self._fit_models(df)  # refit on all rows for production use
        return self

    def _fit_models(self, df: pd.DataFrame) -> None:
        X, y = df[FEATURES], df["home_win"].astype(int)
        self.logit.fit(X, y)
        self.gbm.fit(X, y)

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        X = X[FEATURES]
        p_lr = self.logit.predict_proba(X)[:, 1]
        p_gb = self.gbm.predict_proba(X)[:, 1]
        return np.clip(self.logit_weight * p_lr + (1 - self.logit_weight) * p_gb, 0.01, 0.99)

    def contributions(self, x: pd.Series) -> Dict[str, float]:
        """Per-feature log-odds contributions (home-oriented) from the logistic model."""
        scaler: StandardScaler = self.logit.named_steps["scale"]
        coef = self.logit.named_steps["lr"].coef_[0]
        z = (x[FEATURES].to_numpy(dtype=float) - scaler.mean_) / scaler.scale_
        return dict(zip(FEATURES, coef * z))

    def uncertainty_band(self, x: pd.Series, se: Dict[str, float], draws: int = 400,
                         level: float = 0.80, rng: Optional[np.random.Generator] = None) -> Tuple[float, float]:
        """Monte Carlo band on home win probability from stat sample-size error."""
        rng = rng or np.random.default_rng(self.seed)
        base = x[FEATURES].to_numpy(dtype=float)
        noise = rng.normal(size=(draws, len(FEATURES))) * np.array([se.get(f, 0.0) for f in FEATURES])
        sims = self.predict_proba(pd.DataFrame(base + noise, columns=FEATURES))
        tail = (1 - level) / 2 * 100
        lo, hi = np.percentile(sims, [tail, 100 - tail])
        return float(lo), float(hi)


# ----------------------------------------------------------------------------
# Reason generation
# ----------------------------------------------------------------------------


def _strength(contrib: float) -> str:
    a = abs(contrib)
    return "significant" if a >= 0.25 else "solid" if a >= 0.12 else "slight"


def _hand_label(hand: str) -> str:
    return f"{hand}HP" if hand in ("L", "R") else "today's SP"


def explain(g: GameContext, contribs: Dict[str, float], meta: Dict[str, Any],
            winner_home: bool, max_reasons: int = 2) -> str:
    sign = 1 if winner_home else -1
    W, L = (g.home, g.away) if winner_home else (g.away, g.home)
    wsp, lsp = (g.home_sp, g.away_sp) if winner_home else (g.away_sp, g.home_sp)
    w_wrc, l_wrc = (meta["home_wrc"], meta["away_wrc"]) if winner_home else (meta["away_wrc"], meta["home_wrc"])
    w_faces, l_faces = (meta["home_faces"], meta["away_faces"]) if winner_home else (meta["away_faces"], meta["home_faces"])

    def clause(feat: str, c: float) -> str:
        s = _strength(c)
        if feat == "sp_siera_edge":
            return f"{W.abbr} SP {short_name(wsp.name)} holds a {s} SIERA edge ({wsp.siera:.2f} vs {lsp.siera:.2f})"
        if feat == "sp_xfip_edge":
            return f"{W.abbr} SP {short_name(wsp.name)} owns the better xFIP ({wsp.xfip:.2f} vs {lsp.xfip:.2f})"
        if feat == "sp_kbb30_edge":
            trend = wsp.kbb30 - wsp.kbb_season
            return (f"{W.abbr} SP {short_name(wsp.name)} sports a {wsp.kbb30:.1f}% K-BB% over the last 30 days "
                    f"({trend:+.1f} pts vs season; opp. SP {lsp.kbb30:.1f}%)")
        if feat == "platoon_wrc_edge":
            return (f"{W.abbr} has a {w_wrc - l_wrc:+.0f} wRC+ advantage ({w_wrc:.0f} vs {_hand_label(w_faces)}, "
                    f"{L.abbr} {l_wrc:.0f} vs {_hand_label(l_faces)})")
        if feat == "bullpen_siera_edge":
            return (f"a {s} bullpen SIERA advantage for {W.abbr} "
                    f"({W.bullpen_siera:.2f} vs {L.bullpen_siera:.2f})")
        if feat == "team_strength_edge":
            def desc(t: TeamProfile) -> str:
                rec = f"{t.record}, {t.run_diff:+d} RD" if t.record else f"{fmt_wpct(t.pyth_wpct)} Pythag"
                return f"{t.abbr} {rec}"
            return f"{W.abbr} is the stronger club overall ({desc(W)} vs {desc(L)})"
        if feat == "sp_hr_risk_edge":
            w_hr9, l_hr9 = (meta["home_hr9"], meta["away_hr9"]) if winner_home else (meta["away_hr9"], meta["home_hr9"])
            where = f"at {g.venue}" if g.venue else "in this park"
            return (f"{L.abbr} SP {short_name(lsp.name)} is HR-prone {where} "
                    f"(proj. {l_hr9:.2f} HR/9 vs {w_hr9:.2f})")
        if feat == "playoff_leverage":
            if L.playoff_status == "eliminated":
                return f"{W.abbr} is playing for the postseason while {L.abbr} is eliminated"
            return f"{L.abbr} has already clinched and may rest regulars"
        if feat == "venue_split_edge":
            if winner_home:
                return f"{W.abbr} plays {fmt_wpct(W.home_wpct)} ball at home vs {L.abbr} {fmt_wpct(L.away_wpct)} on the road"
            return f"{W.abbr} travels well ({fmt_wpct(W.away_wpct)} road W%) vs {L.abbr} {fmt_wpct(L.home_wpct)} at home"
        return ""

    ranked = sorted(((f, sign * c) for f, c in contribs.items() if f != "park_factor"),
                    key=lambda kv: kv[1], reverse=True)
    parts = [clause(f, c) for f, c in ranked[:max_reasons] if c > 0.03]
    if not parts:
        text = ("Even matchup on the metrics; home-field advantage tips it" if winner_home
                else "Marginal edge spread across several metrics; no dominant factor")
    else:
        text = parts[0][0].upper() + parts[0][1:]
        if len(parts) > 1:
            second = parts[1]
            if not second.startswith(("a ", "an ")) and second[:1].islower():
                second = second[0].lower() + second[1:]
            text += f", paired with {second}"
    flags = [n for n in (g.home_sp.notes + g.away_sp.notes) if n.startswith(("SP TBD", "no MLB"))]
    flags += g.home.notes + g.away.notes + g.notes
    if flags:
        text += f" [note: {'; '.join(dict.fromkeys(flags))}]"
    return text


# ----------------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------------


def tier(prob: float) -> str:
    return "STRONG" if prob >= 0.60 else "LEAN" if prob >= 0.55 else "TOSS-UP"


def playoff_shift(g: GameContext) -> float:
    """Home-oriented log-odds adjustment for playoff status (only when statuses differ)."""
    if g.home.playoff_status == g.away.playoff_status:
        return 0.0
    return PLAYOFF_LOGIT_SHIFT.get(g.home.playoff_status, 0.0) - PLAYOFF_LOGIT_SHIFT.get(g.away.playoff_status, 0.0)


def shift_prob(p: float, shift: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return 1.0 / (1.0 + math.exp(-(math.log(p / (1 - p)) + shift)))


def predict_slate(games: Sequence[GameContext], model: GamePredictor, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for g in games:
        row: Dict[str, Any] = {
            "game_pk": g.game_pk, "start_time": g.start_time, "status": g.status,
            "away": g.away.abbr, "home": g.home.abbr, "game_number": g.game_number,
            "doubleheader": g.doubleheader, "away_sp": g.away_sp.name, "away_sp_hand": g.away_sp.hand,
            "home_sp": g.home_sp.name, "home_sp_hand": g.home_sp.hand, "venue": g.venue,
            "away_record": g.away.record, "home_record": g.home.record,
            "park_factor": g.park_factor, "skip_reason": g.skip_reason,
            "home_score": g.home_score, "away_score": g.away_score, "is_final": g.is_final,
        }
        if g.skip_reason:
            row.update(pick=None, confidence=None, band_low=None, band_high=None,
                       reason=f"{g.skip_reason} - no prediction")
            rows.append(row)
            continue
        try:
            feats, ses, meta = game_features(g)
            x = pd.Series(feats)
            if not np.all(np.isfinite(x.to_numpy(dtype=float))):
                raise ValueError("non-finite features")
            shift = playoff_shift(g)
            p_home = shift_prob(float(model.predict_proba(x.to_frame().T)[0]), shift)
            lo, hi = (shift_prob(v, shift) for v in model.uncertainty_band(x, ses, rng=rng))
            winner_home = p_home >= 0.5
            conf = p_home if winner_home else 1 - p_home
            band = (lo, hi) if winner_home else (1 - hi, 1 - lo)
            row.update(feats)
            row.update(
                p_home=p_home, pick=g.home.abbr if winner_home else g.away.abbr,
                confidence=conf, band_low=band[0], band_high=band[1], tier=tier(conf),
                playoff_shift=shift, home_status=g.home.playoff_status, away_status=g.away.playoff_status,
                reason=explain(g, {**model.contributions(x), "playoff_leverage": shift}, meta, winner_home),
            )
        except Exception as exc:
            LOG.warning("Prediction failed for game %s: %s", g.game_pk, exc)
            row.update(pick=None, confidence=None, band_low=None, band_high=None,
                       reason=f"Insufficient data to model ({exc})")
        rows.append(row)
    return pd.DataFrame(rows)


# ----------------------------------------------------------------------------
# Terminal output
# ----------------------------------------------------------------------------


def _fmt_time(ts: Optional[datetime]) -> str:
    if ts is None:
        return "TBD"
    return ts.astimezone(ET).strftime("%I:%M %p").lstrip("0") + " ET"


def _cell_lines(text: str, width: int) -> List[str]:
    lines: List[str] = []
    for part in str(text).split("\n"):
        lines.extend(textwrap.wrap(part, width) or [""])
    return lines


def render_table(df: pd.DataFrame, width: Optional[int] = None) -> str:
    width = width or max(shutil.get_terminal_size((160, 40)).columns, 100)
    cols = [("#", 3), ("Time", 12), ("Matchup", 14), ("Probable SPs", 24),
            ("Pick", 8), ("Confidence", 17), ("Reason Why", 0)]
    fixed = sum(w for _, w in cols) + 3 * (len(cols) - 1) + 4
    reason_w = max(width - fixed, 36)
    cols[-1] = ("Reason Why", reason_w)

    def sp(name: str, hand: str) -> str:
        return f"{short_name(name)} ({hand})" if name != "TBD" else "TBD"

    body_rows = []
    for i, r in enumerate(df.itertuples(index=False), start=1):
        dh = f" G{int(r.game_number)}" if r.doubleheader else ""
        matchup = f"{r.away} @ {r.home}{dh}"
        if _present(getattr(r, "away_record", None)) and r.away_record and r.home_record:
            matchup += f"\n{r.away_record} @ {r.home_record}"
        when = _fmt_time(r.start_time if _present(r.start_time) else None)
        scored = bool(r.is_final) and _present(r.home_score) and _present(r.away_score)
        if scored:
            when = f"FINAL\n{r.away} {int(r.away_score)}-{int(r.home_score)} {r.home}"
        elif _present(r.skip_reason):
            when = f"{when}\n{str(r.status).upper()}"
        elif _present(r.status) and r.status not in ("Scheduled", "Pre-Game", "Warmup"):
            when = f"{when}\n{r.status}"
        sps = f"{r.away}: {sp(r.away_sp, r.away_sp_hand)}\n{r.home}: {sp(r.home_sp, r.home_sp_hand)}"
        if not _present(r.pick):
            pick, conf = "--", "--"
        else:
            pick = f"{r.pick}\n{r.tier}"
            if scored and r.home_score != r.away_score:
                actual = r.home if r.home_score > r.away_score else r.away
                pick += "\n[HIT]" if actual == r.pick else "\n[MISS]"
            conf = f"{r.confidence * 100:.1f}% Confidence\n({r.band_low * 100:.1f}-{r.band_high * 100:.1f}%)"
        body_rows.append([str(i), when, matchup, sps, pick, conf, r.reason])

    def fmt_row(cells: List[str]) -> List[str]:
        wrapped = [_cell_lines(c, w) for c, (_, w) in zip(cells, cols)]
        height = max(len(w) for w in wrapped)
        out = []
        for li in range(height):
            parts = [(w[li] if li < len(w) else "").ljust(cw) for w, (_, cw) in zip(wrapped, cols)]
            out.append("| " + " | ".join(parts) + " |")
        return out

    sep = "+" + "+".join("-" * (w + 2) for _, w in cols) + "+"
    lines = [sep, *fmt_row([h for h, _ in cols]), sep.replace("-", "=")]
    for row in body_rows:
        lines.extend(fmt_row(row))
        lines.append(sep)
    return "\n".join(lines)


def print_report(df: pd.DataFrame, game_date: date, source: str, model: GamePredictor, train_desc: str) -> None:
    print()
    print(f"MLB GAME PREDICTOR  |  Slate: {game_date:%A, %B %d, %Y}  |  Data: {source}")
    m = model.metrics
    if m:
        print(f"Model: LogReg + monotonic GBM ensemble  |  Trained on {train_desc}  |  "
              f"holdout Brier {m['brier']:.4f}, log-loss {m['log_loss']:.4f}, AUC {m['auc']:.3f}")
    if df.empty:
        print("\nNo MLB games scheduled for this date.")
        return
    print(render_table(df))
    active = df[df["pick"].notna()]
    skipped = len(df) - len(active)
    print(f"{len(active)} game(s) predicted" + (f", {skipped} skipped (postponed/cancelled/no data)" if skipped else ""))
    graded = active[active["is_final"] & active["home_score"].notna()]
    if len(graded):
        hits = sum((r.home if r.home_score > r.away_score else r.away) == r.pick
                   for r in graded.itertuples() if r.home_score != r.away_score)
        print(f"Completed games graded: {hits}/{len(graded)} correct")
    print("Confidence = ensemble win probability for the pick; (x-y%) = 80% band from stat sample-size "
          "uncertainty.\nIncludes a small playoff-status log-odds shift (alive vs eliminated/clinched). Tiers: STRONG >= 60%, LEAN 55-60%, TOSS-UP < 55%. For research/entertainment only.")


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------


def load_slate(source: str, game_date: date, seed: int) -> Tuple[List[GameContext], str]:
    if source in ("auto", "api"):
        try:
            games = MLBStatsAPIProvider().get_slate(game_date)
            return games, "MLB Stats API (live)"
        except DataUnavailableError as exc:
            if source == "api":
                raise
            LOG.warning("%s; falling back to SIMULATED slate", exc)
    return SimulatedProvider(seed=seed).get_slate(game_date), "SIMULATED (synthetic teams/stats)"


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sabermetric MLB game-winner predictor")
    p.add_argument("--date", type=lambda s: datetime.strptime(s, "%Y-%m-%d").date(),
                   default=datetime.now(ET).date(), help="slate date YYYY-MM-DD (default: today, ET)")
    p.add_argument("--source", choices=("auto", "api", "simulate"), default="auto",
                   help="auto = live API with simulated fallback (default)")
    p.add_argument("--train-csv", help=f"historical rows with columns {FEATURES + ['home_win']}")
    p.add_argument("--n-train", type=int, default=30000, help="baseline simulated training games")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--csv-out", help="also write predictions to this CSV path")
    p.add_argument("--width", type=int, help="table width (default: terminal width)")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(levelname)s %(name)s: %(message)s")
    if not args.verbose:
        logging.getLogger("urllib3").setLevel(logging.ERROR)

    if args.train_csv:
        try:
            train_df = pd.read_csv(args.train_csv)
        except (OSError, pd.errors.ParserError) as exc:
            LOG.error("Could not read training CSV: %s", exc)
            return 2
        train_desc = f"{len(train_df):,} historical games ({args.train_csv})"
    else:
        train_df = generate_baseline_training_set(args.n_train, seed=args.seed)
        train_desc = f"{len(train_df):,}-game structural baseline"

    try:
        model = GamePredictor(seed=args.seed).fit(train_df)
    except ValueError as exc:
        LOG.error("Model training failed: %s", exc)
        return 2

    try:
        games, source = load_slate(args.source, args.date, args.seed)
    except DataUnavailableError as exc:
        LOG.error("%s", exc)
        return 1

    preds = predict_slate(games, model, seed=args.seed)
    print_report(preds, args.date, source, model, train_desc)

    if args.csv_out and not preds.empty:
        preds.to_csv(args.csv_out, index=False)
        print(f"Predictions written to {args.csv_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

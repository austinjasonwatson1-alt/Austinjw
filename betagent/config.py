"""Load config.yaml over built-in defaults, load .env secrets, and validate thresholds."""
from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

ROOT = Path(__file__).resolve().parent.parent

DEFAULTS: Dict[str, Any] = {
    "timezone": "America/New_York",
    "leagues": ["NFL", "NCAAF", "MLB", "NHL"],
    "bet_types": ["moneyline", "spread", "total"],
    "bankroll": {"unit_dollars": 100.0, "bankroll_units": 20.0},
    "staking": {
        "kelly_fraction": 0.25,
        "max_units_per_bet": 2.0,
        "round_to_units": 0.25,
        "max_daily_units": None,
        "max_bets_per_day": None,
    },
    "selection": {"min_edge": 0.03, "min_picks": 2, "lean_stake_units": 0.25},
    "parlays": {"enabled": True, "max_legs": 3, "max_parlays": 2, "max_units": 1.0},
    "pricing": {"devig_method": "multiplicative", "book_weights": {"default": 1.0}},
    "sources": {
        "espn": {"enabled": True},
        "polymarket": {"enabled": True, "min_liquidity": 1000, "max_spread": 0.05, "fee_per_share": 0.0},
        "odds_api": {"enabled": "auto", "regions": "us", "bookmakers": []},
    },
    "research": {"dir": "data/research", "max_games": 30, "max_deviation": 0.12, "complement_two_way": True},
    "cache": {"dir": "data/cache", "free_ttl_minutes": 15, "paid_ttl_minutes": None},
}


class ConfigError(ValueError):
    pass


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_env(path: Optional[Path] = None) -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:  # dotenv is optional at runtime; env vars still work
        return
    load_dotenv(path or ROOT / ".env", override=False)


def load_config(path: Optional[str | Path] = None) -> Dict[str, Any]:
    load_env()
    cfg_path = Path(path) if path else ROOT / "config.yaml"
    user: Dict[str, Any] = {}
    if cfg_path.exists():
        with open(cfg_path) as fh:
            user = yaml.safe_load(fh) or {}
    elif path:
        raise ConfigError(f"Config file not found: {cfg_path}")
    cfg = _deep_merge(DEFAULTS, user)
    validate(cfg)
    return cfg


def validate(cfg: Dict[str, Any]) -> None:
    from .leagues import LEAGUES
    from .oddsmath import DEVIG_METHODS

    def positive(section: str, key: str, allow_none: bool = False) -> None:
        v = cfg[section][key]
        if v is None and allow_none:
            return
        if not isinstance(v, (int, float)) or v <= 0:
            raise ConfigError(f"{section}.{key} must be a positive number, got {v!r}")

    unknown = [lg for lg in cfg["leagues"] if lg.upper() not in LEAGUES]
    if unknown:
        raise ConfigError(f"Unknown leagues {unknown}; supported: {sorted(LEAGUES)}")
    cfg["leagues"] = [lg.upper() for lg in cfg["leagues"]]
    bad_types = set(cfg["bet_types"]) - {"moneyline", "spread", "total"}
    if bad_types:
        raise ConfigError(f"Unknown bet_types {sorted(bad_types)}")

    positive("bankroll", "unit_dollars")
    positive("bankroll", "bankroll_units")
    kf = cfg["staking"]["kelly_fraction"]
    if not isinstance(kf, (int, float)) or not 0 < kf <= 1:
        raise ConfigError(f"staking.kelly_fraction must be in (0, 1], got {kf!r}")
    positive("staking", "max_units_per_bet")
    positive("staking", "max_daily_units", allow_none=True)
    positive("staking", "max_bets_per_day", allow_none=True)
    me = cfg["selection"]["min_edge"]
    if not isinstance(me, (int, float)) or not 0 <= me < 1:
        raise ConfigError(f"selection.min_edge must be in [0, 1), got {me!r}")
    if cfg["pricing"]["devig_method"] not in DEVIG_METHODS:
        raise ConfigError(f"pricing.devig_method must be one of {DEVIG_METHODS}")


def odds_api_key() -> Optional[str]:
    return os.environ.get("ODDS_API_KEY") or None


def anthropic_api_key() -> Optional[str]:
    return os.environ.get("ANTHROPIC_API_KEY") or None


def resolve_path(p: str | Path) -> Path:
    p = Path(p)
    return p if p.is_absolute() else ROOT / p

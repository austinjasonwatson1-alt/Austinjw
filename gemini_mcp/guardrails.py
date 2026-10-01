"""Every order limit check lives here, enforced in code rather than in prompts.

Flow:
  propose() -> validates, sizes buys (Kelly) when given my_probability,
               returns a preview and a one-time token. Places nothing.
  confirm() -> burns the token first, re-runs every check with fresh data,
               records spend, then either records a paper order (dry run)
               or calls the trading client.
  cancel()  -> kill-switch aware; dry run only logs.

All checks fail closed. If data is missing, malformed or can't be fetched,
the order is rejected. The circuit breakers create the KILL file themselves
when they trip.

Pure, separately tested helpers: size_position(), check_book(),
evaluate_breakers(), order_cost().
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import secrets
import threading
import time
import warnings
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timezone
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Iterator

import yaml

TOKEN_TTL_SECONDS = 300
# Live sells confirmed this recently stay reserved against the holding even if Gemini's positions/open orders
# haven't reflected them yet (read from audit.log, so the reservation is shared by every server process).
RECENT_SELL_WINDOW_S = 120
ALLOWED_OUTCOMES = ("yes", "no")
ALLOWED_SIDES = ("buy", "sell")
_SYMBOL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,120}$")
_TICKER_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
_MODEL_RE = re.compile(r"^claude-[a-z0-9.-]{1,60}$")
_CATEGORY_RE = re.compile(r"^[A-Za-z0-9_ -]{1,60}$")
_ACTIVE_ORDERS_PAGE = 100
_ZERO = Decimal(0)
_ONE = Decimal(1)


class Rejected(Exception):
    """An order or action refused by a guardrail. The message is the reason."""

    def __init__(self, reason: str, details: dict[str, Any] | None = None):
        super().__init__(reason)
        self.details = details or {}


class ConfigError(Rejected):
    pass


def _fmt(d: Decimal | None) -> str | None:
    return None if d is None else format(d, "f")


# --------------------------------------------------------------------------- config


@dataclass(frozen=True)
class Config:
    # Hard limits (absolute dollars).
    max_order_usd: Decimal = Decimal("10")
    max_daily_spend_usd: Decimal = Decimal("25")
    max_open_orders: int = 3
    max_trades_per_day: int = 5  # buys only
    max_exits_per_day: int = 10  # sells of held quantity; exempt from max_trades_per_day
    allowed_event_tickers: tuple[str, ...] = ()
    # Conviction sizing. Fractions: 0.08 means 8%.
    estimate_weight: Decimal = Decimal("0.7")
    kelly_multiplier: Decimal = Decimal("0.25")
    min_edge: Decimal = Decimal("0.05")
    fee_per_contract: Decimal = Decimal("0.02")
    # Set true only after checking fee_per_contract against Gemini's fee schedule. preflight.py fails until then.
    fee_confirmed: bool = False
    max_order_pct_of_balance: Decimal = Decimal("0.08")
    max_market_pct_of_balance: Decimal = Decimal("0.15")
    max_daily_spend_pct: Decimal = Decimal("0.25")
    # Circuit breakers.
    max_drawdown_pct: Decimal = Decimal("0.20")
    max_daily_loss_pct: Decimal = Decimal("0.08")
    # Absolute floor: equity below equity_floor_pct x starting balance trips the breaker. Deleting
    # KILL never moves the floor. 0 disables it.
    equity_floor_pct: Decimal = Decimal("0.60")
    # Live starting balance in USD (formerly initial_deposit_usd). Unset: the first positive equity the server
    # observed (kept forever). DRY_RUN always uses the paper bankroll.
    starting_balance_usd: Decimal | None = None
    # Learning budget: when set, the floor is starting balance - learning_budget_usd, never below
    # LEARNING_FLOOR_MIN_PCT (40%) of the starting balance. It replaces equity_floor_pct (even when that is 0).
    learning_budget_usd: Decimal | None = None
    # Name of the profile applied from config.yaml's "profiles" section (None = base keys only).
    profile: str | None = None
    # Optional per-category exposure caps as a share of equity, e.g. {default: 0.30, sports: 0.20}.
    # Empty = no category caps. Categories come from Gemini's event "category" field.
    category_exposure_caps: dict[str, Decimal] = field(default_factory=dict)
    # Order book quality (runner entry filter).
    max_spread: Decimal = Decimal("0.04")
    min_depth_multiple: Decimal = Decimal("1")
    # Runner.
    exit_hours_before_expiry: Decimal = Decimal("6")
    # Entry window: the runner only researches/enters contracts expiring between min_hours_to_expiry hours and
    # max_days_to_expiry days from now (inclusive). Held positions are reviewed whatever their expiry.
    max_days_to_expiry: Decimal = Decimal("7")
    # Must be >= exit_hours_before_expiry, so an entry is never sold on the next run just for being near expiry.
    min_hours_to_expiry: Decimal = Decimal("12")
    clearly_winning_price: Decimal = Decimal("0.85")
    paper_bankroll_usd: Decimal = Decimal("100")
    runner_auto_confirm_live: bool = False
    research_model: str = "claude-opus-5-5"
    research_max_searches: int = 5
    max_research_per_run: int = 5  # up to 20, but above 5 both research cost caps must be set
    min_sources: int = 2
    # Research cost caps in USD, estimated from token and search counts at the prices below. None = no cap.
    # The day cap counts every research call today (UTC) in audit.log, DRY_RUN and live alike.
    max_research_cost_usd_per_run: Decimal | None = None
    max_research_cost_usd_per_day: Decimal | None = None
    # Prices for the estimate: Anthropic list prices for claude-opus-5-5 ($4 / $20 per million input / output
    # tokens) and web search ($10 per 1,000 searches). Update them if you change research_model.
    research_input_usd_per_mtok: Decimal = Decimal("4")
    research_output_usd_per_mtok: Decimal = Decimal("20")
    research_usd_per_search: Decimal = Decimal("0.01")


# name -> (kind, low, high). Bounds are inclusive; "frac+" excludes 0.
_SPEC: dict[str, tuple] = {
    "max_order_usd": ("dec", 0, None),
    "max_daily_spend_usd": ("dec", 0, None),
    "max_open_orders": ("int", 0, _ACTIVE_ORDERS_PAGE),  # only one page of open orders is read
    "max_trades_per_day": ("int", 0, None),
    "max_exits_per_day": ("int", 0, None),
    "allowed_event_tickers": ("tickers",),
    "estimate_weight": ("dec", 0, 1),
    "kelly_multiplier": ("dec", 0, 1),
    "min_edge": ("dec", 0, 1),
    "fee_per_contract": ("dec", 0, 1),
    "fee_confirmed": ("bool",),
    "max_order_pct_of_balance": ("dec", 0, 1),
    "max_market_pct_of_balance": ("dec", 0, 1),
    "max_daily_spend_pct": ("dec", 0, 1),
    "max_drawdown_pct": ("frac+",),
    "max_daily_loss_pct": ("frac+",),
    "equity_floor_pct": ("dec", 0, 1),
    "starting_balance_usd": ("opt_dec",),
    "learning_budget_usd": ("opt_dec",),
    "profile": ("profile",),
    "category_exposure_caps": ("caps",),
    "max_spread": ("dec", 0, 1),
    "min_depth_multiple": ("dec", 0, None),
    "exit_hours_before_expiry": ("dec", 0, None),
    "max_days_to_expiry": ("dec+",),
    "min_hours_to_expiry": ("dec", 0, None),
    "clearly_winning_price": ("dec", 0, 1),
    "paper_bankroll_usd": ("dec", 0, None),
    "runner_auto_confirm_live": ("bool",),
    "research_model": ("model",),
    "research_max_searches": ("int", 1, 50),
    "max_research_per_run": ("int", 0, 20),
    "min_sources": ("int", 0, None),
    "max_research_cost_usd_per_run": ("opt_dec",),
    "max_research_cost_usd_per_day": ("opt_dec",),
    "research_input_usd_per_mtok": ("dec", 0, None),
    "research_output_usd_per_mtok": ("dec", 0, None),
    "research_usd_per_search": ("dec", 0, None),
}
assert set(_SPEC) == {f.name for f in fields(Config)}


def _cfg_decimal(name: str, value: Any) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise ConfigError(f"config {name} must be a number")
    try:
        d = Decimal(str(value))
    except InvalidOperation:
        raise ConfigError(f"config {name} must be a number")
    if not d.is_finite():
        raise ConfigError(f"config {name} must be finite")
    return d


def _cfg_value(name: str, value: Any) -> Any:
    kind = _SPEC[name][0]
    if kind == "profile":
        if value is not None and (not isinstance(value, str) or not value):
            raise ConfigError(f"config {name} must be a profile name (or null)")
        return value
    if kind == "opt_dec":
        if value is None:
            return None
        d = _cfg_decimal(name, value)
        if d <= 0:
            raise ConfigError(f"config {name} must be a positive number of dollars (or omitted/null)")
        return d
    if kind == "caps":
        value = {} if value is None else value
        if not isinstance(value, dict):
            raise ConfigError(f"config {name} must be a mapping of category -> fraction, e.g. {{sports: 0.2}}")
        caps = {}
        for k, v in value.items():
            if not isinstance(k, str) or not _CATEGORY_RE.match(k):
                raise ConfigError(f"config {name} has a bad category name {k!r}")
            d = _cfg_decimal(f"{name}.{k}", v)
            if not (_ZERO <= d <= _ONE):
                raise ConfigError(f"config {name}.{k} must be between 0 and 1 (0.20 = 20%)")
            caps[k.lower()] = d
        return caps
    if kind == "tickers":
        value = [] if value is None else value
        if not isinstance(value, list) or not all(isinstance(t, str) and _TICKER_RE.match(t) for t in value):
            raise ConfigError("config allowed_event_tickers must be a list of event ticker strings")
        return tuple(value)
    if kind == "bool":
        if not isinstance(value, bool):
            raise ConfigError(f"config {name} must be true or false")
        return value
    if kind == "model":
        if not isinstance(value, str) or not _MODEL_RE.match(value):
            raise ConfigError(f"config {name} must be a Claude model id")
        return value
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ConfigError(f"config {name} must be an integer")
        lo, hi = _SPEC[name][1], _SPEC[name][2]
        if value < lo or (hi is not None and value > hi):
            raise ConfigError(f"config {name} must be between {lo} and {hi if hi is not None else 'any'}")
        return value
    d = _cfg_decimal(name, value)
    if kind == "dec+":
        if d <= _ZERO:
            raise ConfigError(f"config {name} must be greater than 0")
        return d
    if kind == "frac+":
        if not (_ZERO < d <= _ONE):
            raise ConfigError(f"config {name} must be greater than 0 and at most 1 (0.20 = 20%)")
        return d
    lo, hi = _SPEC[name][1], _SPEC[name][2]
    if d < lo or (hi is not None and d > hi):
        raise ConfigError(f"config {name} must be between {lo} and {hi if hi is not None else 'any'}")
    return d


_RENAMED = {"initial_deposit_usd": "starting_balance_usd"}  # old key -> new key, still read with a warning
_REMOVED = {  # old key -> why it's gone (a config that still sets it is refused, so nobody relies on it silently)
    "allow_above_micro_live": "removed: live limits above the micro_live ceilings are unlocked only by 20 settled "
                              "live trades in audit.log, and auto-confirm by 15 hand-confirmed ones (preflight.py; "
                              "RUNBOOK.md section 9). Delete the key.",
}


def load_config(path: Path) -> Config:
    """Read config.yaml. Missing file, unknown keys or bad values are errors, not silent defaults."""
    if not path.is_file():
        raise ConfigError(f"config file not found: {path}")
    try:
        raw = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as e:
        raise ConfigError(f"config file is not valid YAML: {e}")
    if not isinstance(raw, dict):
        raise ConfigError("config file must be a YAML mapping")
    for old, new in _RENAMED.items():
        if old in raw:
            if new in raw:
                raise ConfigError(f"config sets both {old} and {new}; remove {old}")
            warnings.warn(f"config key {old} is deprecated; rename it to {new}", DeprecationWarning, stacklevel=2)
            raw[new] = raw.pop(old)
    for key, why in _REMOVED.items():
        nested = [n for n, o in (raw.get("profiles") or {}).items() if isinstance(o, dict) and key in o] \
            if isinstance(raw.get("profiles"), dict) else []
        if key in raw or nested:
            raise ConfigError(f"config {key} was {why}")
    profiles = raw.pop("profiles", None)
    profiles = {} if profiles is None else profiles
    if not isinstance(profiles, dict):
        raise ConfigError("config profiles must be a mapping of profile name -> config keys")
    checked: dict[str, dict[str, Any]] = {}
    for pname, over in profiles.items():
        if not isinstance(pname, str) or not isinstance(over, dict):
            raise ConfigError(f"config profiles.{pname} must be a mapping of config keys")
        if "profile" in over or "profiles" in over:
            raise ConfigError(f"config profiles.{pname} can't set profile or profiles (no nesting)")
        bad = set(over) - set(_SPEC)
        if bad:
            raise ConfigError(f"unknown config keys in profiles.{pname} (typo?): {sorted(bad)}")
        checked[pname] = {k: _cfg_value(k, v) for k, v in over.items()}  # validated even when not selected
    unknown = set(raw) - set(_SPEC)
    if unknown:
        raise ConfigError(f"unknown config keys (typo?): {sorted(unknown)}")
    values = {name: _cfg_value(name, value) for name, value in raw.items()}
    chosen = values.get("profile")
    if chosen is not None:
        if chosen not in checked:
            raise ConfigError(f"config profile {chosen!r} is not defined under profiles")
        values.update(checked[chosen])  # the profile's keys win over the base keys
    return _cross_check(Config(**values))


def _cross_check(c: Config) -> Config:
    """Rules that involve more than one key."""
    if c.min_hours_to_expiry > c.max_days_to_expiry * 24:
        raise ConfigError(f"config expiry window is empty: min_hours_to_expiry {c.min_hours_to_expiry} is more than "
                          f"max_days_to_expiry {c.max_days_to_expiry} x 24 h")
    if c.min_hours_to_expiry < c.exit_hours_before_expiry:
        raise ConfigError(f"config min_hours_to_expiry {c.min_hours_to_expiry} is less than exit_hours_before_expiry "
                          f"{c.exit_hours_before_expiry}: a contract entered at the edge of the entry window would "
                          "be sold on the next run just for being near expiry")
    if c.max_research_per_run > RESEARCH_UNCAPPED_MAX:
        missing = [k for k in ("max_research_cost_usd_per_run", "max_research_cost_usd_per_day")
                   if getattr(c, k) is None]
        if missing:
            raise ConfigError(f"config max_research_per_run is {c.max_research_per_run}: above {RESEARCH_UNCAPPED_MAX} "
                              "it needs both max_research_cost_usd_per_run and max_research_cost_usd_per_day set "
                              f"(missing: {', '.join(missing)})")
    return c


LEARNING_FLOOR_MIN_PCT = Decimal("0.4")  # the learning-budget floor never goes below 40% of the starting balance
RESEARCH_UNCAPPED_MAX = 5  # max_research_per_run above this needs both research cost caps


def parse_dry_run(value: str | None) -> bool:
    """DRY_RUN is on unless set to exactly 'false'. Unset or 'true' means dry run; anything else is an error."""
    if value is None or value == "" or value == "true":
        return True
    if value == "false":
        return False
    raise ConfigError(f"DRY_RUN must be 'true' or 'false', got {value!r}")


def parse_env(value: str | None) -> str:
    """GEMINI_ENV defaults to sandbox; production must be named explicitly."""
    if value is None or value == "":
        return "sandbox"
    if value in ("sandbox", "production"):
        return value
    raise ConfigError(f"GEMINI_ENV must be 'sandbox' or 'production', got {value!r}")


# --------------------------------------------------------------------------- files


@contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """Cross-process exclusive lock on <path>.lock (server and runner share state files)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(path.name + ".lock"), "a") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        yield


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str))
    os.replace(tmp, path)


def _read_json(path: Path, default: Any, what: str) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except (ValueError, OSError) as e:
        raise Rejected(f"{what} {path} is unreadable ({e}); refusing to trade")


# --------------------------------------------------------------------------- audit log


class AuditLog:
    """Append-only JSON-lines log, safe for the server and runner to share.

    Known secret values are redacted before writing.
    """

    def __init__(self, path: Path, clock: Callable[[], float] = time.time, redact: list[str] | None = None):
        self.path = path
        self._clock = clock
        self._redact = [s for s in (redact or []) if s]
        self._lock = threading.Lock()

    def write(self, event: str, **fields: Any) -> None:
        ts = datetime.fromtimestamp(self._clock(), tz=timezone.utc).isoformat(timespec="milliseconds")
        line = json.dumps({"ts": ts, "event": event, **fields}, default=str, sort_keys=False)
        for s in self._redact:
            line = line.replace(s, "[REDACTED]")
        with self._lock, open(self.path, "a", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())


# --------------------------------------------------------------------------- daily spend


class SpendLedger:
    """Persisted per-UTC-day spend on buys, count of buys ("trades") and count of sells ("exits"), keyed by mode
    so dry runs never use up the live budget.

    All are recorded when an order is confirmed and never refunded, even on
    cancel or a failed placement. Version 1 files (no "exits" section) are
    upgraded on load; a version 2 file without one is refused.
    """

    SECTIONS = ("spend", "trades", "exits")

    def __init__(self, path: Path, mode_key: str):
        self.path = path
        self.mode_key = mode_key
        self._lock = threading.Lock()

    def _load(self) -> dict[str, Any]:
        data = _read_json(self.path, {"version": 2, "spend": {}, "trades": {}, "exits": {}}, "daily spend ledger")
        if not isinstance(data, dict) or not isinstance(data.get("spend"), dict) \
                or not isinstance(data.setdefault("trades", {}), dict):
            raise Rejected(f"daily spend ledger {self.path} has a bad shape; refusing to trade")
        if "exits" not in data:
            if data.get("version", 1) != 1:
                raise Rejected(f"daily spend ledger {self.path} has no exits section; refusing to trade")
            # Written before exits were counted separately: every mode it knows starts with no exits recorded.
            # (Today's audit.log still sets a floor under the count; see _check_ledger_against_audit.)
            data["exits"] = {mode: {} for mode in data["trades"]}
        if not isinstance(data["exits"], dict):
            raise Rejected(f"daily spend ledger {self.path} has a bad shape; refusing to trade")
        data["version"] = 2
        return data

    def initialized(self) -> bool:
        """True if the file exists and has entries (possibly empty) for this mode."""
        with self._lock, file_lock(self.path):
            if not self.path.exists():
                return False
            data = self._load()
            return all(self.mode_key in data[s] for s in self.SECTIONS)

    def initialize(self) -> None:
        with self._lock, file_lock(self.path):
            data = self._load()
            for section in self.SECTIONS:
                data[section].setdefault(self.mode_key, {})
            _atomic_write_json(self.path, data)

    def _count_on(self, section: str, day: str) -> int:
        with self._lock, file_lock(self.path):
            n = self._load()[section].get(self.mode_key, {}).get(day, 0)
        if isinstance(n, bool) or not isinstance(n, int) or n < 0:
            raise Rejected(f"daily spend ledger has a malformed {section} count; refusing to trade")
        return n

    def trades_on(self, day: str) -> int:
        """Buys placed today."""
        return self._count_on("trades", day)

    def exits_on(self, day: str) -> int:
        """Sells (exits) placed today."""
        return self._count_on("exits", day)

    def spent_on(self, day: str) -> Decimal:
        with self._lock, file_lock(self.path):
            raw = self._load()["spend"].get(self.mode_key, {}).get(day, "0")
        try:
            d = Decimal(raw) if isinstance(raw, str) else None
        except InvalidOperation:
            d = None
        if d is None or not d.is_finite() or d < 0:
            raise Rejected(f"daily spend ledger has a malformed amount {_clip(str(raw))!r} for {day}; refusing to trade")
        return d

    def has_history(self) -> bool:
        """True if any buy was ever recorded for this mode."""
        with self._lock, file_lock(self.path):
            data = self._load()
            return any(data[s].get(self.mode_key) for s in self.SECTIONS)

    def record_trade(self, day: str, amount: Decimal, side: str = "buy") -> tuple[Decimal, int]:
        """Add one placed order: a buy adds its spend and one trade; a sell adds one exit (no spend).
        Returns (spend today, that side's count today)."""
        with self._lock, file_lock(self.path):
            data = self._load()
            days = data["spend"].setdefault(self.mode_key, {})
            total = Decimal(days.get(day, "0")) + (amount if side == "buy" else _ZERO)
            days[day] = format(total, "f")
            counts = data["trades" if side == "buy" else "exits"].setdefault(self.mode_key, {})
            counts[day] = int(counts.get(day, 0)) + 1
            for section in (days, counts):
                for old in sorted(section)[:-30]:
                    del section[old]
            _atomic_write_json(self.path, data)
            return total, counts[day]


# --------------------------------------------------------------------------- paper ledger


class PaperLedger:
    """Paper positions and fills for DRY_RUN, plus research records for every trade.

    Fills and positions are written only by the server (at dry-run confirm),
    so the runner can't invent holdings. The runner adds research records.
    A paper buy fills only if its limit is at or above the current ask for
    that outcome, and fills at the limit price. A paper sell fills only if
    its limit is at or below the current bid. Fees use fee_per_contract.
    """

    def __init__(self, path: Path, bankroll: Decimal, clock: Callable[[], float] = time.time):
        self.path = path
        self.bankroll = bankroll
        self._clock = clock
        self._lock = threading.Lock()

    def _fresh(self) -> dict[str, Any]:
        return {"version": 1, "bankroll_usd": _fmt(self.bankroll), "cash_usd": _fmt(self.bankroll),
                "positions": {}, "orders": [], "research": {}}

    def _load(self) -> dict[str, Any]:
        data = _read_json(self.path, None, "paper ledger") or self._fresh()
        if not isinstance(data, dict) or not all(
            isinstance(data.get(k), t) for k, t in (("positions", dict), ("orders", list), ("research", dict))
        ):
            raise Rejected(f"paper ledger {self.path} has a bad shape; refusing to trade")
        return data

    def snapshot(self) -> dict[str, Any]:
        with self._lock, file_lock(self.path):
            return self._load()

    def cash(self) -> Decimal:
        try:
            return Decimal(self.snapshot()["cash_usd"])
        except (KeyError, InvalidOperation):
            raise Rejected("paper ledger cash is malformed; refusing to trade")

    def positions(self) -> list[dict[str, Any]]:
        return list(self.snapshot()["positions"].values())

    def held(self, symbol: str, outcome: str) -> Decimal:
        pos = self.snapshot()["positions"].get(f"{symbol}|{outcome}")
        return Decimal(pos["quantity"]) if pos else _ZERO

    def record_order(
        self, *, symbol: str, outcome: str, side: str, quantity: Decimal, price: Decimal,
        fee: Decimal, event_ticker: str, filled: bool,
    ) -> str:
        with self._lock, file_lock(self.path):
            data = self._load()
            oid = f"paper-{int(self._clock() * 1000)}-{secrets.token_hex(3)}"
            key = f"{symbol}|{outcome}"
            if filled:
                cash = Decimal(data["cash_usd"])
                pos = data["positions"].get(key) or {
                    "symbol": symbol, "outcome": outcome, "event_ticker": event_ticker,
                    "quantity": "0", "cost_basis": "0",
                }
                qty, basis = Decimal(pos["quantity"]), Decimal(pos["cost_basis"])
                if side == "buy":
                    cash -= quantity * (price + fee)
                    qty, basis = qty + quantity, basis + quantity * (price + fee)
                else:
                    if quantity > qty:
                        raise Rejected("paper sell exceeds paper holdings")
                    cash += quantity * (price - fee)
                    basis = basis * (qty - quantity) / qty if qty else _ZERO
                    qty -= quantity
                if qty > 0:
                    data["positions"][key] = {**pos, "quantity": _fmt(qty), "cost_basis": _fmt(basis)}
                else:
                    data["positions"].pop(key, None)
                data["cash_usd"] = _fmt(cash)
            data["orders"].append({
                "paper_order_id": oid,
                "ts": datetime.fromtimestamp(self._clock(), tz=timezone.utc).isoformat(timespec="seconds"),
                "symbol": symbol, "outcome": outcome, "side": side, "quantity": _fmt(quantity),
                "price": _fmt(price), "fee": _fmt(fee), "event_ticker": event_ticker, "filled": filled,
            })
            _atomic_write_json(self.path, data)
            return oid

    def attach_research(self, order_ref: str, record: dict[str, Any]) -> None:
        with self._lock, file_lock(self.path):
            data = self._load()
            data["research"][order_ref] = record
            _atomic_write_json(self.path, data)


# --------------------------------------------------------------------------- circuit-breaker state


class RiskState:
    """Peak equity, start-of-day equity and trip record, per mode, in state/risk_state.json."""

    def __init__(self, path: Path, mode_key: str):
        self.path = path
        self.mode_key = mode_key

    def _entry(self, data: Any) -> dict[str, Any]:
        if not isinstance(data, dict):
            raise Rejected("risk state has a bad shape; refusing to trade")
        st = data.get(self.mode_key) or {}
        if not isinstance(st, dict):
            raise Rejected(f"risk state for {self.mode_key} has a bad shape; refusing to trade")
        for k in ("peak", "day_start", "initial_equity"):
            if st.get(k) is None:
                continue
            try:
                ok = Decimal(str(st[k])).is_finite()
            except InvalidOperation:
                ok = False
            if not ok:
                raise Rejected(f"risk state {k} for {self.mode_key} is malformed ({st[k]!r}); refusing to trade")
        return dict(st)

    def read(self) -> dict[str, Any]:
        return self._entry(_read_json(self.path, {}, "risk state"))

    def update(self, fn: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]:
        with file_lock(self.path):
            data = _read_json(self.path, {}, "risk state")
            st = fn(self._entry(data))
            data[self.mode_key] = st
            _atomic_write_json(self.path, data)
            return st


def evaluate_breakers(
    equity: Decimal, peak: Decimal, day_start: Decimal, max_drawdown_pct: Decimal, max_daily_loss_pct: Decimal,
    floor: Decimal | None = None,
) -> str | None:
    """Return a trip reason, or None. The absolute floor is checked first, then drawdown from peak,
    then loss from start-of-day equity."""
    if floor is not None and floor > 0 and equity < floor:
        return f"equity floor: equity ${equity:.2f} is below the absolute floor ${floor:.2f}"
    if peak > 0:
        dd = (peak - equity) / peak
        if dd >= max_drawdown_pct:
            return f"max drawdown: equity ${equity:.2f} is {dd:.1%} below peak ${peak:.2f} (limit {max_drawdown_pct:.0%})"
    if day_start > 0:
        loss = (day_start - equity) / day_start
        if loss >= max_daily_loss_pct:
            return (f"max daily loss: equity ${equity:.2f} is {loss:.1%} below today's start ${day_start:.2f} "
                    f"(limit {max_daily_loss_pct:.0%})")
    return None


# --------------------------------------------------------------------------- sizing


def shrink(q: Decimal, p: Decimal, weight: Decimal) -> Decimal:
    """q_adj = w*q + (1-w)*p: pull my estimate toward the market price."""
    return weight * q + (_ONE - weight) * p


def edge_after_fee(q_adj: Decimal, p: Decimal, fee: Decimal) -> Decimal:
    return q_adj - p - fee


# On a tie, report the explicit cap rather than Kelly.
_LIMIT_ORDER = ("dollar_ceiling", "daily_budget", "market_pct", "category_pct", "order_pct", "cash", "kelly")


@dataclass(frozen=True)
class SizingResult:
    outcome: str
    q: Decimal
    q_adj: Decimal
    p: Decimal
    fee: Decimal
    edge: Decimal
    kelly_fraction: Decimal
    limits: dict[str, Decimal]
    binding_limit: str | None
    stake_usd: Decimal
    quantity: Decimal
    skip_reason: str | None

    def as_log(self) -> dict[str, Any]:
        return {
            "outcome": self.outcome,
            "q": _fmt(self.q),
            "q_adj": _fmt(self.q_adj.quantize(Decimal("0.0001"))),
            "p": _fmt(self.p),
            "fee": _fmt(self.fee),
            "edge": _fmt(self.edge.quantize(Decimal("0.0001"))),
            "kelly_fraction": _fmt(self.kelly_fraction.quantize(Decimal("0.0001"))),
            "limits_usd": {k: _fmt(v.quantize(Decimal("0.01"))) for k, v in self.limits.items()},
            "binding_limit": self.binding_limit,
            "stake_usd": _fmt(self.stake_usd),
            "quantity": _fmt(self.quantity),
            "skip_reason": self.skip_reason,
        }


def size_position(
    *,
    outcome: str,
    balance: Decimal,
    p: Decimal,
    q: Decimal,
    fee: Decimal,
    estimate_weight: Decimal,
    min_edge: Decimal,
    kelly_multiplier: Decimal,
    max_order_pct: Decimal,
    max_market_pct: Decimal,
    existing_market_exposure: Decimal,
    daily_budget_remaining: Decimal,
    dollar_ceiling: Decimal,
    available_cash: Decimal | None,
    quantity_increment: Decimal,
    quantity_minimum: Decimal,
    max_category_pct: Decimal | None = None,
    existing_category_exposure: Decimal = _ZERO,
) -> SizingResult:
    """Fractional-Kelly stake for buying one outcome of a binary contract.

    p and q are for the outcome being bought. The smallest of the Kelly stake
    and every cap wins. Quantity is rounded down to the contract's step, using
    p + fee per contract so the fee estimate also fits inside the stake.
    """
    if not (_ZERO < p < _ONE):
        raise ValueError("p must be strictly between 0 and 1")
    if not (_ZERO <= q <= _ONE):
        raise ValueError("q must be between 0 and 1")
    if quantity_increment <= 0:
        raise ValueError("quantity_increment must be positive")

    q_adj = shrink(q, p, estimate_weight)
    edge = edge_after_fee(q_adj, p, fee)
    kelly_f = max(edge, _ZERO) / (_ONE - p)

    def result(stake: Decimal, qty: Decimal, binding: str | None, limits: dict, skip: str | None) -> SizingResult:
        return SizingResult(outcome, q, q_adj, p, fee, edge, kelly_f, limits, binding, stake, qty, skip)

    if edge < min_edge:
        return result(_ZERO, _ZERO, None, {}, f"edge {edge:.4f} is below min_edge {min_edge}")

    limits: dict[str, Decimal] = {
        "kelly": max(balance, _ZERO) * kelly_f * kelly_multiplier,
        "order_pct": max(balance, _ZERO) * max_order_pct,
        "market_pct": max(max(balance, _ZERO) * max_market_pct - existing_market_exposure, _ZERO),
        "daily_budget": max(daily_budget_remaining, _ZERO),
        "dollar_ceiling": max(dollar_ceiling, _ZERO),
    }
    if available_cash is not None:
        limits["cash"] = max(available_cash, _ZERO)
    if max_category_pct is not None:
        limits["category_pct"] = max(max(balance, _ZERO) * max_category_pct - existing_category_exposure, _ZERO)
    binding = min((k for k in _LIMIT_ORDER if k in limits), key=lambda k: (limits[k], _LIMIT_ORDER.index(k)))
    stake = limits[binding]

    qty = (stake / (p + fee) / quantity_increment).to_integral_value(rounding=ROUND_FLOOR) * quantity_increment
    if qty <= 0 or qty < quantity_minimum:
        return result(_ZERO, _ZERO, binding, limits,
                      f"stake ${stake:.2f} buys {qty} contracts, below the minimum order size {quantity_minimum}")
    return result(qty * p, qty, binding, limits, None)


# --------------------------------------------------------------------------- order book


@dataclass(frozen=True)
class BookCheck:
    ok: bool
    reason: str | None
    best_bid: Decimal | None = None  # YES space
    best_ask: Decimal | None = None  # YES space
    spread: Decimal | None = None
    buy_price: Decimal | None = None  # for the requested outcome
    sell_price: Decimal | None = None  # for the requested outcome
    depth_contracts: Decimal | None = None

    def as_log(self) -> dict[str, Any]:
        return {k: (_fmt(v) if isinstance(v, Decimal) else v) for k, v in asdict(self).items()}


def _levels(raw: Any) -> list[tuple[Decimal, Decimal]]:
    out = []
    for lvl in raw or []:
        price, qty = Decimal(str(lvl[0])), Decimal(str(lvl[1]))
        if not (price.is_finite() and qty.is_finite()) or qty < 0:
            raise ValueError("bad level")
        if qty > 0:
            out.append((price, qty))
    return out


def check_book(
    book: Any,
    outcome: str,
    *,
    max_spread: Decimal,
    side: str = "buy",
    limit_price: Decimal | None = None,
    quantity: Decimal | None = None,
    min_depth_multiple: Decimal = _ONE,
) -> BookCheck:
    """Reject wide spreads and thin books. Levels are YES-space [price, quantity], per Gemini's depth docs.

    Buying YES takes asks; buying NO at L takes YES bids at or above 1 - L.
    Selling YES hits bids; selling NO at L takes YES asks at or below 1 - L.
    Depth (contracts at or better than the limit) must be at least
    quantity * min_depth_multiple.
    """
    try:
        bids = sorted(_levels(book.get("bids")), key=lambda x: -x[0])
        asks = sorted(_levels(book.get("asks")), key=lambda x: x[0])
    except (AttributeError, TypeError, ValueError, IndexError, InvalidOperation):
        return BookCheck(False, "order book is missing or unparseable")
    if not bids or not asks:
        return BookCheck(False, f"thin book: no {'bids' if not bids else 'asks'}")
    best_bid, best_ask = bids[0][0], asks[0][0]
    spread = best_ask - best_bid
    if outcome == "yes":
        buy_price, sell_price = best_ask, best_bid
    else:
        buy_price, sell_price = _ONE - best_bid, _ONE - best_ask
    base = dict(best_bid=best_bid, best_ask=best_ask, spread=spread, buy_price=buy_price, sell_price=sell_price)
    if spread > max_spread:
        return BookCheck(False, f"wide spread: {spread} > max_spread {max_spread}", **base)
    if limit_price is None or quantity is None:
        return BookCheck(True, None, **base)

    taking_asks = (side == "buy") == (outcome == "yes")
    yes_limit = limit_price if outcome == "yes" else _ONE - limit_price
    if taking_asks:
        depth = sum((q for pr, q in asks if pr <= yes_limit), _ZERO)
    else:
        depth = sum((q for pr, q in bids if pr >= yes_limit), _ZERO)
    need = quantity * min_depth_multiple
    if depth < need:
        return BookCheck(False, f"thin book: {depth} contracts at or better than {limit_price}, need {need}",
                         depth_contracts=depth, **base)
    return BookCheck(True, None, depth_contracts=depth, **base)


# --------------------------------------------------------------------------- orders


@dataclass(frozen=True)
class OrderInput:
    instrument_symbol: str
    outcome: str
    side: str
    quantity: str | None
    limit_price: str
    my_probability: str | None = None

    def digest(self) -> str:
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True).encode()).hexdigest()


@dataclass(frozen=True)
class ValidatedOrder:
    instrument_symbol: str
    outcome: str
    side: str
    quantity: Decimal
    price: Decimal
    cost_usd: Decimal
    event_ticker: str
    event_title: str
    contract_label: str
    best_bid: Any
    best_ask: Any
    outcome_buy_price: Any
    outcome_sell_price: Any
    held_quantity: Decimal | None
    sizing: dict[str, Any] | None = None
    contract_expiry: str | None = None  # as Gemini reported it at validation (contract, else event, expiryDate)

    @property
    def action(self) -> str:
        return f"{self.side.upper()} {self.outcome.upper()} @ {format(self.price, 'f')}"


@dataclass
class PendingOrder:
    order: OrderInput
    digest: str
    created_at: float
    expires_at: float
    sizing: dict[str, Any] | None = None


@dataclass
class RiskContext:
    """Equity, cash and exposure for the active mode (live account or paper ledger)."""

    source: str
    equity: Decimal
    cash: Decimal
    positions: list[dict[str, Any]] = field(default_factory=list)
    event_exposure: dict[str, Decimal] = field(default_factory=dict)
    category_exposure: dict[str, Decimal] = field(default_factory=dict)
    # (symbol, event_ticker, category, dollars) per position / resting buy, so exposure can also be
    # attributed by symbol when the API leaves out the event metadata.
    exposures: list[tuple[str, str, str, Decimal]] = field(default_factory=list)

    def add(self, symbol: str, event: str, category: str, amount: Decimal) -> None:
        self.exposures.append((symbol, event, category, amount))
        self.event_exposure[event] = self.event_exposure.get(event, _ZERO) + amount
        self.category_exposure[category] = self.category_exposure.get(category, _ZERO) + amount

    def exposure_for(self, event_ticker: str, symbols: set[str], category: str) -> tuple[Decimal, Decimal]:
        """(event exposure, category exposure). An entry counts toward this event (and its category) when its
        event ticker matches OR its symbol is one of this event's contracts."""
        ev = sum((a for s, e, _, a in self.exposures if e == event_ticker or s in symbols), _ZERO)
        cat = sum((a for s, e, c, a in self.exposures if c == category or e == event_ticker or s in symbols), _ZERO)
        return ev, cat


def _clip(value: Any, n: int = 64) -> Any:
    """Shorten untrusted strings before they are echoed into errors or the audit log."""
    return value[:n] + "..." if isinstance(value, str) and len(value) > n else value


def _to_decimal(name: str, value: Any) -> Decimal:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise Rejected(f"{name} must be a number")
    if isinstance(value, str) and len(value) > 40:
        raise Rejected(f"{name} is too long to be a sane number")
    try:
        d = Decimal(str(value).strip())
    except InvalidOperation:
        raise Rejected(f"{name} must be a number, got {_clip(value)!r}")
    if not d.is_finite():
        raise Rejected(f"{name} must be finite")
    # Bound magnitude and precision so later arithmetic can't blow up (1e999999, 1e-999999).
    if d != 0 and not (-12 <= d.adjusted() <= 9) or len(d.as_tuple().digits) > 24:
        raise Rejected(f"{name} {_clip(str(value))} is outside the supported range")
    return d


def _on_grid(value: Decimal, anchor: Decimal, step: Decimal) -> bool:
    return step > 0 and (value - anchor) % step == 0


def parse_order_input(
    instrument_symbol: Any, outcome: Any, side: Any, quantity: Any, limit_price: Any, my_probability: Any = None
) -> OrderInput:
    if not isinstance(instrument_symbol, str) or not _SYMBOL_RE.match(instrument_symbol):
        raise Rejected("instrument_symbol is missing or malformed")
    if outcome not in ALLOWED_OUTCOMES:
        raise Rejected(f"outcome must be exactly 'yes' or 'no', got {outcome!r}")
    if side not in ALLOWED_SIDES:
        raise Rejected(f"side must be exactly 'buy' or 'sell', got {side!r}")
    if limit_price is None or (isinstance(limit_price, str) and limit_price.strip().lower() in ("", "market")):
        raise Rejected("a limit price is required; market orders are not supported")
    price = _to_decimal("limit_price", limit_price)
    if not (_ZERO < price < _ONE):
        raise Rejected("limit_price must be strictly between 0 and 1")
    prob = None
    if my_probability is not None:
        if side != "buy":
            raise Rejected("my_probability sizes buys only; sells use quantity and the sell rules")
        q = _to_decimal("my_probability", my_probability)
        if not (_ZERO <= q <= _ONE):
            raise Rejected("my_probability must be between 0 and 1")
        prob = format(q, "f")
    qty_s = None
    if quantity is not None:
        qty = _to_decimal("quantity", quantity)
        if qty <= 0:
            raise Rejected("quantity must be greater than 0")
        qty_s = format(qty, "f")
    elif prob is None:
        raise Rejected("quantity is required (or give my_probability to size a buy)")
    return OrderInput(instrument_symbol, outcome, side, qty_s, format(price, "f"), prob)


def order_cost(side: str, quantity: Decimal, price: Decimal) -> Decimal:
    """Worst-case dollars: buys cost q*p; sells are shown as q*(1-p) (informational, not capped)."""
    return quantity * price if side == "buy" else quantity * (_ONE - price)


def _category(raw: Any) -> str:
    return str(raw).strip().lower() if isinstance(raw, str) and raw.strip() else "unknown"


def category_cap(config: Config, category: str) -> Decimal | None:
    caps = config.category_exposure_caps
    return caps.get(category, caps.get("default"))


def _position_summary(positions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{
        "symbol": p["symbol"], "outcome": p["outcome"], "event_ticker": p["event_ticker"],
        "category": p.get("category"), "quantity": _fmt(p["quantity"]), "available": _fmt(p["available"]),
        "cost_basis": _fmt(p["cost_basis"]), "value": _fmt(p["value"]),
        "quote": "ok" if p.get("has_quote") else "NO LIVE QUOTE (valued at $0)",
    } for p in positions]


def _expiry_text(v: Any) -> str | None:
    return v[:64] if isinstance(v, str) and v else None


CONFIRMED_BY = ("hand", "auto")  # what a client may say about how a confirmation was approved; anything else: None


def live_mode_label(env: str) -> str:
    """The audit "mode" of live orders in this GEMINI_ENV."""
    return "LIVE (production): REAL MONEY" if env == "production" else "LIVE (sandbox): test funds"


def _quote(v: Any) -> Decimal | None:
    """A price quote from Gemini as a Decimal in [0, 1], or None if missing, non-numeric or out of range."""
    if v is None or isinstance(v, bool):
        return None
    try:
        d = Decimal(str(v))
    except InvalidOperation:
        return None
    return d if d.is_finite() and _ZERO <= d <= _ONE else None


def _metadata(obj: dict, what: str) -> tuple[str, str]:
    """(event ticker, category) from contractMetadata. Gemini documents both for positions and orders; without
    them exposure can't be attributed, so refuse."""
    meta = obj.get("contractMetadata")
    if not isinstance(meta, dict):
        raise Rejected(f"{what} returned an entry without contractMetadata; can't attribute exposure, refusing")
    ev, cat = meta.get("eventTicker"), meta.get("category")
    if not isinstance(ev, str) or not ev or not isinstance(cat, str) or not cat.strip():
        raise Rejected(f"{what} returned contractMetadata without eventTicker or category; can't attribute "
                       "exposure, refusing")
    return ev, _category(cat)


def _lower(v: Any) -> str | None:
    return v.lower() if isinstance(v, str) else None


def _placement_problem(resp: Any, symbol: str, side: str, outcome: str, quantity: Decimal,
                       price: Decimal) -> str | None:
    """None if Gemini's reply positively confirms a live order matching the request, else why not."""
    if not isinstance(resp, dict):
        return "reply is not an object"
    if resp.get("result") == "error":
        return "Gemini returned an error"
    if resp.get("orderId") is None:
        return "no order id"
    if _lower(resp.get("status")) not in ("open", "filled"):
        return f"status {resp.get('status')!r} is not open or filled"
    echo = [("symbol", resp.get("symbol"), symbol), ("side", _lower(resp.get("side")), side),
            ("outcome", _lower(resp.get("outcome")), outcome)]
    for name, got, want in echo:
        if name in resp and got != want:
            return f"{name} {resp.get(name)!r} doesn't match the request ({want})"
    for name, want in (("quantity", quantity), ("price", price)):
        if name in resp:
            try:
                ok = Decimal(str(resp[name])) == want
            except InvalidOperation:
                ok = False
            if not ok:
                return f"{name} {resp.get(name)!r} doesn't match the request ({want})"
    return None


def _definitely_not_done(e: Exception) -> bool:
    """True only if a send failed in a way that proves Gemini didn't act on it: the request was refused before
    it left (allowlist, missing credentials), or Gemini answered with a 4xx error. A timeout, connection error,
    5xx or unparseable 2xx means the outcome is unknown."""
    from gemini_client import CredentialsMissing, GeminiAPIError, PathNotAllowed

    if isinstance(e, (PathNotAllowed, CredentialsMissing)):
        return True
    return isinstance(e, GeminiAPIError) and isinstance(e.status, int) and 400 <= e.status < 500


def _cancel_confirmed(resp: Any, order_id: int) -> bool:
    """True only if Gemini's cancel reply positively confirms it. Documented success reply:
    {"result": "ok", "message": "Order N cancelled successfully"}. Also accepted: is_cancelled: true, or an order
    object with status "cancelled". A reply naming another order id, or saying is_cancelled: false, is not."""
    if not isinstance(resp, dict) or resp.get("is_cancelled") is False:
        return False
    if "orderId" in resp:
        try:
            if int(resp["orderId"]) != order_id:
                return False
        except (TypeError, ValueError):
            return False
    lower = lambda k: resp[k].lower() if isinstance(resp.get(k), str) else None  # noqa: E731
    return lower("result") == "ok" or resp.get("is_cancelled") is True or lower("status") == "cancelled"


_API_MAX = Decimal("1e12")


def _dec_field(obj: dict, key: str, what: str, *, lo: Decimal = _ZERO, hi: Decimal = _API_MAX) -> Decimal:
    """A number from a Gemini response: finite, within [lo, hi], and not absurdly precise or tiny. Every amount,
    quantity and price Gemini returns is non-negative, so negatives are refused by default."""
    try:
        d = Decimal(str(obj[key]))
    except (KeyError, InvalidOperation, TypeError):
        raise Rejected(f"{what} returned an unparseable {key}")
    if not d.is_finite():
        raise Rejected(f"{what} returned an unparseable {key}")
    if d < lo or d > hi or (d != 0 and d.adjusted() < -12) or len(d.as_tuple().digits) > 30:
        raise Rejected(f"{what} returned an invalid (negative or out-of-range) {key} {_clip(str(obj[key]))!r}; "
                       "refusing")
    return d


# --------------------------------------------------------------------------- guardrails


class Guardrails:
    def __init__(
        self,
        *,
        config_path: Path,
        kill_path: Path,
        ledger: SpendLedger,
        audit: AuditLog,
        market: Any,
        trader: Any | None,
        dry_run: bool,
        env: str,
        risk_state: RiskState | None = None,
        paper: PaperLedger | None = None,
        clock: Callable[[], float] = time.time,
    ):
        # Dry run must not hold a client that is able to place orders.
        if dry_run and trader is not None:
            raise ValueError("dry-run Guardrails must not be given a trading client")
        if not dry_run and trader is None:
            raise ValueError("live Guardrails requires a trading client")
        if dry_run and paper is None:
            raise ValueError("dry-run Guardrails requires a paper ledger")
        self.config_path = config_path
        self.kill_path = kill_path
        self.ledger = ledger
        self.audit = audit
        self.market = market
        self._trader = trader
        self.dry_run = dry_run
        self.env = env
        self.risk = risk_state or RiskState(ledger.path.with_name("risk_state.json"), ledger.mode_key)
        self.paper = paper
        self._clock = clock
        self._pending: dict[str, PendingOrder] = {}
        self._used: set[str] = set()
        self._lock = threading.RLock()

    # ---- helpers

    @property
    def mode(self) -> str:
        if self.dry_run:
            return f"DRY RUN ({self.env}): nothing will be placed"
        return live_mode_label(self.env)

    def kill_switch_active(self) -> bool:
        return os.path.lexists(self.kill_path)

    def _check_kill(self) -> None:
        if self.kill_switch_active():
            raise Rejected(f"kill switch is active ({self.kill_path.name} file exists); all order tools are disabled")

    def _today(self) -> str:
        return datetime.fromtimestamp(self._clock(), tz=timezone.utc).strftime("%Y-%m-%d")

    def _reject(self, action: str, reason: str, details: dict | None = None, **fields: Any) -> dict[str, Any]:
        self.audit.write("rejection", action=action, reason=reason, mode=self.mode, **(details or {}), **fields)
        return {"ok": False, "rejected": True, "reason": reason, **(details or {})}

    def _resolve_contract(self, symbol: str, config: Config) -> tuple[dict, dict]:
        """Find the one allowlisted event whose own contracts include this symbol (exact match).

        Fails closed: if any allowlisted event can't be fetched or parsed and the
        symbol wasn't otherwise found, or if it's found in more than one event,
        reject.
        """
        if not config.allowed_event_tickers:
            raise Rejected("allowlist is empty: add event tickers to allowed_event_tickers in config.yaml")
        matches: list[tuple[dict, dict]] = []
        failures: list[str] = []
        for ticker in config.allowed_event_tickers:
            try:
                event = self.market.get_event(ticker)
            except Exception as e:  # noqa: BLE001 - any fetch failure is a fail-closed condition
                failures.append(f"{ticker}: {e}")
                continue
            if not isinstance(event, dict) or not isinstance(event.get("contracts"), list):
                failures.append(f"{ticker}: unexpected event response shape")
                continue
            if event.get("ticker") != ticker:
                failures.append(f"{ticker}: response ticker {event.get('ticker')!r} does not match")
                continue
            for c in event["contracts"]:
                if isinstance(c, dict) and c.get("instrumentSymbol") == symbol:
                    matches.append((event, c))
        if len(matches) > 1:
            raise Rejected(f"{symbol} appears in more than one allowlisted event; can't determine its event")
        if not matches:
            if failures:
                raise Rejected(
                    f"can't determine which event {symbol} belongs to; failed to check: " + "; ".join(failures)
                )
            raise Rejected(f"{symbol} is not a contract of any allowlisted event {list(config.allowed_event_tickers)}")
        return matches[0]

    # ---- risk context

    def _live_context(self) -> RiskContext:
        try:
            balances = self.market.get_balances()
        except Exception as e:  # noqa: BLE001
            raise Rejected(f"balances lookup failed: {e}")
        if not isinstance(balances, list):
            raise Rejected("balances lookup returned an unexpected shape")
        if not all(isinstance(b, dict) for b in balances):
            raise Rejected("balances lookup returned a non-object entry; refusing")
        usd = [b for b in balances if str(b.get("currency", "")).upper() == "USD"]
        if len(usd) != 1:
            raise Rejected(f"balances lookup returned {len(usd)} USD entries (need exactly 1); refusing")
        amount = _dec_field(usd[0], "amount", "balances")
        cash = _dec_field(usd[0], "available", "balances")

        try:
            resp = self.market.get_positions()
        except Exception as e:  # noqa: BLE001
            raise Rejected(f"positions lookup failed: {e}")
        raw = resp.get("positions") if isinstance(resp, dict) else None
        if not isinstance(raw, list):
            raise Rejected("positions lookup returned an unexpected shape")
        positions, seen = [], set()
        exp = RiskContext("live", _ZERO, _ZERO)

        # Quantity committed to resting sells is not available to sell again. Gemini may or may not report it
        # as quantityOnHold, so use the larger of the two. An order with no usable outcome reserves both.
        resting_sells: dict[tuple[str, str], Decimal] = {}
        for o in self._active_orders():
            if not isinstance(o, dict):
                raise Rejected("open orders lookup returned a non-object entry; refusing")
            sym = o.get("symbol")
            if not isinstance(sym, str) or not sym:
                raise Rejected("open orders lookup returned an order without a symbol; refusing")
            side = _lower(o.get("side"))
            if side not in ALLOWED_SIDES:
                raise Rejected(f"open orders lookup returned an order with an unrecognized side "
                               f"{_clip(str(o.get('side')))!r}; can't tell buys from sells, refusing")
            outcome = _lower(o.get("outcome"))
            if outcome not in ALLOWED_OUTCOMES:
                raise Rejected(f"open orders lookup returned an order with an unrecognized outcome "
                               f"{_clip(str(o.get('outcome')))!r}; refusing")
            rem = _dec_field(o, "remainingQuantity", "open orders")
            if rem < 0:
                raise Rejected("open orders lookup returned an invalid (negative or out-of-range) quantity or price")
            ev, cat = _metadata(o, "open orders lookup")
            if side == "buy":
                price = _dec_field(o, "price", "open orders", hi=_ONE)
                if not (_ZERO <= price <= _ONE):
                    raise Rejected("open orders lookup returned an invalid (negative or out-of-range) quantity or price")
                exp.add(sym, ev, cat, rem * price)
            else:
                resting_sells[(sym, outcome)] = resting_sells.get((sym, outcome), _ZERO) + rem

        for p in raw:
            if not isinstance(p, dict) or not isinstance(p.get("symbol"), str) or not p["symbol"] \
                    or p.get("outcome") not in ALLOWED_OUTCOMES:
                raise Rejected("positions lookup returned an unexpected entry")
            key = (p["symbol"], p["outcome"])
            if key in seen:
                raise Rejected("positions lookup returned duplicate entries for one contract and outcome")
            seen.add(key)
            total = _dec_field(p, "totalQuantity", "positions lookup")
            on_hold = _dec_field(p, "quantityOnHold", "positions lookup")
            avg = _dec_field(p, "avgPrice", "positions lookup", hi=_ONE)
            # Gemini omits marketValue when there's no live sell quote; count that as $0.
            has_quote = p.get("marketValue") is not None
            value = _dec_field(p, "marketValue", "positions lookup") if has_quote else _ZERO
            if min(total, on_hold, avg, value) < 0 or avg > 1:
                raise Rejected(f"positions lookup returned an invalid (negative or out-of-range) quantity, price "
                               f"or value for {p['symbol']}|{p['outcome']}")
            ev, cat = _metadata(p, "positions lookup")
            cost = total * avg
            positions.append({
                "symbol": p["symbol"], "outcome": p["outcome"], "event_ticker": ev, "category": cat,
                "quantity": total, "available": total - max(on_hold, resting_sells.get(key, _ZERO)),
                "cost_basis": cost, "value": value,
                "has_quote": has_quote, "expiry": p["contractMetadata"].get("expiryDate"),
            })
            exp.add(p["symbol"], ev, cat, max(cost, value))
        exp.equity, exp.cash, exp.positions = amount + sum((p["value"] for p in positions), _ZERO), cash, positions
        return exp

    def _paper_context(self) -> RiskContext:
        assert self.paper is not None
        events: dict[str, dict] = {}
        positions = []
        exp = RiskContext("paper", _ZERO, _ZERO)
        for p in self.paper.positions():
            ev = p["event_ticker"]
            if ev not in events:
                try:
                    events[ev] = self.market.get_event(ev)
                except Exception as e:  # noqa: BLE001
                    raise Rejected(f"couldn't value paper position in {ev}: {e}")
            contract = next((c for c in events[ev].get("contracts") or []
                             if isinstance(c, dict) and c.get("instrumentSymbol") == p["symbol"]), None)
            qty, basis = Decimal(p["quantity"]), Decimal(p["cost_basis"])
            value, has_quote = _ZERO, False
            if contract and contract.get("resolutionSide") in ALLOWED_OUTCOMES:
                value, has_quote = (qty if contract["resolutionSide"] == p["outcome"] else _ZERO), True
            elif contract:
                sell = _quote(((contract.get("prices") or {}).get("sell") or {}).get(p["outcome"]))
                if sell is not None:
                    value, has_quote = qty * sell, True
            cat = _category(events[ev].get("category"))
            positions.append({
                "symbol": p["symbol"], "outcome": p["outcome"], "event_ticker": ev, "category": cat,
                "quantity": qty, "available": qty, "cost_basis": basis, "value": value,
                "has_quote": has_quote, "expiry": (contract or {}).get("expiryDate"),
            })
            exp.add(p["symbol"], ev, cat, max(basis, value))
        cash = self.paper.cash()
        exp.equity, exp.cash, exp.positions = cash + sum((p["value"] for p in positions), _ZERO), cash, positions
        return exp

    def _context(self) -> RiskContext:
        return self._paper_context() if self.dry_run else self._live_context()

    def _active_orders(self) -> list:
        try:
            resp = self.market.list_active_orders(limit=_ACTIVE_ORDERS_PAGE)
        except Exception as e:  # noqa: BLE001
            raise Rejected(f"couldn't read open orders: {e}")
        orders = resp.get("orders") if isinstance(resp, dict) else None
        if not isinstance(orders, list):
            raise Rejected("open orders lookup returned an unexpected shape")
        return orders

    # ---- circuit breakers

    def _check_breakers(self, config: Config, ctx: RiskContext) -> dict[str, Any]:
        """Update peak and start-of-day equity; trip (create KILL) if a limit is breached."""
        today = self._today()
        notes: list[dict] = []

        def step(st: dict[str, Any]) -> dict[str, Any]:
            if not st.get("peak") and self.ledger.has_history():
                # A missing risk state after trading would silently re-baseline peak, day start and floor.
                raise Rejected(
                    f"risk state for {self.ledger.mode_key} is missing from {self.risk.path} but the daily spend "
                    "ledger shows past trades; refusing so the drawdown peak and equity floor aren't silently "
                    "reset. Restore the file, or deliberately start over by also deleting "
                    f"{self.ledger.path}.")
            if st.get("ledger_initialized"):
                if not self.ledger.initialized():
                    raise Rejected(
                        f"daily spend ledger {self.ledger.path} is missing or has no entry for "
                        f"{self.ledger.mode_key}, but this mode has been used before; refusing so today's spend and "
                        "trade count aren't silently reset. Restore the file.")
            else:
                self.ledger.initialize()
                st["ledger_initialized"] = True
            # The floor baseline is set once and never reset (not even by deleting KILL).
            if not st.get("initial_equity") and ctx.equity > 0:
                st["initial_equity"] = _fmt(ctx.equity)
            if st.get("tripped") and not self.kill_switch_active():
                # KILL was deleted by hand: acknowledge the trip and restart the drawdown peak from here.
                notes.append({"event": "breaker_reset", "previous_trip": st["tripped"], "equity": _fmt(ctx.equity)})
                st["tripped"] = None
                st["peak"] = _fmt(ctx.equity)
            peak = max(Decimal(st.get("peak") or ctx.equity), ctx.equity)
            st["peak"] = _fmt(peak)
            if st.get("day") != today:
                st["day"], st["day_start"] = today, _fmt(ctx.equity)
            return st

        st = self.risk.update(step)
        for n in notes:
            self.audit.write(n.pop("event"), mode=self.mode, **n)
        peak, day_start = Decimal(st["peak"]), Decimal(st["day_start"])
        floor, floor_basis, floor_source = self._floor(config, st)
        reason = evaluate_breakers(ctx.equity, peak, day_start, config.max_drawdown_pct, config.max_daily_loss_pct,
                                   floor)
        if reason:
            positions = _position_summary(ctx.positions)
            trip = {"reason": reason, "equity": _fmt(ctx.equity), "peak": _fmt(peak), "day_start": _fmt(day_start),
                    "floor": _fmt(floor), "floor_basis": _fmt(floor_basis), "floor_basis_source": floor_source,
                    "source": ctx.source, "open_positions": positions,
                    "positions_without_quote": [p["symbol"] + "|" + p["outcome"] for p in positions
                                                if p["quote"] != "ok"]}
            try:
                with open(self.kill_path, "x") as f:
                    json.dump({"created_by": "circuit_breaker", "ts": time.time(), **trip}, f, indent=2)
            except FileExistsError:
                pass
            self.risk.update(lambda s: {**s, "tripped": trip})
            self.audit.write("circuit_breaker_trip", mode=self.mode, **trip)
            raise Rejected(f"circuit breaker tripped ({reason}); created {self.kill_path.name}. "
                           "Delete it by hand to resume.")
        return {"peak": peak, "day_start": day_start, "floor": floor}

    def _floor(self, config: Config, st: dict[str, Any]) -> tuple[Decimal | None, Decimal | None, str]:
        """(floor, basis, where the basis came from). Paper: bankroll. Live: config, else first equity seen."""
        budget = config.learning_budget_usd
        if config.equity_floor_pct <= 0 and budget is None:
            return None, None, "disabled"
        if self.dry_run and self.paper is not None:
            basis, source = Decimal(self.paper.snapshot().get("bankroll_usd") or "0"), "paper_bankroll"
        elif config.starting_balance_usd is not None:
            basis, source = config.starting_balance_usd, "starting_balance_usd"
        elif st.get("initial_equity"):
            basis, source = Decimal(st["initial_equity"]), "first_observed_equity"
        else:
            return None, None, "no positive equity observed yet"
        if budget is not None:
            floor = max(basis - budget, LEARNING_FLOOR_MIN_PCT * basis)
            return floor.quantize(Decimal("0.01"), rounding=ROUND_CEILING), basis, source
        return config.equity_floor_pct * basis, basis, source

    # ---- KILL deletion log

    def observe_kill(self) -> None:
        """Log when a KILL file appears and every time one is deleted (deletion is always manual)."""
        present = self.kill_switch_active()
        info: Any = None
        if present:
            try:
                raw = self.kill_path.read_text()[:4000]
                try:
                    info = json.loads(raw)
                    info = {k: info.get(k) for k in ("created_by", "reason", "ts")} if isinstance(info, dict) else raw
                except ValueError:
                    info = {"created_by": "manual", "content": raw}
            except OSError:
                info = {"created_by": "unknown"}
        events: list[tuple[str, dict]] = []
        now = datetime.fromtimestamp(self._clock(), tz=timezone.utc).isoformat(timespec="seconds")
        watch = self.risk.path.with_name("kill_watch.json")
        with file_lock(watch):
            prev = _read_json(watch, {}, "kill watch")
            if not isinstance(prev, dict):
                prev = {}
            if prev.get("present") and not present:
                events.append(("kill_deleted", {"kill": prev.get("info"), "present_since": prev.get("since"),
                                                "noticed_at": now}))
            elif present and not prev.get("present"):
                events.append(("kill_detected", {"kill": info, "noticed_at": now}))
            if bool(prev.get("present")) != present or not watch.exists():
                _atomic_write_json(watch, {"present": present, "info": info, "since": now if present else None})
        for name, fields in events:
            self.audit.write(name, mode=self.mode, **fields)

    def _audit_today(self, today: str) -> tuple[Decimal, int, int]:
        """(buy dollars, buys, sells) confirmed today in this mode according to audit.log. Unparseable lines are
        skipped: the audit log is only used as a floor under the ledger."""
        spend, count, sells = _ZERO, 0, 0
        prefix = '{"ts": "' + today
        try:
            f = open(self.audit.path, encoding="utf-8")
        except FileNotFoundError:
            return spend, count, sells
        with f:
            for line in f:
                if not line.startswith(prefix):
                    continue
                try:
                    e = json.loads(line)
                    if e.get("event") != "confirmation" or e.get("mode") != self.mode:
                        continue
                    cost = Decimal(str(e.get("worst_case_cost_usd"))) if e.get("side") == "buy" else _ZERO
                except (ValueError, InvalidOperation, AttributeError):
                    continue
                if cost.is_finite() and cost > 0:
                    spend += cost
                if e.get("side") == "buy":
                    count += 1
                else:
                    sells += 1
        return spend, count, sells

    def _recent_sells(self, symbol: str, outcome: str) -> Decimal:
        """Quantity of sells of this contract+outcome confirmed (this mode) within RECENT_SELL_WINDOW_S."""
        now = self._clock()
        days = {datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d")
                for t in (now - RECENT_SELL_WINDOW_S, now)}
        prefixes = tuple('{"ts": "' + d for d in days)
        total = _ZERO
        try:
            f = open(self.audit.path, encoding="utf-8")
        except FileNotFoundError:
            return total
        with f:
            for line in f:
                if not line.startswith(prefixes):
                    continue
                try:
                    e = json.loads(line)
                    if (e.get("event") != "confirmation" or e.get("mode") != self.mode or e.get("side") != "sell"
                            or e.get("instrument_symbol") != symbol or e.get("outcome") != outcome):
                        continue
                    ts = datetime.fromisoformat(e["ts"]).timestamp()
                    q = Decimal(str(e.get("quantity")))
                except (ValueError, KeyError, InvalidOperation, TypeError):
                    continue
                if now - RECENT_SELL_WINDOW_S <= ts <= now + 5 and q.is_finite() and q > 0:
                    total += q
        return total

    def _check_ledger_against_audit(self, today: str, spent: Decimal, trades: int, exits: int) -> None:
        a_spend, a_trades, a_exits = self._audit_today(today)
        if spent < a_spend or trades < a_trades or exits < a_exits:
            raise Rejected(
                f"daily spend ledger {self.ledger.path} shows ${spent} spent / {trades} buys / {exits} exits today "
                f"(UTC), but audit.log shows ${a_spend} / {a_trades} buys / {a_exits} exits confirmed; refusing so "
                "the daily caps aren't "
                "bypassed. Restore the ledger (or raise today's entries to at least the audit totals).")

    def _daily_limit(self, config: Config, day_start: Decimal) -> Decimal:
        return min(config.max_daily_spend_usd, config.max_daily_spend_pct * max(day_start, _ZERO))

    # ---- validation

    def _validate(self, inp: OrderInput, config: Config, *, allow_sizing: bool) -> ValidatedOrder:
        price = Decimal(inp.limit_price)
        event, contract = self._resolve_contract(inp.instrument_symbol, config)
        event_ticker = str(event.get("ticker"))

        if event.get("status") != "active":
            raise Rejected(f"event {event_ticker} status is {event.get('status')!r}, not 'active'")
        if contract.get("status") != "active":
            raise Rejected(f"contract status is {contract.get('status')!r}, not 'active'")
        if contract.get("marketState") != "open":
            raise Rejected(f"contract marketState is {contract.get('marketState')!r}, not 'open'")

        if any(k not in contract for k in ("priceMinimum", "priceIncrement", "quantityMinimum", "quantityIncrement")):
            raise Rejected("contract is missing price/quantity increments; can't validate the order")
        try:
            # Plausible ranges only: a 1e-400 tick or a 0 step would make the grid meaningless.
            p_min = _dec_field(contract, "priceMinimum", "contract", hi=Decimal("0.99"))
            p_inc = _dec_field(contract, "priceIncrement", "contract", lo=Decimal("0.000001"), hi=_ONE)
            q_min = _dec_field(contract, "quantityMinimum", "contract", hi=Decimal("1e6"))
            q_inc = _dec_field(contract, "quantityIncrement", "contract", lo=Decimal("0.000001"), hi=Decimal("1e6"))
        except Rejected as e:
            raise Rejected(f"contract has invalid price/quantity increments ({e}); can't validate the order")
        if price < p_min or not _on_grid(price, p_min, p_inc):
            raise Rejected(f"limit_price {price} is off the contract's price grid (min {p_min}, step {p_inc})")

        ctx = self._context()
        marks = self._check_breakers(config, ctx)
        spent = self.ledger.spent_on(self._today())
        trades = self.ledger.trades_on(self._today())
        exits = self.ledger.exits_on(self._today())
        self._check_ledger_against_audit(self._today(), spent, trades, exits)
        daily_limit = self._daily_limit(config, marks["day_start"])
        if config.category_exposure_caps and not (isinstance(event.get("category"), str)
                                                  and event["category"].strip()):
            raise Rejected(f"event {event_ticker} has no category but category_exposure_caps are configured; "
                           "can't apply the cap, refusing")
        category = _category(event.get("category"))
        cat_cap_pct = category_cap(config, category)
        symbols = {c.get("instrumentSymbol") for c in event["contracts"] if isinstance(c, dict)}
        exposure, cat_exposure = ctx.exposure_for(event_ticker, symbols, category)

        sizing = None
        if inp.side == "buy" and inp.my_probability is not None and allow_sizing:
            sz = size_position(
                outcome=inp.outcome, balance=ctx.equity, p=price, q=Decimal(inp.my_probability),
                fee=config.fee_per_contract, estimate_weight=config.estimate_weight, min_edge=config.min_edge,
                kelly_multiplier=config.kelly_multiplier, max_order_pct=config.max_order_pct_of_balance,
                max_market_pct=config.max_market_pct_of_balance, existing_market_exposure=exposure,
                daily_budget_remaining=daily_limit - spent, dollar_ceiling=config.max_order_usd,
                available_cash=ctx.cash, quantity_increment=q_inc, quantity_minimum=q_min,
                max_category_pct=cat_cap_pct, existing_category_exposure=cat_exposure,
            )
            sizing = sz.as_log()
            if sz.quantity <= 0:
                raise Rejected(f"no trade: {sz.skip_reason}", {"sizing": sizing})
            qty = sz.quantity
            if inp.quantity is not None:  # caller's quantity is an upper bound
                qty = min(qty, Decimal(inp.quantity))
        elif inp.quantity is None:
            raise Rejected("quantity is required")
        else:
            qty = Decimal(inp.quantity)
        if qty < q_min or not _on_grid(qty, _ZERO, q_inc):
            raise Rejected(f"quantity {qty} is off the contract's quantity grid (min {q_min}, step {q_inc})")

        held: Decimal | None = None
        if inp.side == "sell":
            match = [p for p in ctx.positions if p["symbol"] == inp.instrument_symbol and p["outcome"] == inp.outcome]
            held = match[0]["available"] if match else _ZERO
            note = ""
            if not self.dry_run and match:
                # Reserve recently confirmed sells too, in case Gemini's view lags. max(), not a sum, with what
                # Gemini already reports as committed, so a reflected sell isn't counted twice.
                total = match[0]["quantity"]
                recent = self._recent_sells(inp.instrument_symbol, inp.outcome)
                if total - recent < held:
                    held = max(total - recent, _ZERO)
                    note = f"; {recent} recently confirmed in the last {RECENT_SELL_WINDOW_S}s are reserved"
            if qty > held:
                raise Rejected(f"sell quantity {qty} exceeds the {held} {inp.outcome.upper()} contracts you hold "
                               f"({ctx.source} positions{note})")

        cost = order_cost(inp.side, qty, price)
        details = {"sizing": sizing} if sizing else None
        if inp.side == "buy":
            # Sells of held quantity reduce exposure, so only buys are capped in dollars.
            if cost > config.max_order_usd:
                raise Rejected(f"order cost ${cost} exceeds max_order_usd ${config.max_order_usd}", details)
            order_cap = config.max_order_pct_of_balance * max(ctx.equity, _ZERO)
            if cost > order_cap:
                raise Rejected(f"order cost ${cost} exceeds max_order_pct_of_balance "
                               f"({config.max_order_pct_of_balance} x ${ctx.equity:.2f} = ${order_cap:.2f})", details)
            market_cap = config.max_market_pct_of_balance * max(ctx.equity, _ZERO)
            if exposure + cost > market_cap:
                raise Rejected(f"event {event_ticker} exposure ${exposure:.2f} + ${cost} exceeds "
                               f"max_market_pct_of_balance cap ${market_cap:.2f}", details)
            if cat_cap_pct is not None:
                cat_cap = cat_cap_pct * max(ctx.equity, _ZERO)
                if cat_exposure + cost > cat_cap:
                    raise Rejected(f"category {category!r} exposure ${cat_exposure:.2f} + ${cost} exceeds its "
                                   f"category_exposure_caps limit ${cat_cap:.2f} ({cat_cap_pct} of equity)", details)
            if spent + cost > daily_limit:
                raise Rejected(f"daily cap: ${spent} already spent today (UTC) + ${cost} would exceed the daily "
                               f"limit ${daily_limit:.2f} (lower of max_daily_spend_usd and max_daily_spend_pct)",
                               details)
            if cost > ctx.cash:
                raise Rejected(f"order cost ${cost} exceeds available cash ${ctx.cash:.2f}", details)

        # Buys count against max_trades_per_day; sells of held quantity (exits) only against max_exits_per_day,
        # so a used-up trade budget never blocks reducing a position.
        if inp.side == "buy" and trades >= config.max_trades_per_day:
            raise Rejected(f"{trades} trades placed today (UTC); max_trades_per_day is {config.max_trades_per_day}",
                           details)
        if inp.side == "sell" and exits >= config.max_exits_per_day:
            raise Rejected(f"{exits} exits placed today (UTC); max_exits_per_day is {config.max_exits_per_day}",
                           details)

        open_count = len(self._active_orders())
        if open_count >= config.max_open_orders:
            raise Rejected(f"{open_count} open orders already; max_open_orders is {config.max_open_orders}", details)

        prices = contract.get("prices") if isinstance(contract.get("prices"), dict) else {}
        buy = prices.get("buy") if isinstance(prices.get("buy"), dict) else {}
        sell = prices.get("sell") if isinstance(prices.get("sell"), dict) else {}
        return ValidatedOrder(
            instrument_symbol=inp.instrument_symbol,
            outcome=inp.outcome,
            side=inp.side,
            quantity=qty,
            price=price,
            cost_usd=cost,
            event_ticker=event_ticker,
            event_title=str(event.get("title", "")),
            contract_label=str(contract.get("label", "")),
            best_bid=prices.get("bestBid"),
            best_ask=prices.get("bestAsk"),
            outcome_buy_price=buy.get(inp.outcome),
            outcome_sell_price=sell.get(inp.outcome),
            held_quantity=held,
            sizing=sizing,
            contract_expiry=_expiry_text(contract.get("expiryDate") or event.get("expiryDate")),
        )

    # ---- public API

    def propose(
        self, instrument_symbol: Any, outcome: Any, side: Any, quantity: Any, limit_price: Any,
        my_probability: Any = None,
    ) -> dict[str, Any]:
        raw = {k: _clip(v) for k, v in {
            "instrument_symbol": instrument_symbol,
            "outcome": outcome,
            "side": side,
            "quantity": quantity,
            "limit_price": limit_price,
            "my_probability": my_probability,
        }.items()}
        with self._lock:
            try:
                self.observe_kill()
                self._check_kill()
                inp = parse_order_input(instrument_symbol, outcome, side, quantity, limit_price, my_probability)
                config = load_config(self.config_path)
                v = self._validate(inp, config, allow_sizing=True)
            except Rejected as e:
                return self._reject("propose_order", str(e), e.details, request=raw)

            # Freeze the sized quantity: confirm re-checks every cap on exactly this order.
            frozen = OrderInput(inp.instrument_symbol, inp.outcome, inp.side, format(v.quantity, "f"),
                                inp.limit_price, inp.my_probability)
            now = self._clock()
            self._pending = {t: p for t, p in self._pending.items() if p.expires_at > now}
            token = secrets.token_urlsafe(24)
            self._pending[token] = PendingOrder(frozen, frozen.digest(), now, now + TOKEN_TTL_SECONDS, v.sizing)
            spent = self.ledger.spent_on(self._today())
            expires = datetime.fromtimestamp(now + TOKEN_TTL_SECONDS, tz=timezone.utc).isoformat(timespec="seconds")
            preview = {
                "action": v.action,
                "summary": (
                    f"{v.action} x {format(v.quantity, 'f')} contracts of {v.instrument_symbol} "
                    f"({v.contract_label}), event {v.event_ticker}"
                ),
                "mode": self.mode,
                "instrument_symbol": v.instrument_symbol,
                "outcome": v.outcome.upper(),
                "side": v.side.upper(),
                "quantity": format(v.quantity, "f"),
                "limit_price": format(v.price, "f"),
                "order_type": "limit, good-til-cancel",
                "worst_case_cost_usd": format(v.cost_usd, "f"),
                "resolved_event_ticker": v.event_ticker,
                "event_title": v.event_title,
                "market": {
                    "best_bid": v.best_bid,
                    "best_ask": v.best_ask,
                    f"buy_{v.outcome}": v.outcome_buy_price,
                    f"sell_{v.outcome}": v.outcome_sell_price,
                },
                "limits": {
                    "max_order_usd": format(config.max_order_usd, "f"),
                    "spent_today_usd": format(spent, "f"),
                    "max_daily_spend_usd": format(config.max_daily_spend_usd, "f"),
                    "max_open_orders": config.max_open_orders,
                    "trades_today": self.ledger.trades_on(self._today()),
                    "max_trades_per_day": config.max_trades_per_day,
                    "exits_today": self.ledger.exits_on(self._today()),
                    "max_exits_per_day": config.max_exits_per_day,
                },
            }
            if v.sizing:
                preview["sizing"] = v.sizing
            if v.held_quantity is not None:
                preview["held_quantity"] = format(v.held_quantity, "f")
            self.audit.write(
                "proposal",
                token_id=frozen.digest()[:12],
                mode=self.mode,
                trade=v.action,
                instrument_symbol=v.instrument_symbol,
                quantity=v.quantity,
                limit_price=v.price,
                worst_case_cost_usd=v.cost_usd,
                resolved_event_ticker=v.event_ticker,
                sizing=v.sizing,
            )
            return {
                "ok": True,
                "preview": preview,
                "confirmation_token": token,
                "token_expires_at": expires,
                "note": "Nothing has been placed. Call confirm_order with this token within 5 minutes to proceed.",
            }

    def confirm(self, token: Any, confirmed_by: Any = None) -> dict[str, Any]:
        """confirmed_by: how the client says this was approved, "hand" (a person typed yes) or "auto". It's a
        client claim, recorded for preflight's fast-track counts; any other value is recorded as None."""
        with self._lock:
            if not isinstance(token, str) or not token:
                return self._reject("confirm_order", "a confirmation token is required")
            # Burn the token before anything else so it can never be used twice.
            pending = self._pending.pop(token, None)
            already_used = token in self._used
            self._used.add(token)
            try:
                if pending is None:
                    raise Rejected("token was already used" if already_used else "unknown or expired token")
                if self._clock() > pending.expires_at:
                    raise Rejected("token expired (tokens are valid for 5 minutes); propose the order again")
                if pending.order.digest() != pending.digest:
                    raise Rejected("stored order does not match its token; refusing")
            except Rejected as e:
                order = asdict(pending.order) if pending else None
                return self._reject("confirm_order", str(e), e.details, order=order)
            # Other server processes share the state files. Hold one cross-process lock from validation
            # through recording spend and placing, so two processes can't both pass the same cap.
            with file_lock(self.ledger.path.with_name("orders")):
                return self._confirm_locked(pending, confirmed_by if confirmed_by in CONFIRMED_BY else None)

    def _confirm_locked(self, pending: PendingOrder, confirmed_by: str | None = None) -> dict[str, Any]:
        try:
            self.observe_kill()
            self._check_kill()
            config = load_config(self.config_path)
            v = self._validate(pending.order, config, allow_sizing=False)
        except Rejected as e:
            return self._reject("confirm_order", str(e), e.details, order=asdict(pending.order))

        # What paper mode assumes for this order right now: filled in full at the limit price when the limit is
        # at or beyond the outcome's current buy (sell) price, plus fee_per_contract. Live orders record it too, so
        # report.py --live can compare it with the real fill.
        if v.side == "buy":
            ref = _quote(v.outcome_buy_price)
            filled = ref is not None and v.price >= ref
        else:
            ref = _quote(v.outcome_sell_price)
            filled = ref is not None and v.price <= ref
        paper_assumed = {"filled": filled, "price": _fmt(v.price) if filled else None,
                         "quantity": _fmt(v.quantity) if filled else "0",
                         "fee_per_contract": _fmt(config.fee_per_contract), "reference_price": _fmt(ref)}
        common = dict(
            mode=self.mode,
            trade=v.action,
            instrument_symbol=v.instrument_symbol,
            side=v.side,
            outcome=v.outcome,
            quantity=v.quantity,
            limit_price=v.price,
            worst_case_cost_usd=v.cost_usd,
            resolved_event_ticker=v.event_ticker,
            sizing=pending.sizing,
            paper_assumed=paper_assumed,
            contract_expiry=v.contract_expiry,
            confirmed_by=confirmed_by,
        )
        # Ledger first: audit.log must never show more than the ledger (that mismatch is refused).
        spent_total, _ = self.ledger.record_trade(self._today(), v.cost_usd if v.side == "buy" else _ZERO, v.side)
        self.audit.write("confirmation", **common)

        if self.dry_run:
            assert self.paper is not None
            paper_id = self.paper.record_order(
                symbol=v.instrument_symbol, outcome=v.outcome, side=v.side, quantity=v.quantity,
                price=v.price, fee=config.fee_per_contract, event_ticker=v.event_ticker, filled=filled,
            )
            self.audit.write("would_place", spent_today_usd=spent_total, paper_order_id=paper_id,
                             paper_filled=filled, **common)
            return {
                "ok": True,
                "dry_run": True,
                "message": f"DRY RUN: would have placed {v.action} x {format(v.quantity, 'f')} "
                f"{v.instrument_symbol}. Nothing was sent to Gemini.",
                "paper_order_id": paper_id,
                "paper_filled": filled,
                "spent_today_usd": format(spent_total, "f"),
            }

        # Last-moment kill check, right before the real request.
        if self.kill_switch_active():
            reason = "kill switch activated during confirmation; order not placed"
            self.audit.write("rejection", action="confirm_order", reason=reason, **common)
            return {"ok": False, "rejected": True, "reason": reason}
        intent_id = self._write_intent("place", spent_today_usd=spent_total, **common)
        if intent_id is None:
            return {"ok": False, "error": "couldn't write order_intent to audit.log; order NOT sent. "
                    "The spend stays counted for today."}
        try:
            resp = self._trader.place_limit_order(v.instrument_symbol, v.side, v.outcome, v.quantity, v.price)
        except Exception as e:  # noqa: BLE001
            definite = _definitely_not_done(e)
            return self._write_result(intent_id, "failed" if definite else "unconfirmed", common, None, {
                "ok": False,
                "error": str(e),
                "note": ("Gemini rejected the order. " if definite else
                         "The outcome is UNKNOWN: the order may exist. Check Gemini. ")
                + "It will NOT be retried. Check list_open_orders before proposing again. "
                "The spend stays counted for today.",
            }, error=str(e))
        order_id = resp.get("orderId") if isinstance(resp, dict) else None
        status = resp.get("status") if isinstance(resp, dict) else None
        problem = _placement_problem(resp, v.instrument_symbol, v.side, v.outcome, v.quantity, v.price)
        if problem:
            # Only a reply that positively confirms a live order matching the request counts as placed.
            return self._write_result(intent_id, "unconfirmed", common, order_id, {
                "ok": False,
                "order_id": order_id,
                "error": f"placement unconfirmed ({problem}); response: {resp!r}",
                "note": "The order may or may not exist. It will NOT be retried. Check list_open_orders before "
                "proposing again. The spend stays counted for today.",
            }, response=resp)
        return self._write_result(intent_id, "placed", common, order_id,
                                  {"ok": True, "dry_run": False, "order_id": order_id, "status": status,
                                   "response": resp}, order_id=order_id, status=status)

    def _write_intent(self, action: str, **fields: Any) -> str | None:
        """Write (and fsync) an order_intent entry before anything is sent. None if it couldn't be written."""
        intent_id = secrets.token_hex(8)
        try:
            self.audit.write("order_intent", intent_id=intent_id, action=action, **fields)
        except Exception:  # noqa: BLE001 - nothing is sent without a durable intent
            return None
        return intent_id

    def _write_result(self, intent_id: str, result: str, fields: dict[str, Any], sent_order_id: Any,
                      reply: dict[str, Any], **extra: Any) -> dict[str, Any]:
        """Write the order_result entry after a send. If that fails, say so without hiding the order id."""
        try:
            self.audit.write("order_result", intent_id=intent_id, result=result, **fields, **extra)
        except Exception as e:  # noqa: BLE001
            oid = f", order_id {sent_order_id}" if sent_order_id is not None else ""
            return {"ok": False, "order_id": sent_order_id, "intent_id": intent_id, "gemini_reply": reply,
                    "error": f"request was sent to Gemini (result: {result}{oid}) but writing order_result to "
                    f"audit.log failed ({type(e).__name__}: {e}). Check Gemini before doing anything else."}
        return reply

    def cancel(self, order_id: Any) -> dict[str, Any]:
        with self._lock:
            try:
                self.observe_kill()
                self._check_kill()
                if isinstance(order_id, bool):
                    raise Rejected("order_id must be a positive integer")
                try:
                    oid = int(str(order_id).strip())
                except ValueError:
                    raise Rejected("order_id must be a positive integer")
                if oid <= 0:
                    raise Rejected("order_id must be a positive integer")
            except Rejected as e:
                return self._reject("cancel_order", str(e), order_id=order_id)

            if self.dry_run:
                self.audit.write("would_cancel", order_id=oid, mode=self.mode)
                return {"ok": True, "dry_run": True, "message": f"DRY RUN: would have cancelled order {oid}."}
            fields = {"mode": self.mode, "order_id": oid}
            intent_id = self._write_intent("cancel", **fields)
            if intent_id is None:
                return {"ok": False, "order_id": oid,
                        "error": "couldn't write order_intent to audit.log; cancel NOT sent"}
            try:
                resp = self._trader.cancel_order(oid)
            except Exception as e:  # noqa: BLE001
                definite = _definitely_not_done(e)
                return self._write_result(intent_id, "cancel_failed" if definite else "unconfirmed", fields, oid, {
                    "ok": False, "order_id": oid, "error": str(e),
                    "note": "Gemini refused the cancel." if definite else
                    "The outcome is UNKNOWN: the order may or may not still be open. Check get_order_status."},
                    error=str(e))
            if isinstance(resp, dict) and resp.get("result") == "error":
                return self._write_result(intent_id, "cancel_failed", fields, oid, {
                    "ok": False, "order_id": oid, "error": f"Gemini refused the cancel; response: {resp!r}",
                    "note": "Check get_order_status; the order may still be open."}, response=resp)
            if not _cancel_confirmed(resp, oid):
                return self._write_result(intent_id, "unconfirmed", fields, oid, {
                    "ok": False, "order_id": oid,
                    "error": f"cancel of order {oid} unconfirmed: Gemini's reply doesn't positively confirm it; "
                    f"response: {resp!r}",
                    "note": "Treat the order as possibly still open. Check get_order_status."}, response=resp)
            return self._write_result(intent_id, "cancelled", fields, oid,
                                      {"ok": True, "dry_run": False, "order_id": oid, "response": resp},
                                      response=resp)

    def check_breakers(self) -> dict[str, Any]:
        """Evaluate the equity floor, drawdown and daily-loss breakers right now, exactly as propose/confirm do
        (including creating KILL on a trip). The runner calls this at the start of every run, before any research
        or proposal, so a breach is caught even when nothing would be proposed. Fails closed: anything that keeps
        the check from completing returns ok: False."""
        with self._lock:
            try:
                self.observe_kill()
                self._check_kill()
                config = load_config(self.config_path)
                ctx = self._context()
                marks = self._check_breakers(config, ctx)
            except Rejected as e:
                reason = str(e)
                self.audit.write("rejection", action="check_circuit_breakers", reason=reason, mode=self.mode)
                return {"ok": False, "tripped": reason.startswith("circuit breaker tripped"), "reason": reason}
            return {"ok": True, "tripped": False, "mode": self.mode, "equity_usd": _fmt(ctx.equity),
                    "peak_usd": _fmt(marks["peak"]), "day_start_usd": _fmt(marks["day_start"]),
                    "floor_usd": _fmt(marks["floor"])}

    # ---- read-only views for tools

    def risk_summary(self) -> dict[str, Any]:
        """Equity, caps and breaker status for the active mode. Doesn't trip or persist anything."""
        self.observe_kill()
        config = load_config(self.config_path)
        ctx = self._context()
        st = self.risk.read()
        floor, floor_basis, floor_source = self._floor(config, st)
        peak = max(Decimal(st.get("peak") or ctx.equity), ctx.equity)
        day_start = Decimal(st["day_start"]) if st.get("day") == self._today() else ctx.equity
        spent = self.ledger.spent_on(self._today())
        daily_limit = self._daily_limit(config, day_start)
        return {
            "mode": self.mode,
            "source": ctx.source,
            "equity_usd": _fmt(ctx.equity.quantize(Decimal("0.01"))),
            "cash_usd": _fmt(ctx.cash.quantize(Decimal("0.01"))),
            "peak_equity_usd": _fmt(peak.quantize(Decimal("0.01"))),
            "day_start_equity_usd": _fmt(day_start.quantize(Decimal("0.01"))),
            "spent_today_usd": _fmt(spent),
            "trades_today": self.ledger.trades_on(self._today()),
            "max_trades_per_day": config.max_trades_per_day,
            "exits_today": self.ledger.exits_on(self._today()),
            "max_exits_per_day": config.max_exits_per_day,
            "daily_limit_usd": _fmt(daily_limit.quantize(Decimal("0.01"))),
            "event_exposure_usd": {k: _fmt(v.quantize(Decimal("0.01"))) for k, v in ctx.event_exposure.items()},
            "equity_floor_usd": _fmt(floor.quantize(Decimal("0.01"))) if floor is not None else None,
            "equity_floor_basis": {"usd": _fmt(floor_basis), "source": floor_source},
            "category_exposure_usd": {k: _fmt(v.quantize(Decimal("0.01"))) for k, v in ctx.category_exposure.items()},
            "category_caps": {k: _fmt(v) for k, v in config.category_exposure_caps.items()},
            "positions_without_quote": [p["symbol"] + "|" + p["outcome"] for p in ctx.positions
                                        if not p.get("has_quote")],
            "breaker_would_trip": evaluate_breakers(ctx.equity, peak, day_start, config.max_drawdown_pct,
                                                    config.max_daily_loss_pct, floor),
            "breaker_tripped": st.get("tripped"),
            "kill_switch_active": self.kill_switch_active(),
        }

    def review_positions(self) -> list[dict[str, Any]]:
        """Positions the runner reviews: paper positions in dry run, account positions when live."""
        return [{k: (_fmt(v) if isinstance(v, Decimal) else v) for k, v in p.items()}
                for p in self._context().positions]

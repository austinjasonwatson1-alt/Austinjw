"""Every order limit check lives here, enforced in code rather than in prompts.

Flow:
  propose() -> validates, returns a preview and a one-time token. Places nothing.
  confirm() -> burns the token first, re-runs every check with fresh data,
               records spend, then either logs a dry-run placement or calls
               the trading client.
  cancel()  -> kill-switch aware; dry run only logs.

All checks fail closed. If data is missing, malformed or can't be fetched,
the order is rejected.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable

import yaml

TOKEN_TTL_SECONDS = 300
ALLOWED_OUTCOMES = ("yes", "no")
ALLOWED_SIDES = ("buy", "sell")
_SYMBOL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,120}$")
_TICKER_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
_ACTIVE_ORDERS_PAGE = 100
_ONE = Decimal(1)


class Rejected(Exception):
    """An order or action refused by a guardrail. The message is the reason."""


class ConfigError(Rejected):
    pass


# --------------------------------------------------------------------------- config


@dataclass(frozen=True)
class Config:
    max_order_usd: Decimal = Decimal("10")
    max_daily_spend_usd: Decimal = Decimal("25")
    max_open_orders: int = 3
    allowed_event_tickers: tuple[str, ...] = ()


_CONFIG_KEYS = {"max_order_usd", "max_daily_spend_usd", "max_open_orders", "allowed_event_tickers"}


def _nonneg_decimal(name: str, value: Any) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise ConfigError(f"config {name} must be a number")
    try:
        d = Decimal(str(value))
    except InvalidOperation:
        raise ConfigError(f"config {name} must be a number")
    if not d.is_finite() or d < 0:
        raise ConfigError(f"config {name} must be a finite number >= 0")
    return d


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
    unknown = set(raw) - _CONFIG_KEYS
    if unknown:
        raise ConfigError(f"unknown config keys (typo?): {sorted(unknown)}")

    d = Config()
    max_order = _nonneg_decimal("max_order_usd", raw.get("max_order_usd", d.max_order_usd))
    max_daily = _nonneg_decimal("max_daily_spend_usd", raw.get("max_daily_spend_usd", d.max_daily_spend_usd))
    max_open = raw.get("max_open_orders", d.max_open_orders)
    if isinstance(max_open, bool) or not isinstance(max_open, int) or max_open < 0:
        raise ConfigError("config max_open_orders must be an integer >= 0")
    tickers = raw.get("allowed_event_tickers", [])
    if tickers is None:
        tickers = []
    if not isinstance(tickers, list) or not all(isinstance(t, str) and _TICKER_RE.match(t) for t in tickers):
        raise ConfigError("config allowed_event_tickers must be a list of event ticker strings")
    return Config(max_order, max_daily, max_open, tuple(tickers))


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


# --------------------------------------------------------------------------- audit log


class AuditLog:
    """Append-only JSON-lines log. Known secret values are redacted before writing."""

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
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())


# --------------------------------------------------------------------------- daily spend


class SpendLedger:
    """Persisted per-UTC-day spend, keyed by mode so dry runs never use up the live budget.

    Spend is recorded when an order is confirmed and is never refunded, even
    on cancel or a failed placement.
    """

    def __init__(self, path: Path, mode_key: str):
        self.path = path
        self.mode_key = mode_key
        self._lock = threading.Lock()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"version": 1, "spend": {}}
        try:
            data = json.loads(self.path.read_text())
            if not isinstance(data, dict) or not isinstance(data.get("spend"), dict):
                raise ValueError("bad shape")
            return data
        except (ValueError, OSError) as e:
            raise Rejected(f"daily spend ledger {self.path} is unreadable ({e}); refusing to trade")

    def spent_on(self, day: str) -> Decimal:
        with self._lock:
            raw = self._load()["spend"].get(self.mode_key, {}).get(day, "0")
        try:
            return Decimal(raw)
        except InvalidOperation:
            raise Rejected("daily spend ledger has a malformed amount; refusing to trade")

    def add(self, day: str, amount: Decimal) -> Decimal:
        with self._lock:
            data = self._load()
            days = data["spend"].setdefault(self.mode_key, {})
            total = Decimal(days.get(day, "0")) + amount
            days[day] = format(total, "f")
            for old in sorted(days)[:-30]:
                del days[old]
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2))
            os.replace(tmp, self.path)
            return total


# --------------------------------------------------------------------------- orders


@dataclass(frozen=True)
class OrderInput:
    instrument_symbol: str
    outcome: str
    side: str
    quantity: str
    limit_price: str

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

    @property
    def action(self) -> str:
        return f"{self.side.upper()} {self.outcome.upper()} @ {format(self.price, 'f')}"


@dataclass
class PendingOrder:
    order: OrderInput
    digest: str
    created_at: float
    expires_at: float


def _to_decimal(name: str, value: Any) -> Decimal:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise Rejected(f"{name} must be a number")
    try:
        d = Decimal(str(value).strip())
    except InvalidOperation:
        raise Rejected(f"{name} must be a number, got {value!r}")
    if not d.is_finite():
        raise Rejected(f"{name} must be finite")
    return d


def _on_grid(value: Decimal, anchor: Decimal, step: Decimal) -> bool:
    return step > 0 and (value - anchor) % step == 0


def parse_order_input(instrument_symbol: Any, outcome: Any, side: Any, quantity: Any, limit_price: Any) -> OrderInput:
    if not isinstance(instrument_symbol, str) or not _SYMBOL_RE.match(instrument_symbol):
        raise Rejected("instrument_symbol is missing or malformed")
    if outcome not in ALLOWED_OUTCOMES:
        raise Rejected(f"outcome must be exactly 'yes' or 'no', got {outcome!r}")
    if side not in ALLOWED_SIDES:
        raise Rejected(f"side must be exactly 'buy' or 'sell', got {side!r}")
    if limit_price is None or (isinstance(limit_price, str) and limit_price.strip().lower() in ("", "market")):
        raise Rejected("a limit price is required; market orders are not supported")
    qty = _to_decimal("quantity", quantity)
    price = _to_decimal("limit_price", limit_price)
    if qty <= 0:
        raise Rejected("quantity must be greater than 0")
    if not (Decimal(0) < price < _ONE):
        raise Rejected("limit_price must be strictly between 0 and 1")
    return OrderInput(instrument_symbol, outcome, side, format(qty, "f"), format(price, "f"))


def order_cost(side: str, quantity: Decimal, price: Decimal) -> Decimal:
    """Worst-case dollars at risk: buys cost q*p; sells count q*(1-p)."""
    return quantity * price if side == "buy" else quantity * (_ONE - price)


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
        clock: Callable[[], float] = time.time,
    ):
        # Dry run must not hold a client that is able to place orders.
        if dry_run and trader is not None:
            raise ValueError("dry-run Guardrails must not be given a trading client")
        if not dry_run and trader is None:
            raise ValueError("live Guardrails requires a trading client")
        self.config_path = config_path
        self.kill_path = kill_path
        self.ledger = ledger
        self.audit = audit
        self.market = market
        self._trader = trader
        self.dry_run = dry_run
        self.env = env
        self._clock = clock
        self._pending: dict[str, PendingOrder] = {}
        self._used: set[str] = set()
        self._lock = threading.RLock()

    # ---- helpers

    @property
    def mode(self) -> str:
        if self.dry_run:
            return f"DRY RUN ({self.env}): nothing will be placed"
        if self.env == "production":
            return "LIVE (production): REAL MONEY"
        return "LIVE (sandbox): test funds"

    def kill_switch_active(self) -> bool:
        return os.path.lexists(self.kill_path)

    def _check_kill(self) -> None:
        if self.kill_switch_active():
            raise Rejected(f"kill switch is active ({self.kill_path.name} file exists); all order tools are disabled")

    def _today(self) -> str:
        return datetime.fromtimestamp(self._clock(), tz=timezone.utc).strftime("%Y-%m-%d")

    def _reject(self, action: str, reason: str, **fields: Any) -> dict[str, Any]:
        self.audit.write("rejection", action=action, reason=reason, mode=self.mode, **fields)
        return {"ok": False, "rejected": True, "reason": reason}

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

    def _held_quantity(self, symbol: str, outcome: str) -> Decimal:
        """Quantity of (symbol, outcome) available to sell. Anything unexpected rejects."""
        try:
            resp = self.market.get_positions()
        except Exception as e:  # noqa: BLE001
            raise Rejected(f"positions lookup failed, so the sell can't be checked: {e}")
        positions = resp.get("positions") if isinstance(resp, dict) else None
        if not isinstance(positions, list):
            raise Rejected("positions lookup returned an unexpected shape; rejecting sell")
        found = [p for p in positions if isinstance(p, dict) and p.get("symbol") == symbol and p.get("outcome") == outcome]
        if not found:
            return Decimal(0)
        if len(found) > 1:
            raise Rejected("positions lookup returned duplicate entries for this contract and outcome; rejecting sell")
        try:
            total = Decimal(str(found[0]["totalQuantity"]))
            on_hold = Decimal(str(found[0].get("quantityOnHold") or "0"))
        except (KeyError, InvalidOperation):
            raise Rejected("positions lookup returned an unparseable quantity; rejecting sell")
        if not total.is_finite() or not on_hold.is_finite():
            raise Rejected("positions lookup returned an unparseable quantity; rejecting sell")
        return total - on_hold

    def _open_order_count(self) -> int:
        try:
            resp = self.market.list_active_orders(limit=_ACTIVE_ORDERS_PAGE)
        except Exception as e:  # noqa: BLE001
            raise Rejected(f"couldn't count open orders: {e}")
        orders = resp.get("orders") if isinstance(resp, dict) else None
        if not isinstance(orders, list):
            raise Rejected("open-orders lookup returned an unexpected shape")
        return len(orders)

    def _validate(self, inp: OrderInput, config: Config) -> ValidatedOrder:
        qty = Decimal(inp.quantity)
        price = Decimal(inp.limit_price)
        event, contract = self._resolve_contract(inp.instrument_symbol, config)

        if event.get("status") != "active":
            raise Rejected(f"event {event.get('ticker')} status is {event.get('status')!r}, not 'active'")
        if contract.get("status") != "active":
            raise Rejected(f"contract status is {contract.get('status')!r}, not 'active'")
        if contract.get("marketState") != "open":
            raise Rejected(f"contract marketState is {contract.get('marketState')!r}, not 'open'")

        try:
            p_min = Decimal(str(contract["priceMinimum"]))
            p_inc = Decimal(str(contract["priceIncrement"]))
            q_min = Decimal(str(contract["quantityMinimum"]))
            q_inc = Decimal(str(contract["quantityIncrement"]))
        except (KeyError, InvalidOperation):
            raise Rejected("contract is missing price/quantity increments; can't validate the order")
        if price < p_min or not _on_grid(price, p_min, p_inc):
            raise Rejected(f"limit_price {price} is off the contract's price grid (min {p_min}, step {p_inc})")
        if qty < q_min or not _on_grid(qty, Decimal(0), q_inc):
            raise Rejected(f"quantity {qty} is off the contract's quantity grid (min {q_min}, step {q_inc})")

        held: Decimal | None = None
        if inp.side == "sell":
            held = self._held_quantity(inp.instrument_symbol, inp.outcome)
            if qty > held:
                raise Rejected(f"sell quantity {qty} exceeds the {held} {inp.outcome.upper()} contracts you hold")

        cost = order_cost(inp.side, qty, price)
        if cost > config.max_order_usd:
            raise Rejected(f"order worst-case cost ${cost} exceeds max_order_usd ${config.max_order_usd}")

        spent = self.ledger.spent_on(self._today())
        if spent + cost > config.max_daily_spend_usd:
            raise Rejected(
                f"daily cap: ${spent} already spent today (UTC) + ${cost} would exceed "
                f"max_daily_spend_usd ${config.max_daily_spend_usd}"
            )

        open_count = self._open_order_count()
        if open_count >= config.max_open_orders:
            raise Rejected(f"{open_count} open orders already; max_open_orders is {config.max_open_orders}")

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
            event_ticker=str(event.get("ticker")),
            event_title=str(event.get("title", "")),
            contract_label=str(contract.get("label", "")),
            best_bid=prices.get("bestBid"),
            best_ask=prices.get("bestAsk"),
            outcome_buy_price=buy.get(inp.outcome),
            outcome_sell_price=sell.get(inp.outcome),
            held_quantity=held,
        )

    # ---- public API

    def propose(self, instrument_symbol: Any, outcome: Any, side: Any, quantity: Any, limit_price: Any) -> dict[str, Any]:
        raw = {
            "instrument_symbol": instrument_symbol,
            "outcome": outcome,
            "side": side,
            "quantity": quantity,
            "limit_price": limit_price,
        }
        with self._lock:
            try:
                self._check_kill()
                inp = parse_order_input(instrument_symbol, outcome, side, quantity, limit_price)
                config = load_config(self.config_path)
                v = self._validate(inp, config)
            except Rejected as e:
                return self._reject("propose_order", str(e), request=raw)

            now = self._clock()
            self._pending = {t: p for t, p in self._pending.items() if p.expires_at > now}
            token = secrets.token_urlsafe(24)
            self._pending[token] = PendingOrder(inp, inp.digest(), now, now + TOKEN_TTL_SECONDS)
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
                },
            }
            if v.held_quantity is not None:
                preview["held_quantity"] = format(v.held_quantity, "f")
            self.audit.write(
                "proposal",
                token_id=inp.digest()[:12],
                mode=self.mode,
                trade=v.action,
                instrument_symbol=v.instrument_symbol,
                quantity=v.quantity,
                limit_price=v.price,
                worst_case_cost_usd=v.cost_usd,
                resolved_event_ticker=v.event_ticker,
            )
            return {
                "ok": True,
                "preview": preview,
                "confirmation_token": token,
                "token_expires_at": expires,
                "note": "Nothing has been placed. Call confirm_order with this token within 5 minutes to proceed.",
            }

    def confirm(self, token: Any) -> dict[str, Any]:
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
                self._check_kill()
                config = load_config(self.config_path)
                v = self._validate(pending.order, config)
            except Rejected as e:
                order = asdict(pending.order) if pending else None
                return self._reject("confirm_order", str(e), order=order)

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
            )
            self.audit.write("confirmation", **common)
            spent_total = self.ledger.add(self._today(), v.cost_usd)

            if self.dry_run:
                self.audit.write("would_place", spent_today_usd=spent_total, **common)
                return {
                    "ok": True,
                    "dry_run": True,
                    "message": f"DRY RUN: would have placed {v.action} x {format(v.quantity, 'f')} "
                    f"{v.instrument_symbol}. Nothing was sent to Gemini.",
                    "spent_today_usd": format(spent_total, "f"),
                }

            # Last-moment kill check, right before the real request.
            if self.kill_switch_active():
                reason = "kill switch activated during confirmation; order not placed"
                self.audit.write("rejection", action="confirm_order", reason=reason, **common)
                return {"ok": False, "rejected": True, "reason": reason}
            try:
                resp = self._trader.place_limit_order(v.instrument_symbol, v.side, v.outcome, v.quantity, v.price)
            except Exception as e:  # noqa: BLE001
                self.audit.write("placement_failed", error=str(e), **common)
                return {
                    "ok": False,
                    "error": str(e),
                    "note": "Placement failed or its outcome is unknown. It will NOT be retried. "
                    "Check list_open_orders before proposing again. The spend stays counted for today.",
                }
            order_id = resp.get("orderId") if isinstance(resp, dict) else None
            status = resp.get("status") if isinstance(resp, dict) else None
            self.audit.write("placement", order_id=order_id, status=status, spent_today_usd=spent_total, **common)
            return {"ok": True, "dry_run": False, "order_id": order_id, "status": status, "response": resp}

    def cancel(self, order_id: Any) -> dict[str, Any]:
        with self._lock:
            try:
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
            try:
                resp = self._trader.cancel_order(oid)
            except Exception as e:  # noqa: BLE001
                self.audit.write("cancel_failed", order_id=oid, error=str(e), mode=self.mode)
                return {"ok": False, "error": str(e)}
            self.audit.write("cancel", order_id=oid, response=resp, mode=self.mode)
            return {"ok": True, "dry_run": False, "response": resp}

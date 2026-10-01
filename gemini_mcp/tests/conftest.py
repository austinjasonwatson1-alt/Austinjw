import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from guardrails import AuditLog, Guardrails, PaperLedger, RiskState, SpendLedger  # noqa: E402
from decimal import Decimal  # noqa: E402

SYMBOL = "GEMI-FEDJAN26-DN25"
EVENT = "FEDJAN26"
T0 = 1_790_000_000.0  # 2026-09-21 UTC, a fixed point in time


def make_contract(symbol=SYMBOL, **over):
    c = {
        "instrumentSymbol": symbol,
        "label": "Fed cuts >= 25bp",
        "status": "active",
        "marketState": "open",
        "priceMinimum": "0.01",
        "priceIncrement": "0.01",
        "quantityMinimum": "1",
        "quantityIncrement": "1",
        "prices": {
            "buy": {"yes": "0.66", "no": "0.36"},
            "sell": {"yes": "0.64", "no": "0.34"},
            "bestBid": "0.64",
            "bestAsk": "0.66",
            "lastTradePrice": "0.65",
        },
    }
    c.update(over)
    return c


def make_event(ticker=EVENT, contracts=None, **over):
    e = {"ticker": ticker, "title": "Fed January meeting", "status": "active",
         "contracts": contracts if contracts is not None else [make_contract()]}
    e.update(over)
    return e


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


class FakeMarket:
    def __init__(self):
        self.events = {EVENT: make_event()}
        self.failing_events = set()
        self.positions = {"positions": []}
        self.positions_error = None
        self.active = {"orders": []}
        self.active_error = None
        self.balances = [{"type": "exchange", "currency": "USD", "amount": "1000", "available": "1000"}]
        self.balances_error = None
        self.book = {"bids": [["0.60", "500"]], "asks": [["0.62", "500"]]}

    def get_order_book(self, symbol, depth=20):
        return copy.deepcopy({"symbol": symbol, **self.book})

    def get_balances(self):
        if self.balances_error:
            raise self.balances_error
        return copy.deepcopy(self.balances)

    def get_event(self, ticker):
        if ticker in self.failing_events:
            raise RuntimeError("HTTP 503 Service temporarily unavailable")
        if ticker not in self.events:
            raise RuntimeError(f"HTTP 404 event {ticker} not found")
        return copy.deepcopy(self.events[ticker])

    def get_positions(self, **params):
        if self.positions_error:
            raise self.positions_error
        return copy.deepcopy(self.positions)

    def list_active_orders(self, limit=100, offset=0):
        if self.active_error:
            raise self.active_error
        return copy.deepcopy(self.active)


class FakeTrader:
    def __init__(self):
        self.placed = []
        self.cancelled = []

    def place_limit_order(self, symbol, side, outcome, quantity, price):
        self.placed.append((symbol, side, outcome, quantity, price))
        return {"orderId": 1000 + len(self.placed), "status": "open"}

    def cancel_order(self, order_id):
        self.cancelled.append(order_id)
        return {"result": "ok"}


def write_config(path, **over):
    cfg = {"max_order_usd": 10, "max_daily_spend_usd": 25, "max_open_orders": 3,
           "allowed_event_tickers": [EVENT]}
    cfg.update(over)
    import yaml
    path.write_text(yaml.safe_dump(cfg))


@pytest.fixture
def env(tmp_path):
    """Builds Guardrails wired to fakes. Call env.guard(dry_run=...) to get one."""

    class Env:
        clock = Clock()
        market = FakeMarket()
        trader = FakeTrader()
        config_path = tmp_path / "config.yaml"
        kill_path = tmp_path / "KILL"
        audit_path = tmp_path / "audit.log"
        ledger_path = tmp_path / "state" / "daily_spend.json"
        risk_path = tmp_path / "state" / "risk_state.json"
        paper_path = tmp_path / "paper_ledger.json"

        def paper(self, bankroll="100"):
            return PaperLedger(self.paper_path, Decimal(bankroll), clock=self.clock)

        def guard(self, dry_run=False, mode_key=None, env_name="sandbox", bankroll="100"):
            key = mode_key or f"{env_name}:{'dry_run' if dry_run else 'live'}"
            return Guardrails(
                config_path=self.config_path,
                kill_path=self.kill_path,
                ledger=SpendLedger(self.ledger_path, key),
                audit=AuditLog(self.audit_path, clock=self.clock),
                market=self.market,
                trader=None if dry_run else self.trader,
                dry_run=dry_run,
                env=env_name,
                risk_state=RiskState(self.risk_path, key),
                paper=self.paper(bankroll) if dry_run else None,
                clock=self.clock,
            )

        def audit(self):
            if not self.audit_path.exists():
                return []
            return [json.loads(line) for line in self.audit_path.read_text().splitlines()]

    e = Env()
    write_config(e.config_path)
    return e

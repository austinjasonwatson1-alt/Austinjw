"""A local, stateful fake of Gemini's prediction-markets API for tests. It never touches the network.

It plugs into the real client code through httpx.MockTransport (REST) and a fake ``ws_connect`` (order-book
stream). That way the real signing, path checks, parsing and guardrails all run. Response shapes follow
Gemini's docs (developer.gemini.com/prediction-markets-spec, checked 2026-10-01):

  POST /v1/balances                              [{"type", "currency", "amount", "available", ...}]
  POST /v1/prediction-markets/positions          {"positions": [{symbol, outcome, totalQuantity, quantityOnHold,
                                                   avgPrice, marketValue, contractMetadata{...}}]}
  POST /v1/prediction-markets/orders/active      {"orders": [order objects]}
  POST /v1/prediction-markets/orders/history     {"orders": [filled / cancelled order objects]}
  POST /v1/prediction-markets/order              order object (status "open" / "filled")
  POST /v1/prediction-markets/order/cancel       {"result": "ok", "message": "Order N cancelled successfully"}
  GET  /v1/prediction-markets/events[/{ticker}]  {"data": [...], "pagination": {...}} / event object
  WS   {symbol}@depth{N}                         {"lastUpdateId", "bids": [[p, q]], "asks": [[p, q]]}

Behavior:
- **Signed requests:** checks the API key, the HMAC-SHA384 signature, that the payload's "request" equals the
  path, and that nonces strictly increase per key, the way Gemini does. Failures get 400
  {"result": "error", ...}.
- **Fills:** per-symbol modes. "rest" leaves the order open, "fill" fills it at the limit, "partial:N" fills N
  and rests the rest, "reject:Reason" returns 400. Call ``fill(order_id, qty)`` to fill a resting order later.
- **Faults:** ``fail_next(match, kind, times)`` injects one of the kinds below. A match starting with "/" must equal
  the request path exactly; any other match is a substring (of the path, or of the WebSocket stream for
  "book_timeout"):
  - "503" or "status:<code>": an error status.
  - "timeout": raises before anything is applied.
  - "timeout_after_apply": applies the request, then raises (the response is lost).
  - "malformed": a 200 whose body isn't JSON.
  - "missing:<field>": drops the field from every object in the response.
  - "set:<field>=<json>": overwrites the field in every object.
  - "book_timeout": the WebSocket order book never answers.
- **Shared state:** with ``state_path``, state lives in a JSON file under an flock, so several processes can share
  one fake exchange.
- **Request log:** every request is recorded as (method, raw path, host) in ``self.requests``, and every WebSocket
  stream in ``self.ws_streams``. Requests the client refuses never reach the fake, so they aren't recorded.
"""

from __future__ import annotations

import base64
import contextlib
import copy
import fcntl
import hashlib
import hmac
import json
import re
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx

HOSTS = {"sandbox": "api.sandbox.gemini.com", "production": "api.gemini.com"}
WS_HOSTS = {"sandbox": "wss://ws.sandbox.gemini.com", "production": "wss://ws.gemini.com"}
EVENTS = "/v1/prediction-markets/events"
TEST_KEY, TEST_SECRET = "account-TESTKEY000", "TESTSECRET000"


def D(x: Any) -> Decimal:
    return Decimal(str(x))


def fmt(d: Decimal) -> str:
    s = format(d.normalize(), "f")
    return s if s not in ("-0",) else "0"


def contract(symbol: str, label: str, bid: str, ask: str, expiry: str = "2027-01-31T00:00:00Z", **over: Any) -> dict:
    """A contract in Gemini's event shape. YES bid/ask; NO prices are complements."""
    b, a = D(bid), D(ask)
    c = {"instrumentSymbol": symbol, "label": label, "status": "active", "marketState": "open",
         "priceMinimum": "0.01", "priceIncrement": "0.01", "quantityMinimum": "1", "quantityIncrement": "1",
         "expiryDate": expiry, "description": f"Resolves YES if {label}.", "termsAndConditionsUrl": None,
         "resolutionSide": None, "settlementValue": None,
         "prices": {"bestBid": bid, "bestAsk": ask, "lastTradePrice": fmt((b + a) / 2),
                    "buy": {"yes": ask, "no": fmt(1 - b)}, "sell": {"yes": bid, "no": fmt(1 - a)}}}
    c.update(over)
    return c


def event(ticker: str, title: str, contracts: list[dict], category: str = "Economics", **over: Any) -> dict:
    e = {"ticker": ticker, "title": title, "description": f"{title}. Settles per the terms.", "status": "active",
         "type": "binary", "category": category, "expiryDate": "2027-01-31T00:00:00Z", "resolvedAt": None,
         "termsLink": None, "contracts": contracts, "events": []}
    e.update(over)
    return e


def default_state(cash: str = "1000") -> dict:
    return {
        "events": {
            "FEDJAN26": event("FEDJAN26", "Fed January 2026 meeting", [
                contract("GEMI-FEDJAN26-DN25", "Fed cuts by 25bp", "0.60", "0.62"),
                contract("GEMI-FEDJAN26-HOLD", "Fed holds", "0.30", "0.32")]),
            "NBAFINALS": event("NBAFINALS", "NBA Finals winner", [
                contract("GEMI-NBAFINALS-BOS", "Boston wins", "0.40", "0.42")], category="Sports"),
        },
        "books": {
            "GEMI-FEDJAN26-DN25": {"bids": [["0.60", "500"], ["0.59", "800"]], "asks": [["0.62", "500"], ["0.63", "900"]]},
            "GEMI-FEDJAN26-HOLD": {"bids": [["0.30", "400"]], "asks": [["0.32", "400"]]},
            "GEMI-NBAFINALS-BOS": {"bids": [["0.40", "300"]], "asks": [["0.42", "300"]]},
        },
        "cash": cash, "positions": {}, "orders": {}, "next_order_id": 73100000001,
        "fill_mode": {}, "faults": [], "nonces": {}, "requests": [], "ws_streams": [],
        "keys": {TEST_KEY: TEST_SECRET},
    }


class FakeTimeout(httpx.ReadTimeout):
    pass


class FakeGemini:
    def __init__(self, env: str = "sandbox", state_path: Path | None = None, cash: str = "1000",
                 strict_nonce: bool = True):
        self.env, self.host = env, HOSTS[env]
        self.state_path = state_path
        self.strict_nonce = strict_nonce
        self._mem = default_state(cash)
        if state_path is not None and not state_path.exists():
            state_path.write_text(json.dumps(self._mem))

    # ---------------------------------------------------------------- state plumbing

    @contextlib.contextmanager
    def state(self):
        if self.state_path is None:
            yield self._mem
            return
        with open(self.state_path.with_name(self.state_path.name + ".lock"), "a") as lf:
            fcntl.flock(lf, fcntl.LOCK_EX)
            st = json.loads(self.state_path.read_text())
            try:
                yield st
            finally:  # also persist when a fault raises after the request was applied
                self.state_path.write_text(json.dumps(st))

    def snapshot(self) -> dict:
        with self.state() as st:
            return copy.deepcopy(st)

    @property
    def requests(self) -> list[tuple[str, str, str]]:
        return [tuple(r) for r in self.snapshot()["requests"]]

    @property
    def ws_streams(self) -> list[str]:
        return self.snapshot()["ws_streams"]

    # ---------------------------------------------------------------- test controls

    def set_fill_mode(self, symbol: str, mode: str) -> None:
        with self.state() as st:
            st["fill_mode"][symbol] = mode

    def fail_next(self, path_substring: str, kind: str, times: int = 1) -> None:
        with self.state() as st:
            st["faults"].append({"match": path_substring, "kind": kind, "times": times})

    def set_cash(self, amount: str) -> None:
        with self.state() as st:
            st["cash"] = amount

    def set_book(self, symbol: str, bid: str, ask: str, depth: str = "500") -> None:
        """Move a contract's quote (event prices and book together)."""
        with self.state() as st:
            st["books"][symbol] = {"bids": [[bid, depth]], "asks": [[ask, depth]]}
            for ev in st["events"].values():
                for i, c in enumerate(ev["contracts"]):
                    if c["instrumentSymbol"] == symbol:
                        ev["contracts"][i] = contract(symbol, c["label"], bid, ask, c["expiryDate"])

    def add_key(self, key: str, secret: str) -> None:
        with self.state() as st:
            st["keys"][key] = secret

    def fill(self, order_id: int, qty: str | None = None) -> None:
        with self.state() as st:
            o = st["orders"][str(order_id)]
            self._apply_fill(st, o, D(qty) if qty is not None else D(o["remainingQuantity"]))

    def open_orders(self) -> list[dict]:
        return [o for o in self.snapshot()["orders"].values() if o["status"] == "open"]

    # ---------------------------------------------------------------- exchange logic

    def _contract(self, st: dict, symbol: str) -> tuple[dict, dict] | None:
        for ev in st["events"].values():
            for c in ev["contracts"]:
                if c["instrumentSymbol"] == symbol:
                    return ev, c
        return None

    def _meta(self, st: dict, symbol: str) -> dict:
        ev, c = self._contract(st, symbol)
        return {"contractId": symbol, "contractName": c["label"], "contractTicker": symbol.split("-")[-1],
                "eventTicker": ev["ticker"], "eventName": ev["title"], "category": ev["category"],
                "contractStatus": c["status"], "imageUrl": None, "expiryDate": c["expiryDate"],
                "resolvedAt": None, "description": c["description"]}

    def _reserved(self, st: dict) -> Decimal:
        return sum((D(o["remainingQuantity"]) * D(o["price"]) for o in st["orders"].values()
                    if o["status"] == "open" and o["side"] == "buy"), Decimal(0))

    def _apply_fill(self, st: dict, o: dict, qty: Decimal) -> None:
        qty = min(qty, D(o["remainingQuantity"]))
        if qty <= 0:
            return
        price = D(o["price"])
        key = f"{o['symbol']}|{o['outcome']}"
        pos = st["positions"].get(key) or {"symbol": o["symbol"], "outcome": o["outcome"],
                                           "totalQuantity": "0", "cost": "0"}
        total, cost = D(pos["totalQuantity"]), D(pos["cost"])
        if o["side"] == "buy":
            st["cash"] = fmt(D(st["cash"]) - qty * price)
            total, cost = total + qty, cost + qty * price
        else:
            st["cash"] = fmt(D(st["cash"]) + qty * price)
            cost = cost * (total - qty) / total if total else Decimal(0)
            total -= qty
        if total > 0:
            st["positions"][key] = {**pos, "totalQuantity": fmt(total), "cost": fmt(cost)}
        else:
            st["positions"].pop(key, None)
        filled = D(o["filledQuantity"]) + qty
        prev_avg = D(o["avgExecutionPrice"] or 0)
        o["avgExecutionPrice"] = fmt((prev_avg * D(o["filledQuantity"]) + price * qty) / filled)
        o["filledQuantity"] = fmt(filled)
        o["remainingQuantity"] = fmt(D(o["quantity"]) - filled)
        if D(o["remainingQuantity"]) == 0:
            o["status"] = "filled"

    def _place(self, st: dict, p: dict) -> tuple[int, Any]:
        for f in ("symbol", "orderType", "side", "quantity", "price", "outcome", "timeInForce"):
            if f not in p:
                return 400, {"result": "error", "reason": "MissingField", "message": f"{f} is required"}
        if p["orderType"] != "limit" or p["side"] not in ("buy", "sell") or p["outcome"] not in ("yes", "no"):
            return 400, {"result": "error", "reason": "InvalidOrder", "message": "bad order"}
        if self._contract(st, p["symbol"]) is None:
            return 400, {"result": "error", "reason": "InvalidSymbol", "message": p["symbol"]}
        mode = st["fill_mode"].get(p["symbol"], "rest")
        if mode.startswith("reject:"):
            return 400, {"result": "error", "reason": mode.split(":", 1)[1], "message": "order rejected"}
        qty, price = D(p["quantity"]), D(p["price"])
        if p["side"] == "buy" and qty * price > D(st["cash"]) - self._reserved(st):
            return 400, {"result": "error", "reason": "InsufficientFunds", "message": "insufficient funds"}
        if p["side"] == "sell":
            held = D((st["positions"].get(f"{p['symbol']}|{p['outcome']}") or {}).get("totalQuantity", "0"))
            committed = sum((D(o["remainingQuantity"]) for o in st["orders"].values()
                             if o["status"] == "open" and o["side"] == "sell" and o["symbol"] == p["symbol"]
                             and o["outcome"] == p["outcome"]), Decimal(0))
            if qty > held - committed:
                return 400, {"result": "error", "reason": "InsufficientPosition", "message": "not enough held"}
        oid = st["next_order_id"]
        st["next_order_id"] += 1
        o = {"orderId": oid, "status": "open", "symbol": p["symbol"], "side": p["side"], "outcome": p["outcome"],
             "orderType": "limit", "quantity": p["quantity"], "filledQuantity": "0",
             "remainingQuantity": p["quantity"], "price": p["price"], "avgExecutionPrice": None,
             "createdAt": "2026-09-21T12:00:00.000Z", "updatedAt": "2026-09-21T12:00:00.000Z",
             "cancelledAt": None}
        st["orders"][str(oid)] = o
        n_open = sum(1 for x in st["orders"].values() if x["status"] == "open")
        st["max_open_seen"] = max(st.get("max_open_seen", 0), n_open)  # high-water mark, before any fill
        if mode == "fill":
            self._apply_fill(st, o, qty)
        elif mode.startswith("partial:"):
            self._apply_fill(st, o, D(mode.split(":", 1)[1]))
        return 200, {k: v for k, v in o.items()}

    def _positions(self, st: dict) -> list[dict]:
        out = []
        for key, pos in st["positions"].items():
            sym, outc = key.split("|")
            _, c = self._contract(st, sym)
            on_hold = sum((D(o["remainingQuantity"]) for o in st["orders"].values()
                           if o["status"] == "open" and o["side"] == "sell" and o["symbol"] == sym
                           and o["outcome"] == outc), Decimal(0))
            total = D(pos["totalQuantity"])
            sell = c["prices"]["sell"].get(outc)
            p = {"symbol": sym, "outcome": outc, "totalQuantity": pos["totalQuantity"], "quantityOnHold": fmt(on_hold),
                 "avgPrice": fmt(D(pos["cost"]) / total), "contractMetadata": self._meta(st, sym)}
            if sell is not None:
                p["marketValue"] = fmt(total * D(sell))
            out.append(p)
        return out

    def _order_view(self, st: dict, o: dict) -> dict:
        return {**o, "contractMetadata": self._meta(st, o["symbol"])}

    # ---------------------------------------------------------------- HTTP

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.raw_path.decode().split("?", 1)[0]
        with self.state() as st:
            st["requests"].append([request.method, request.url.raw_path.decode(), request.url.host])
            fault = None
            for f in st["faults"]:
                hit = path == f["match"] if f["match"].startswith("/") else f["match"] in path
                if f["times"] > 0 and hit and f["kind"] != "book_timeout":
                    f["times"] -= 1
                    fault = f["kind"]
                    break
            if fault == "timeout":
                raise FakeTimeout("read timed out", request=request)
            if fault == "503":
                return httpx.Response(503, text="Service temporarily unavailable", request=request)
            if fault and fault.startswith("status:"):
                return httpx.Response(int(fault.split(":")[1]), json={"result": "error", "reason": "Injected"},
                                      request=request)
            if request.url.host != self.host:
                return httpx.Response(421, text="misdirected", request=request)
            status, body = self._route(st, request, path)
            if fault == "timeout_after_apply":
                raise FakeTimeout("read timed out after the request was applied", request=request)
        if fault == "malformed":
            return httpx.Response(200, text='{"orders": [ {"orderId": 1, ', request=request)
        if fault and fault.startswith("missing:"):
            body = _drop_field(body, fault.split(":", 1)[1])
        if fault and fault.startswith("set:"):
            field, raw = fault.split(":", 1)[1].split("=", 1)
            body = _set_field(body, field, json.loads(raw))
        return httpx.Response(status, json=body, request=request)

    def _auth(self, st: dict, request: httpx.Request, path: str) -> tuple[int, Any] | None:
        key = request.headers.get("X-GEMINI-APIKEY")
        b64 = request.headers.get("X-GEMINI-PAYLOAD", "")
        sig = request.headers.get("X-GEMINI-SIGNATURE", "")
        secret = st["keys"].get(key)
        if secret is None:
            return 400, {"result": "error", "reason": "InvalidApiKey", "message": "unknown key"}
        want = hmac.new(secret.encode(), b64.encode(), hashlib.sha384).hexdigest()
        if not hmac.compare_digest(want, sig):
            return 400, {"result": "error", "reason": "InvalidSignature", "message": "bad signature"}
        try:
            payload = json.loads(base64.b64decode(b64))
        except ValueError:
            return 400, {"result": "error", "reason": "InvalidPayload", "message": "bad payload"}
        if payload.get("request") != path:
            return 400, {"result": "error", "reason": "InvalidPayload", "message": "request != path"}
        nonce = int(payload.get("nonce", 0))
        if self.strict_nonce and nonce <= st["nonces"].get(key, 0):
            return 400, {"result": "error", "reason": "InvalidNonce", "message": "nonce must increase"}
        st["nonces"][key] = max(nonce, st["nonces"].get(key, 0))
        request.extensions["payload"] = payload
        return None

    def _route(self, st: dict, request: httpx.Request, path: str) -> tuple[int, Any]:
        if request.method == "GET":
            if path == EVENTS:
                return 200, {"data": list(st["events"].values()), "pagination": {"limit": 20, "offset": 0}}
            m = re.fullmatch(EVENTS + r"/([^/]+)", path)
            if m and m.group(1) in st["events"]:
                return 200, st["events"][m.group(1)]
            return 404, {"result": "error", "reason": "NotFound", "message": path}
        if request.method != "POST":
            return 405, {"result": "error", "reason": "MethodNotAllowed"}
        denied = self._auth(st, request, path)
        if denied:
            return denied
        p = request.extensions["payload"]
        if path == "/v1/balances":
            cash = D(st["cash"])
            return 200, [{"type": "exchange", "currency": "USD", "amount": fmt(cash),
                          "available": fmt(cash - self._reserved(st)), "availableForWithdrawal": fmt(cash)}]
        if path == "/v1/prediction-markets/positions":
            return 200, {"positions": self._positions(st)}
        if path == "/v1/prediction-markets/orders/active":
            opn = [self._order_view(st, o) for o in st["orders"].values() if o["status"] == "open"]
            off, lim = int(p.get("offset", 0)), int(p.get("limit", 100))
            return 200, {"orders": opn[off:off + lim]}
        if path == "/v1/prediction-markets/orders/history":
            done = [self._order_view(st, o) for o in st["orders"].values() if o["status"] != "open"]
            off, lim = int(p.get("offset", 0)), int(p.get("limit", 1000))
            return 200, {"orders": done[off:off + lim]}
        if path == "/v1/prediction-markets/order":
            return self._place(st, p)
        if path == "/v1/prediction-markets/order/cancel":
            o = st["orders"].get(str(p.get("orderId")))
            if o is None or o["status"] != "open":
                return 400, {"result": "error", "reason": "OrderNotFound", "message": f"order {p.get('orderId')}"}
            o["status"], o["cancelledAt"] = "cancelled", "2026-09-21T12:05:00.000Z"
            return 200, {"result": "ok", "message": f"Order {o['orderId']} cancelled successfully"}
        return 404, {"result": "error", "reason": "NotFound", "message": path}

    # ---------------------------------------------------------------- WebSocket order book

    def ws_connect(self, url: str, **_: Any) -> "_FakeWS":
        if url != WS_HOSTS[self.env]:
            raise ConnectionError(f"fake: unexpected ws host {url}")
        return _FakeWS(self)


class _FakeWS:
    def __init__(self, fake: FakeGemini):
        self.fake, self.pending = fake, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def send(self, raw: str) -> None:
        msg = json.loads(raw)
        stream = msg["params"][0]
        with self.fake.state() as st:
            st["ws_streams"].append(stream)
            fault = None
            for f in st["faults"]:
                if f["times"] > 0 and f["kind"] == "book_timeout" and f["match"] in stream:
                    f["times"] -= 1
                    fault = "book_timeout"
            sym = stream.split("@", 1)[0]
            book = st["books"].get(sym)
        if fault:
            return
        self.pending.append({"result": None, "id": msg["id"]})
        if book is not None:
            self.pending.append({"lastUpdateId": 1, "bids": book["bids"], "asks": book["asks"]})

    def recv(self, timeout: float | None = None) -> str:
        if not self.pending:
            raise TimeoutError("fake: no message")
        return json.dumps(self.pending.pop(0))


def _drop_field(body: Any, field: str) -> Any:
    if isinstance(body, dict):
        return {k: _drop_field(v, field) for k, v in body.items() if k != field}
    if isinstance(body, list):
        return [_drop_field(v, field) for v in body]
    return body


def _set_field(body: Any, field: str, value: Any) -> Any:
    if isinstance(body, dict):
        return {k: (value if k == field else _set_field(v, field, value)) for k, v in body.items()}
    if isinstance(body, list):
        return [_set_field(v, field, value) for v in body]
    return body


# -------------------------------------------------------------------- wiring helpers


class StepClock:
    """Deterministic nonce clock: every call advances one second, so nonces strictly increase without sleeping."""

    def __init__(self, start: int = 1_790_000_000):
        self.t = start

    def __call__(self) -> float:
        self.t += 1
        return float(self.t)


def clients(fake: FakeGemini, *, live: bool, key: str = TEST_KEY, secret: str = TEST_SECRET,
            nonce_start: int = 1_790_000_000):
    """(market, trader) real clients wired to the fake. trader is None unless live."""
    from gemini_client import NonceGenerator, ReadOnlyClient, TradingClient

    nonces = NonceGenerator(clock=StepClock(nonce_start), sleep=lambda s: None)
    kw = dict(transport=fake.transport(), nonces=nonces, ws_connect=fake.ws_connect)
    market = ReadOnlyClient(fake.env, key, secret, **kw)
    trader = TradingClient(fake.env, key, secret, **kw) if live else None
    return market, trader


def guard_for(tmp: Path, fake: FakeGemini, *, live: bool, clock: Any = None, config: dict | None = None,
              key: str = TEST_KEY, secret: str = TEST_SECRET, nonce_start: int = 1_790_000_000):
    """A real Guardrails over real clients talking to the fake. State files live under tmp."""
    import yaml

    from guardrails import AuditLog, Guardrails, PaperLedger, RiskState, SpendLedger

    cfg_path = tmp / "config.yaml"
    if config is not None or not cfg_path.exists():
        base = {"max_order_usd": 10, "max_daily_spend_usd": 25, "max_open_orders": 3, "max_trades_per_day": 5,
                "allowed_event_tickers": ["FEDJAN26", "NBAFINALS"]}
        cfg_path.write_text(yaml.safe_dump({**base, **(config or {})}))
    market, trader = clients(fake, live=live, key=key, secret=secret, nonce_start=nonce_start)
    mode_key = f"{fake.env}:{'live' if live else 'dry_run'}"
    kw = {} if clock is None else {"clock": clock}
    guard = Guardrails(
        config_path=cfg_path, kill_path=tmp / "KILL",
        ledger=SpendLedger(tmp / "state" / "daily_spend.json", mode_key),
        audit=AuditLog(tmp / "audit.log", redact=market.secrets(), **kw),
        market=market, trader=trader, dry_run=not live, env=fake.env,
        risk_state=RiskState(tmp / "state" / "risk_state.json", mode_key),
        paper=None if live else PaperLedger(tmp / "paper_ledger.json", Decimal("100"), **kw), **kw)
    return market, guard

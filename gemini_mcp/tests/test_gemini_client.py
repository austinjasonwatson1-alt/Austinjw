import asyncio
import base64
import hashlib
import hmac
import json

import httpx
import pytest

from conftest import EVENT, SYMBOL, Clock, make_event, write_config
from gemini_client import (
    CANCEL_ORDER_PATH,
    PLACE_ORDER_PATH,
    GeminiAPIError,
    NonceGenerator,
    PathNotAllowed,
    ReadOnlyClient,
    TradingClient,
    build_auth_headers,
    encode_payload,
    sign,
)
from decimal import Decimal

from guardrails import AuditLog, Guardrails, PaperLedger, RiskState, SpendLedger

KEY = "account-TESTKEY000"
SECRET = "test-secret-1234abcd"

# Test vector computed independently with the CLI, not with this code:
#   printf '%s' "$P" | base64 -w0
#   printf '%s' "$B64" | openssl dgst -sha384 -hmac 'test-secret-1234abcd'
VECTOR_PAYLOAD = {"request": "/v1/prediction-markets/positions", "nonce": "1776294447"}
VECTOR_B64 = "eyJyZXF1ZXN0IjoiL3YxL3ByZWRpY3Rpb24tbWFya2V0cy9wb3NpdGlvbnMiLCJub25jZSI6IjE3NzYyOTQ0NDcifQ=="
VECTOR_SIG = (
    "6ea1dba99c1bbaafcdf0f0d81f832182ec44a2bba73f17c74c4f5cf8daffcae9"
    "c48a25031d9d455718b53568a42be688"
)


# --------------------------------------------------------------- signing & nonces


def test_signing_matches_fixed_vector():
    b64 = encode_payload(VECTOR_PAYLOAD)
    assert b64.decode() == VECTOR_B64
    assert sign(b64, SECRET) == VECTOR_SIG


def test_auth_headers_follow_gemini_spec():
    h = build_auth_headers(KEY, SECRET, VECTOR_PAYLOAD)
    assert h["X-GEMINI-APIKEY"] == KEY
    assert h["X-GEMINI-PAYLOAD"] == VECTOR_B64
    assert h["X-GEMINI-SIGNATURE"] == VECTOR_SIG
    assert h["Content-Type"] == "text/plain" and h["Content-Length"] == "0"
    assert h["Cache-Control"] == "no-cache"
    assert SECRET not in json.dumps(h)


def test_nonces_strictly_increase_even_within_one_second():
    clock = Clock(1_776_294_447.2)
    slept = []

    def sleep(s):
        slept.append(s)
        clock.t += s

    gen = NonceGenerator(clock=clock, sleep=sleep)
    nonces = [gen.next() for _ in range(5)]
    assert all(b > a for a, b in zip(nonces, nonces[1:]))
    assert nonces[0] == 1_776_294_447
    assert len(slept) == 4
    assert abs(nonces[-1] - clock.t) < 1  # waited instead of running ahead of the clock


def test_nonces_survive_clock_going_backwards():
    clock = Clock(1_776_294_447.0)
    gen = NonceGenerator(clock=clock, sleep=lambda s: setattr(clock, "t", clock.t + max(s, 0)))
    a = gen.next()
    clock.t -= 5
    b = gen.next()
    assert b > a


# --------------------------------------------------------------- mock Gemini


class MockGemini:
    """Records every HTTP request. Serves just enough for the order flow."""

    def __init__(self):
        self.requests = []

    def paths(self):
        return [r["path"] for r in self.requests]

    def handler(self, request: httpx.Request) -> httpx.Response:
        rec = {"method": request.method, "path": request.url.path, "body": request.content, "payload": None}
        if request.method == "POST":
            b64 = request.headers["X-GEMINI-PAYLOAD"]
            rec["payload"] = json.loads(base64.b64decode(b64))
            expected = hmac.new(SECRET.encode(), b64.encode(), hashlib.sha384).hexdigest()
            rec["sig_ok"] = request.headers["X-GEMINI-SIGNATURE"] == expected
        self.requests.append(rec)
        p = request.url.path
        if p == f"/v1/prediction-markets/events/{EVENT}":
            return httpx.Response(200, json=make_event())
        if p == "/v1/balances":
            return httpx.Response(200, json=[{"type": "exchange", "currency": "USD", "amount": "500",
                                              "available": "500"}])
        if p == "/v1/prediction-markets/positions":
            return httpx.Response(200, json={"positions": []})
        if p == "/v1/prediction-markets/orders/active":
            return httpx.Response(200, json={"orders": [], "pagination": {"count": 0}})
        if p == "/v1/prediction-markets/orders/history":
            return httpx.Response(200, json={"orders": [{"orderId": 77, "status": "filled"}]})
        if p == PLACE_ORDER_PATH:
            return httpx.Response(201, json={"orderId": 555, "status": "open"})
        if p == CANCEL_ORDER_PATH:
            return httpx.Response(200, json={"result": "ok"})
        return httpx.Response(404, json={"error": "NotFound"})


def clients(mock, trading=False):
    nonces = NonceGenerator(clock=Clock(), sleep=lambda s: None)
    nonces._clock = _ticking()
    transport = httpx.MockTransport(mock.handler)
    market = ReadOnlyClient("sandbox", KEY, SECRET, transport=transport, nonces=nonces)
    trader = TradingClient("sandbox", KEY, SECRET, transport=transport, nonces=nonces) if trading else None
    return market, trader


def _ticking():
    t = [1_776_294_447.0]

    def clock():
        t[0] += 1
        return t[0]

    return clock


# --------------------------------------------------------------- dry run: placement unreachable


def build_stack(tmp_path, mock, dry_run):
    import server

    write_config(tmp_path / "config.yaml")
    market, trader = clients(mock, trading=not dry_run)
    guard = Guardrails(
        config_path=tmp_path / "config.yaml",
        kill_path=tmp_path / "KILL",
        ledger=SpendLedger(tmp_path / "ledger.json", "sandbox:x"),
        audit=AuditLog(tmp_path / "audit.log", redact=market.secrets()),
        market=market,
        trader=trader,
        dry_run=dry_run,
        env="sandbox",
        risk_state=RiskState(tmp_path / "risk.json", "sandbox:x"),
        paper=PaperLedger(tmp_path / "paper.json", Decimal("100")) if dry_run else None,
    )
    return server.create_server(market, guard), guard


def call(mcp, name, args):
    _, structured = asyncio.run(mcp.call_tool(name, args))
    return structured.get("result", structured) if isinstance(structured, dict) else structured


def test_dry_run_never_sends_order_or_cancel_requests(tmp_path):
    mock = MockGemini()
    mcp, guard = build_stack(tmp_path, mock, dry_run=True)

    prop = call(mcp, "propose_order", {"instrument_symbol": SYMBOL, "outcome": "no", "side": "buy",
                                       "quantity": "2", "limit_price": "0.35"})
    assert prop["ok"], prop
    assert prop["preview"]["action"] == "BUY NO @ 0.35"
    conf = call(mcp, "confirm_order", {"token": prop["confirmation_token"]})
    assert conf["ok"] and conf["dry_run"]
    assert call(mcp, "cancel_order", {"order_id": 555})["dry_run"]

    assert mock.requests, "reads should still hit the mock"
    assert PLACE_ORDER_PATH not in mock.paths()
    assert CANCEL_ORDER_PATH not in mock.paths()
    assert guard._trader is None


def test_read_only_client_cannot_reach_order_endpoints(tmp_path):
    mock = MockGemini()
    market, _ = clients(mock)
    assert not hasattr(market, "place_limit_order")
    assert not hasattr(market, "cancel_order")
    for path in (PLACE_ORDER_PATH, CANCEL_ORDER_PATH, "/v1/withdraw/btc", "/v1/account/transfer/usd"):
        with pytest.raises(PathNotAllowed):
            market._private_post(path, {})
    assert mock.requests == []


def test_trading_client_has_no_withdraw_or_transfer_paths():
    for path in TradingClient.PRIVATE_PATHS:
        assert "withdraw" not in path and "transfer" not in path
    assert TradingClient.PRIVATE_PATHS - ReadOnlyClient.PRIVATE_PATHS == {PLACE_ORDER_PATH, CANCEL_ORDER_PATH}


def test_server_build_in_dry_run_has_no_trading_client(monkeypatch):
    import server

    market, guard = server.build({"DRY_RUN": "true", "GEMINI_API_KEY": KEY, "GEMINI_API_SECRET": SECRET})
    assert type(market) is ReadOnlyClient
    assert guard._trader is None and guard.dry_run
    market, guard = server.build({})
    assert guard.dry_run and guard.env == "sandbox" and guard._trader is None
    market, guard = server.build({"DRY_RUN": "false", "GEMINI_API_KEY": KEY, "GEMINI_API_SECRET": SECRET})
    assert isinstance(guard._trader, TradingClient) and guard.env == "sandbox"


# --------------------------------------------------------------- live path payloads


def test_live_order_payload_is_signed_limit_gtc_with_empty_body(tmp_path):
    mock = MockGemini()
    mcp, _ = build_stack(tmp_path, mock, dry_run=False)
    prop = call(mcp, "propose_order", {"instrument_symbol": SYMBOL, "outcome": "yes", "side": "buy",
                                       "quantity": 3, "limit_price": 0.5})
    conf = call(mcp, "confirm_order", {"token": prop["confirmation_token"]})
    assert conf["ok"] and conf["order_id"] == 555

    posts = [r for r in mock.requests if r["method"] == "POST"]
    assert all(r["sig_ok"] and r["body"] == b"" for r in posts)
    nonces = [int(r["payload"]["nonce"]) for r in posts]
    assert all(b > a for a, b in zip(nonces, nonces[1:]))

    order = [r for r in posts if r["path"] == PLACE_ORDER_PATH]
    assert len(order) == 1
    p = order[0]["payload"]
    assert p["request"] == PLACE_ORDER_PATH
    assert {k: p[k] for k in ("symbol", "orderType", "side", "quantity", "price", "outcome", "timeInForce")} == {
        "symbol": SYMBOL, "orderType": "limit", "side": "buy", "quantity": "3", "price": "0.5",
        "outcome": "yes", "timeInForce": "good-til-cancel"}
    assert "stopPrice" not in p


def test_positions_params_go_in_signed_payload():
    mock = MockGemini()
    market, _ = clients(mock)
    market.get_positions(limit=1)
    assert mock.requests[0]["payload"]["limit"] == 1
    assert mock.requests[0]["payload"]["request"] == "/v1/prediction-markets/positions"


def test_order_status_open_then_history_then_not_found(tmp_path):
    import server

    mock = MockGemini()
    market, _ = clients(mock)
    r = server.find_order(market, 77)
    assert r["found_in"] == "order_history" and "between the two lookups" in r["note"]
    r = server.find_order(market, 12345)
    assert r["status"] == "not_found" and r["found_in"] is None
    assert [p for p in mock.paths()][:2] == ["/v1/prediction-markets/orders/active",
                                             "/v1/prediction-markets/orders/history"]


# --------------------------------------------------------------- secrets never leak


def test_errors_and_repr_never_contain_secret():
    def handler(request):
        return httpx.Response(400, json={"result": "error", "reason": "InvalidSignature"})

    market = ReadOnlyClient("sandbox", KEY, SECRET, transport=httpx.MockTransport(handler),
                            nonces=NonceGenerator(clock=_ticking(), sleep=lambda s: None))
    with pytest.raises(GeminiAPIError) as ei:
        market.get_balances()
    assert "InvalidSignature" in str(ei.value) and ei.value.status == 400
    for text in (str(ei.value), repr(market)):
        assert SECRET not in text and KEY not in text


def test_missing_credentials_refuses_before_any_request():
    mock = MockGemini()
    market = ReadOnlyClient("sandbox", transport=httpx.MockTransport(mock.handler))
    with pytest.raises(Exception, match="not set"):
        market.get_positions()
    assert mock.requests == []


def test_no_redirects_and_fixed_hosts():
    assert ReadOnlyClient("production").base_url == "https://api.gemini.com"
    assert ReadOnlyClient("sandbox").base_url == "https://api.sandbox.gemini.com"
    with pytest.raises(ValueError):
        ReadOnlyClient("https://evil.example")


# --------------------------------------------------------------- public depth snapshot (WebSocket)


class FakeWS:
    def __init__(self, frames):
        self.frames, self.sent = list(frames), []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def send(self, msg):
        self.sent.append(json.loads(msg))

    def recv(self, timeout=None):
        if not self.frames:
            raise TimeoutError
        return self.frames.pop(0)


def test_order_book_snapshot_via_public_depth_stream():
    ws = FakeWS([json.dumps({"id": "1", "result": None}),
                 json.dumps({"lastUpdateId": 7, "bids": [["0.60", "10"]], "asks": [["0.62", "5"]]})])
    urls = []
    c = ReadOnlyClient("production", ws_connect=lambda url, **kw: urls.append(url) or ws)
    book = c.get_order_book(SYMBOL)
    assert urls == ["wss://ws.gemini.com"]
    assert ws.sent == [{"id": "1", "method": "SUBSCRIBE", "params": [f"{SYMBOL}@depth20"]}]
    assert book["bids"] == [["0.60", "10"]] and book["last_update_id"] == 7


def test_order_book_errors_and_validation():
    with pytest.raises(GeminiAPIError, match="no depth snapshot"):
        ReadOnlyClient("sandbox", ws_connect=lambda url, **kw: FakeWS([])).get_order_book(SYMBOL, timeout=0.2)
    with pytest.raises(GeminiAPIError):
        ReadOnlyClient("sandbox", ws_connect=lambda url, **kw: FakeWS([json.dumps({"error": "invalid stream"})])
                       ).get_order_book(SYMBOL)
    with pytest.raises(ValueError):
        ReadOnlyClient("sandbox").get_order_book("bad symbol!")

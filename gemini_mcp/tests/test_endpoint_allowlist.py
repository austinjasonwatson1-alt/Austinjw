"""Task 2: every Gemini request must match an explicit method+path allowlist; anything else is refused before it
leaves the process, and logged. The HTTP layer is mocked by tests/fake_gemini.py, which records every request
that actually reaches it."""

import asyncio
import logging
import re
from decimal import Decimal

import httpx
import pytest

import gemini_client as gc
import server
from conftest import Clock
from fake_gemini import TEST_KEY, TEST_SECRET, FakeGemini, clients, guard_for
from guardrails import PaperLedger, load_config
from research import Estimate
from runner import Runner

ALLOWED = [
    ("GET", "/v1/prediction-markets/events"),
    ("GET", "/v1/prediction-markets/events/FEDJAN26"),
    ("POST", "/v1/balances"),
    ("POST", "/v1/prediction-markets/positions"),
    ("POST", "/v1/prediction-markets/orders/active"),
    ("POST", "/v1/prediction-markets/orders/history"),
    ("POST", "/v1/prediction-markets/order"),
    ("POST", "/v1/prediction-markets/order/cancel"),
]

FORBIDDEN_PATHS = [
    "/v1/withdraw/usd", "/v1/withdraw/btc", "/v1/deposit/btc/newAddress", "/v1/addresses/btc",
    "/v1/transfers", "/v1/account/transfer/usd", "/v1/payments/bank/add", "/v1/payments/methods",
    "/v1/fund-management/withdraw", "/v1/prediction-markets/withdraw", "/v1/prediction-markets/order/withdraw",
    "/v1/prediction-markets/events/FEDFUNDS", "/v1/prediction-markets/events/%77ithdraw",
    "/v1/prediction-markets/events/x%2F..%2Fwithdraw", "/v1/WITHDRAW", "/v1/Deposit",
    "/v1/prediction-markets", "/v1/prediction-markets/events/..", "/v1/prediction-markets/events/a/b",
    "/v1/order/new", "/v1/order/cancel/all", "/v1/prediction-markets/order/cancel/all",
    "/v1/prediction-markets/orders/cancel", "/v2/prediction-markets/order", "/v1/balances/notional",
    "/v1/approvedAddresses/account/btc/request", "/v1/account/create", "/v1/roles",
]


def test_allowlist_accepts_exactly_the_needed_endpoints():
    for method, path in ALLOWED:
        assert gc.endpoint_allowed(method, path), (method, path)


@pytest.mark.parametrize("path", FORBIDDEN_PATHS)
@pytest.mark.parametrize("method", ["GET", "POST"])
def test_allowlist_refuses_everything_else(method, path):
    assert not gc.endpoint_allowed(method, path)


@pytest.mark.parametrize("method", ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "get", "post"])
def test_other_methods_and_wrong_pairings_refused(method):
    for _, path in ALLOWED:
        assert not gc.endpoint_allowed(method, path)
    assert not gc.endpoint_allowed("GET", "/v1/balances")
    assert not gc.endpoint_allowed("POST", "/v1/prediction-markets/events")


@pytest.mark.parametrize("word", ["deposit", "withdraw", "transfer", "address", "fund", "bank"])
def test_sensitive_words_refused_anywhere_in_path(word):
    for path in (f"/v1/{word}", f"/v1/prediction-markets/{word}", f"/v1/prediction-markets/events/X{word.upper()}1",
                 f"/v1/prediction-markets/orders/active/{word}"):
        assert not gc.endpoint_allowed("POST", path) and not gc.endpoint_allowed("GET", path)


@pytest.mark.parametrize("cls", [gc.ReadOnlyClient, gc.TradingClient])
@pytest.mark.parametrize("path", ["/v1/withdraw/usd", "/v1/deposit/btc/newAddress", "/v1/account/transfer/usd",
                                  "/v1/payments/bank/add", "/v1/addresses/btc", "/v1/fund-management"])
def test_clients_refuse_and_log_before_sending(cls, path, caplog):
    fake = FakeGemini()
    c = cls("sandbox", TEST_KEY, TEST_SECRET, transport=fake.transport(), ws_connect=fake.ws_connect)
    with caplog.at_level(logging.WARNING):
        for call in (lambda: c._private_post(path), lambda: c._public_get(path),
                     lambda: c._http.post(path), lambda: c._http.get(path),
                     lambda: c._http.request("POST", f"https://{fake.host}{path}")):
            with pytest.raises(gc.PathNotAllowed):
                call()
    assert fake.requests == []
    assert "refused" in caplog.text and path.split("/")[2] in caplog.text


def test_transport_hook_refuses_other_hosts_and_schemes():
    fake = FakeGemini()
    c = gc.TradingClient("sandbox", TEST_KEY, TEST_SECRET, transport=fake.transport())
    for url in ("https://evil.example.com/v1/prediction-markets/events", "http://api.sandbox.gemini.com/v1/balances",
                "https://api.gemini.com/v1/prediction-markets/events", "https://api.sandbox.gemini.com:8443/v1/balances"):
        with pytest.raises(gc.PathNotAllowed):
            c._http.request("GET" if "events" in url else "POST", url)
    assert fake.requests == []


@pytest.mark.parametrize("ticker", ["..", ".", "a/../b", "../../v1/withdraw", "", "x?y=1", "FED JAN", "-x", "a" * 121])
def test_get_event_refuses_tickers_that_could_escape_the_path(ticker):
    fake = FakeGemini()
    c = gc.ReadOnlyClient("sandbox", transport=fake.transport())
    with pytest.raises((gc.PathNotAllowed, ValueError)):
        c.get_event(ticker)
    assert fake.requests == []


def test_trading_client_still_cannot_reach_other_private_paths():
    fake = FakeGemini()
    ro = gc.ReadOnlyClient("sandbox", TEST_KEY, TEST_SECRET, transport=fake.transport())
    for path in ("/v1/prediction-markets/order", "/v1/prediction-markets/order/cancel"):
        with pytest.raises(gc.PathNotAllowed):
            ro._private_post(path)  # allowlisted globally, but not for the read-only client
    assert fake.requests == []


# --------------------------------------------------------------- every tool and the runner stay inside


class InProcessTools:
    def __init__(self, mcp):
        self.mcp = mcp

    async def call(self, name, **args):
        _, structured = await self.mcp.call_tool(name, {k: v for k, v in args.items() if v is not None})
        return structured.get("result", structured)


def research_stub(info, prior):
    return Estimate(Decimal("0.85"), "Thesis.", "Rules.", ["cond"], ["fact"], False, "",
                    [{"url": f"https://example.gov/{i}"} for i in range(3)], "claude-opus-5-5", 2, {})


@pytest.mark.parametrize("live", [True, False])
def test_every_mcp_tool_and_the_runner_only_hit_allowlisted_endpoints(tmp_path, live):
    fake = FakeGemini()
    clock = Clock()
    market, guard = guard_for(tmp_path, fake, live=live, clock=clock, config={"max_daily_spend_usd": 100, "max_open_orders": 10, "max_trades_per_day": 10})
    tools = InProcessTools(server.create_server(market, guard))
    runner = Runner(tools=tools, research=research_stub, config=load_config(tmp_path / "config.yaml"),
                    audit=guard.audit, paper=PaperLedger(tmp_path / "paper_ledger.json", Decimal("100")),
                    dry_run=not live, confirm=lambda p: True, now=clock, out=lambda s: None)
    decisions = asyncio.run(runner.run())
    assert any(d["kind"] == "entry" for d in decisions), decisions

    async def every_tool():
        await tools.call("list_markets", search="Fed")
        await tools.call("get_market", event_ticker="FEDJAN26")
        await tools.call("get_balances")
        await tools.call("get_positions")
        await tools.call("get_order_book", instrument_symbol="GEMI-FEDJAN26-HOLD")
        await tools.call("list_open_orders")
        p = await tools.call("propose_order", instrument_symbol="GEMI-NBAFINALS-BOS", outcome="yes", side="buy",
                             limit_price="0.42", quantity="1")
        assert p["ok"], p
        c = await tools.call("confirm_order", token=p["confirmation_token"])
        oid = c.get("order_id") or 1
        await tools.call("get_order_status", order_id=oid)
        await tools.call("get_order_status", order_id=999)  # not open -> searches history too
        await tools.call("cancel_order", order_id=oid)
        await tools.call("get_market", event_ticker="../../v1/withdraw")  # refused, never sent

    asyncio.run(every_tool())
    seen = {(m, p.split("?")[0]) for m, p, _ in fake.requests}
    for method, path in seen:
        assert gc.endpoint_allowed(method, path), (method, path)
    assert {h for _, _, h in fake.requests} == {fake.host}
    assert all(re.fullmatch(r"[A-Za-z0-9._:-]+@depth(5|10|20)", s) for s in fake.ws_streams)
    if live:  # the session exercised every allowlisted endpoint, so the check above means something
        assert {re.sub(r"/events/[^/]+$", "/events/FEDJAN26", p) for _, p in seen} == {p for _, p in ALLOWED}


def test_server_build_wires_the_allowlisted_clients(monkeypatch):
    market, guard = server.build({"DRY_RUN": "false", "GEMINI_API_KEY": TEST_KEY, "GEMINI_API_SECRET": TEST_SECRET})
    assert isinstance(guard._trader, gc.TradingClient)
    for c in (market, guard._trader):
        with pytest.raises(gc.PathNotAllowed):
            c._http.post("/v1/withdraw/usd")


def test_clients_helper_builds_hooked_clients():
    fake = FakeGemini()
    market, trader = clients(fake, live=True)
    with pytest.raises(gc.PathNotAllowed):
        trader._http.post("/v1/deposit")
    assert fake.requests == []

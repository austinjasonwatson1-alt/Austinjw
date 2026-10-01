"""Task 3: the real runner and server tools, over the real Gemini clients (signing, allowlist, parsing),
end to end against tests/fake_gemini.py, in DRY_RUN and in live mode against the fake."""

import asyncio
import json
from decimal import Decimal

import pytest

import report
import server
from conftest import Clock
from fake_gemini import FakeGemini, guard_for
from guardrails import PaperLedger, load_config
from research import Estimate, ResearchError
from runner import Runner

DN25, HOLD, BOS = "GEMI-FEDJAN26-DN25", "GEMI-FEDJAN26-HOLD", "GEMI-NBAFINALS-BOS"


class InProcessTools:
    def __init__(self, mcp):
        self.mcp, self.calls = mcp, []

    async def call(self, name, **args):
        self.calls.append((name, args))
        _, structured = await self.mcp.call_tool(name, {k: v for k, v in args.items() if v is not None})
        return structured.get("result", structured)


def estimate(q, invalidated=False):
    return Estimate(Decimal(str(q)), "Thesis.", "Rules.", ["cond"], ["fact"], invalidated, "new info" if invalidated else "",
                    [{"url": f"https://example.gov/{i}"} for i in range(3)], "claude-opus-5-5", 2, {})


class World:
    """One server process (guard + MCP tools) plus the runner, sharing state files under tmp."""

    def __init__(self, tmp, fake, *, live, clock=None, config=None, nonce_start=1_790_000_000):
        self.tmp, self.fake, self.live = tmp, fake, live
        self.clock = clock or Clock()
        cfg = {"max_daily_spend_usd": 25, "max_order_usd": 10, "max_open_orders": 5, "max_trades_per_day": 10,
               **(config or {})}
        self.market, self.guard = guard_for(tmp, fake, live=live, clock=self.clock, config=cfg,
                                            nonce_start=nonce_start)
        self.tools = InProcessTools(server.create_server(self.market, self.guard))

    def run(self, q=0.85, research=None):
        def default(info, prior):
            return estimate(q)

        r = Runner(tools=self.tools, research=research or default, config=load_config(self.tmp / "config.yaml"),
                   audit=self.guard.audit, paper=PaperLedger(self.tmp / "paper_ledger.json", Decimal("100")),
                   dry_run=not self.live, confirm=lambda p: True, now=self.clock, out=lambda s: None)
        return asyncio.run(r.run())

    def audit(self):
        return [json.loads(x) for x in (self.tmp / "audit.log").read_text().splitlines()]

    def posts(self, path):
        return [p for m, p, _ in self.fake.requests if m == "POST" and p == path]


def kinds(decisions, kind):
    return [d for d in decisions if d["kind"] == kind]


ORDER = "/v1/prediction-markets/order"


# --------------------------------------------------------------- DRY_RUN


def test_dry_run_entry_is_paper_only(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=False)
    d = w.run()
    assert kinds(d, "entry")
    assert w.posts(ORDER) == [] and w.posts(ORDER + "/cancel") == []
    paper = json.loads((tmp_path / "paper_ledger.json").read_text())
    assert paper["positions"] and all(o["filled"] for o in paper["orders"])


# --------------------------------------------------------------- live against the fake


def test_live_entry_rests_and_is_not_restacked_next_run(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True)
    first = kinds(w.run(), "entry")
    assert first and len(fake.open_orders()) == len(first)
    second = w.run()
    assert kinds(second, "entry") == [], "runner re-entered contracts that already have a resting buy"
    assert len(fake.open_orders()) == len(first)
    skips = [x for x in second if x["kind"] == "skip" and "open order" in x["reason"]]
    assert len(skips) == len(first)


def test_partial_fill_counts_position_and_resting_remainder(tmp_path):
    fake = FakeGemini()
    for s in (DN25, HOLD, BOS):
        fake.set_fill_mode(s, "partial:3")
    w = World(tmp_path, fake, live=True)
    entries = kinds(w.run(), "entry")
    assert entries
    snap = fake.snapshot()
    filled = {k.split("|")[0]: Decimal(v["totalQuantity"]) for k, v in snap["positions"].items()}
    assert all(q == 3 for q in filled.values())
    risk = w.guard.risk_summary()
    for e in entries:
        o = next(o for o in fake.open_orders() if o["symbol"] == e["instrument_symbol"])
        resting = Decimal(o["remainingQuantity"]) * Decimal(o["price"])
        ev = e["event_ticker"]
        assert Decimal(risk["event_exposure_usd"][ev]) >= resting + 3 * Decimal(o["price"]) - Decimal("0.01")
    d2 = w.run(q=0.85)
    assert kinds(d2, "entry") == []  # held (partly) and resting: never stacked


def test_full_cycle_entry_fill_exit_fill(tmp_path):
    fake = FakeGemini()
    fake.set_fill_mode(DN25, "fill")
    w = World(tmp_path, fake, live=True, config={"allowed_event_tickers": ["FEDJAN26"]})
    w.run(q=0.85)
    assert any(k.startswith(DN25) for k in fake.snapshot()["positions"])
    held = Decimal(fake.snapshot()["positions"][f"{DN25}|yes"]["totalQuantity"])
    fake.set_fill_mode(DN25, "rest")  # the exit sell rests until we fill it below
    d = w.run(research=lambda info, prior: estimate(0.85, invalidated=info["instrument_symbol"] == DN25))
    exits = kinds(d, "exit")
    assert exits and exits[0]["instrument_symbol"] == DN25 and Decimal(exits[0]["quantity"]) == held
    sell = next(o for o in fake.open_orders() if o["side"] == "sell")
    d3 = w.run(q=0.85)  # sell is resting: nothing left to sell, no double sell
    assert not kinds(d3, "exit")
    assert any("nothing available" in (x.get("reason") or "") for x in kinds(d3, "hold"))
    fake.fill(sell["orderId"])
    assert f"{DN25}|yes" not in fake.snapshot()["positions"]


def test_circuit_breaker_trip_creates_kill_and_stops_orders(tmp_path):
    import yaml
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True, config={"allowed_event_tickers": ["FEDJAN26"]})
    w.run()
    n_orders = len(w.posts(ORDER))
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text())
    cfg["allowed_event_tickers"] = ["FEDJAN26", "NBAFINALS"]  # a contract with no resting order yet
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(cfg))
    fake.set_cash("700")  # 30% below peak
    d = w.run()
    assert (tmp_path / "KILL").exists()
    kill = json.loads((tmp_path / "KILL").read_text())
    assert kill["created_by"] == "circuit_breaker" and "drawdown" in kill["reason"]
    assert len(w.posts(ORDER)) == n_orders
    assert any(e["event"] == "circuit_breaker_trip" for e in w.audit())
    assert not kinds(d, "entry")


def test_kill_created_mid_run_stops_the_rest(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True)
    calls = []

    def research(info, prior):
        calls.append(info["instrument_symbol"])
        if len(calls) == 2:
            (tmp_path / "KILL").write_text("manual stop")
        return estimate(0.85)

    d = w.run(research=research)
    assert len(kinds(d, "entry")) == 1
    assert len(w.posts(ORDER)) == 1
    assert any("kill switch" in (x.get("reason") or "") for x in d)


def test_restart_mid_position_reviews_and_keeps_caps(tmp_path):
    fake = FakeGemini()
    fake.set_fill_mode(DN25, "fill")
    clock = Clock()
    w1 = World(tmp_path, fake, live=True, clock=clock, config={"allowed_event_tickers": ["FEDJAN26"]})
    w1.run()
    spent = w1.guard.ledger.spent_on(w1.guard._today())
    assert spent > 0
    # New process: new guard and server, same files. Its nonces start later, as wall-clock ones would.
    w2 = World(tmp_path, fake, live=True, clock=clock, nonce_start=1_800_000_000)
    assert w2.guard.ledger.spent_on(w2.guard._today()) == spent
    d = w2.run()
    holds_or_exits = kinds(d, "hold") + kinds(d, "exit")
    assert any(x["instrument_symbol"] == DN25 for x in holds_or_exits)  # reviewed, with the prior thesis
    assert not any(x["instrument_symbol"] == DN25 for x in kinds(d, "entry"))


@pytest.mark.parametrize("fault", ["503", "timeout", "timeout_after_apply", "malformed", "status:502"])
def test_outage_during_confirm_is_unknown_not_failed_and_never_retried(tmp_path, fault):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True, config={"allowed_event_tickers": ["NBAFINALS"]})
    fake.fail_next(ORDER, fault)
    d = w.run()
    assert len(w.posts(ORDER)) == 1  # no retry
    assert kinds(d, "entry_failed")
    assert w.guard.ledger.spent_on(w.guard._today()) > 0  # spend stays counted
    results = [e for e in w.audit() if e["event"] == "order_result"]
    assert [r["result"] for r in results] == ["unconfirmed"], results
    unknown = report.unknown_orders(w.audit())
    assert len(unknown) == 1 and "check Gemini" in unknown[0]["status"]
    if fault == "timeout_after_apply":  # the order really exists: the next exposure read sees it
        assert len(fake.open_orders()) == 1
        assert "NBAFINALS" in w.guard.risk_summary()["event_exposure_usd"]


def test_definite_rejection_is_failed(tmp_path):
    fake = FakeGemini()
    fake.set_fill_mode(BOS, "reject:InsufficientFunds")
    w = World(tmp_path, fake, live=True, config={"allowed_event_tickers": ["NBAFINALS"]})
    w.run()
    results = [e["result"] for e in w.audit() if e["event"] == "order_result"]
    assert results == ["failed"] and report.unknown_orders(w.audit()) == []


@pytest.mark.parametrize("fault", ["timeout", "503", "timeout_after_apply"])
def test_cancel_outage_is_unconfirmed(tmp_path, fault):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True, config={"allowed_event_tickers": ["NBAFINALS"]})
    w.run()
    oid = fake.open_orders()[0]["orderId"]
    fake.fail_next(ORDER + "/cancel", fault)
    r = asyncio.run(w.tools.call("cancel_order", order_id=oid))
    assert r["ok"] is False and r["order_id"] == oid
    assert [e["result"] for e in w.audit() if e["event"] == "order_result"][-1] == "unconfirmed"


@pytest.mark.parametrize("path,fault", [
    ("/v1/prediction-markets/positions", "malformed"), ("/v1/prediction-markets/positions", "missing:quantityOnHold"),
    ("/v1/prediction-markets/orders/active", "missing:side"), ("/v1/balances", "missing:available"),
    ("/v1/prediction-markets/orders/active", "503"), ("/v1/balances", "timeout"),
    ("/v1/prediction-markets/events/FEDJAN26", "503"), ("/v1/prediction-markets/positions", "set:totalQuantity=-5"),
])
def test_bad_reads_reject_every_proposal(tmp_path, path, fault):
    fake = FakeGemini()
    fake.set_fill_mode(DN25, "partial:3")  # leaves a position and a resting order for the faults to corrupt
    w = World(tmp_path, fake, live=True, config={"allowed_event_tickers": ["FEDJAN26"]})
    w.run()
    assert fake.snapshot()["positions"] and fake.open_orders()
    before = len(w.posts(ORDER))
    fake.fail_next(path, fault, times=1000)
    d = w.run(research=lambda info, prior: estimate(0.85, invalidated=True))  # wants entries AND exits
    assert len(w.posts(ORDER)) == before and not kinds(d, "entry") and not kinds(d, "exit")


def test_order_book_timeout_is_no_trade(tmp_path):
    fake = FakeGemini()
    fake.fail_next("GEMI", "book_timeout", times=10)
    w = World(tmp_path, fake, live=True)
    d = w.run()
    assert w.posts(ORDER) == [] and kinds(d, "no_trade")


def test_research_failure_places_nothing(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True)

    def broken(info, prior):
        raise ResearchError("web search unavailable")

    d = w.run(research=broken)
    assert w.posts(ORDER) == [] and all("research failed" in x["reason"] for x in kinds(d, "no_trade"))


def test_live_runner_enters_nothing_when_open_orders_cant_be_read(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=True)
    real = w.tools.call

    async def flaky(name, **args):  # only the runner's own open-orders read fails
        if name == "list_open_orders":
            return {"ok": False, "error": "GeminiAPIError: HTTP 503"}
        return await real(name, **args)

    w.tools.call = flaky
    d = w.run()
    assert w.posts(ORDER) == [] and not kinds(d, "entry")
    assert any("open orders" in (x.get("reason") or "") for x in kinds(d, "no_trade"))


def test_partially_filled_exit_sells_only_the_rest_next_run(tmp_path):
    fake = FakeGemini()
    fake.set_fill_mode(DN25, "fill")
    w = World(tmp_path, fake, live=True, config={"allowed_event_tickers": ["FEDJAN26"]})
    w.run()
    held = Decimal(fake.snapshot()["positions"][f"{DN25}|yes"]["totalQuantity"])
    fake.set_fill_mode(DN25, "partial:2")
    bad = lambda info, prior: estimate(0.85, invalidated=info["instrument_symbol"] == DN25)  # noqa: E731
    w.run(research=bad)
    pos = fake.snapshot()["positions"][f"{DN25}|yes"]
    assert Decimal(pos["totalQuantity"]) == held - 2
    sell = next(o for o in fake.open_orders() if o["side"] == "sell")
    assert Decimal(sell["remainingQuantity"]) == held - 2
    d = w.run(research=bad)  # everything left is committed to the resting sell: no second sell
    assert not kinds(d, "exit")
    assert sum(1 for o in fake.open_orders() if o["side"] == "sell") == 1


def test_report_live_fills_through_the_real_client(tmp_path):
    fake = FakeGemini()
    fake.set_fill_mode(DN25, "partial:4")
    w = World(tmp_path, fake, live=True, config={"allowed_event_tickers": ["FEDJAN26"]})
    w.run()
    oid = next(o for o in fake.open_orders() if o["symbol"] == DN25)["orderId"]
    fake.fill(oid)  # now fully filled -> in order history
    fills = report.live_fills(w.audit(), w.market, Decimal("0.02"))
    f = next(f for f in fills if f.ref == f"live:{oid}")
    assert f.symbol == DN25 and f.quantity > 4


def test_dry_run_review_and_exit(tmp_path):
    fake = FakeGemini()
    w = World(tmp_path, fake, live=False, config={"allowed_event_tickers": ["FEDJAN26"]})
    w.run()
    paper = json.loads((tmp_path / "paper_ledger.json").read_text())
    assert paper["positions"]
    d = w.run(research=lambda info, prior: estimate(0.85, invalidated=True))
    assert kinds(d, "exit") and w.posts(ORDER) == []
    paper = json.loads((tmp_path / "paper_ledger.json").read_text())
    assert paper["positions"] == {}

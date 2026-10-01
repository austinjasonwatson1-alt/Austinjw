"""Research loop (mocked Anthropic client) and report bucketing."""

from decimal import Decimal as D
from types import SimpleNamespace as NS

import pytest

from report import Fill, NO_ESTIMATE, bucket_of, build_lots, decision_summary, paper_fills, summarize
from research import FALLBACK_BETA, ResearchError, build_prompt, research_contract

CONTRACT = {"event_ticker": "FEDJAN26", "event_title": "Fed January meeting",
            "event_description": "Resolves on the FOMC statement.", "contract_label": "Cut >= 25bp",
            "contract_description": {"text": "YES if the target range upper bound is lowered by >= 25bp."},
            "terms_url": "https://example.com/terms.pdf", "instrument_symbol": "GEMI-FEDJAN26-DN25",
            "expiry": "2026-01-31T23:59:59Z"}

SUBMIT = {"resolution_rules_summary": "Upper bound lowered by 25bp+ at the Jan meeting.", "probability_yes": 0.62,
          "thesis": "Futures price a cut. Recent CPI cooled.", "invalidation_conditions": ["Hot January CPI"],
          "key_facts": ["CME FedWatch 60%"], "thesis_invalidated": False, "invalidation_reason": ""}


def resp(stop, *blocks):
    return NS(stop_reason=stop, content=list(blocks), model="claude-opus-5-5",
              usage=NS(input_tokens=100, output_tokens=50))


def search_result(*urls):
    return NS(type="web_search_tool_result", content=[NS(url=u, title=f"t{u[-1]}", page_age=None) for u in urls])


class FakeClient:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []
        self.beta = NS(messages=NS(create=self.create))

    def create(self, **kw):
        self.requests.append(kw)
        return self.responses.pop(0)


def call(client, prior=None):
    return research_contract(client, model="claude-opus-5-5", contract=CONTRACT, prior=prior,
                             now_iso="2026-01-10T00:00:00+00:00", max_searches=4)


def test_research_returns_estimate_and_real_sources():
    client = FakeClient(
        resp("pause_turn", NS(type="server_tool_use", name="web_search", input={"query": "fed"}),
             search_result("https://a.gov/1", "https://b.com/2")),
        resp("tool_use", NS(type="server_tool_use", name="web_fetch", input={"url": "https://example.com/terms.pdf"}),
             search_result("https://a.gov/1"),
             NS(type="tool_use", name="submit_estimate", input=SUBMIT)),
    )
    est = call(client)
    assert est.probability_yes == D("0.62") and est.thesis.startswith("Futures")
    assert [s["url"] for s in est.sources] == ["https://a.gov/1", "https://b.com/2", "https://example.com/terms.pdf"]
    assert est.searches == 1 and est.usage == {"input_tokens": 200, "output_tokens": 100}
    req = client.requests[0]
    assert req["model"] == "claude-opus-5-5" and req["fallbacks"] == "default" and req["betas"] == [FALLBACK_BETA]
    types = [t.get("type", t.get("name")) for t in req["tools"]]
    assert types == ["web_search_20260209", "web_fetch_20260209", "submit_estimate"]
    assert req["tools"][0]["max_uses"] == 4 and req["tools"][2]["strict"] is True
    assert "thinking" not in req  # always-on adaptive thinking on this model; disabling it is a 400
    assert len(client.requests[1]["messages"]) == 2  # paused turn appended and re-sent


def test_nudges_once_then_fails():
    ok = FakeClient(resp("end_turn", NS(type="text", text="I think 60%")),
                    resp("tool_use", NS(type="tool_use", name="submit_estimate", input=SUBMIT)))
    assert call(ok).probability_yes == D("0.62")
    assert ok.requests[1]["messages"][-1]["content"].startswith("Call submit_estimate")
    bad = FakeClient(resp("end_turn", NS(type="text", text="a")), resp("end_turn", NS(type="text", text="b")))
    with pytest.raises(ResearchError, match="without calling submit_estimate"):
        call(bad)


@pytest.mark.parametrize("response,needle", [
    (resp("refusal"), "declined"),
    (resp("max_tokens", NS(type="text", text="...")), "max_tokens"),
    (resp("tool_use", NS(type="tool_use", name="submit_estimate", input={**SUBMIT, "probability_yes": 1.4})), "outside"),
    (resp("tool_use", NS(type="tool_use", name="submit_estimate", input={**SUBMIT, "thesis": 3})), "thesis"),
])
def test_research_failures_raise(response, needle):
    with pytest.raises(ResearchError, match=needle):
        call(FakeClient(response))


def test_prompt_has_rules_first_no_prices_and_prior():
    p = build_prompt(CONTRACT, {"probability_yes": "0.7", "thesis": "Old thesis.", "invalidation_conditions": ["X"],
                                "ts": "2026-01-01"}, "2026-01-10T00:00:00+00:00")
    assert p.index("RESOLUTION RULES") < p.index("PREVIOUS ASSESSMENT")
    assert "lowered by >= 25bp" in p and "https://example.com/terms.pdf" in p and "Old thesis." in p
    assert "bid" not in p.lower() and "ask" not in p.lower() and "price" not in p.lower()


def test_search_error_object_is_ignored():
    client = FakeClient(resp("tool_use", NS(type="web_search_tool_result", content=NS(error_code="max_uses_exceeded")),
                             NS(type="tool_use", name="submit_estimate", input=SUBMIT)))
    assert call(client).sources == []


# --------------------------------------------------------------- report


def test_bucket_boundaries():
    assert bucket_of(None) == NO_ESTIMATE
    assert bucket_of(D("0.049")) == "edge < 5%"
    assert bucket_of(D("0.05")) == "5-10%"
    assert bucket_of(D("0.10")) == "10-20%"
    assert bucket_of(D("0.25")) == "20%+"


def F(ref, side, qty, price, sym="S1", outcome="yes", ts="1"):
    return Fill(ref, ts, sym, outcome, side, D(qty), D(price), D("0.02"), "EV")


def test_lots_fifo_settlement_and_buckets():
    research = {
        "a": {"edge": "0.06", "q": "0.70", "q_adj": "0.64"},   # 5-10%
        "b": {"edge": "0.25", "q": "0.90", "q_adj": "0.80"},   # 20%+, sym S2
        "c": {"edge": "0.12", "q": "0.70", "q_adj": "0.62"},   # 10-20%, still open
    }
    fills = [F("a", "buy", "10", "0.56", ts="1"), F("x", "sell", "4", "0.70", ts="2"),
             F("b", "buy", "5", "0.53", sym="S2", ts="3"), F("c", "buy", "2", "0.48", sym="S3", ts="4")]
    resolutions = {"S1": "yes", "S2": "no"}
    lots = build_lots(fills, research, lambda ev, sym: resolutions.get(sym))
    a, b, c = lots
    # a: 4 sold at 0.70-0.02, 6 settled YES at $1 -> proceeds 2.72 + 6 = 8.72 ; cost 10 x 0.58 = 5.80
    assert a.closed and a.proceeds == D("8.72") and a.settled_win is True
    assert a.realized_return == (D("8.72") - D("5.80")) / D("5.80")
    assert a.expected_return == (D("0.64") - D("0.56") - D("0.02")) / D("0.58")
    # b: lost at settlement
    assert b.closed and b.proceeds == 0 and b.settled_win is False and b.realized_return == -1
    assert not c.closed
    rows = {r["bucket"]: r for r in summarize(lots)}
    assert rows["5-10%"]["closed"] == 1 and rows["5-10%"]["win_rate"] == "1.0000"
    assert rows["20%+"]["mean_realized_return"] == "-1.0000" and rows["20%+"]["win_rate"] == "0.0000"
    assert rows["10-20%"]["open"] == 1 and rows["10-20%"]["mean_realized_return"] is None
    assert rows["ALL"]["trades"] == 3 and rows["ALL"]["closed"] == 2
    assert rows["ALL"]["pnl_usd"] == format((D("8.72") - D("5.80") - D("2.75")).quantize(D("0.01")), "f")


def test_lot_without_research_is_no_estimate_bucket():
    lots = build_lots([F("z", "buy", "1", "0.5")], {}, lambda e, s: "yes")
    assert summarize(lots)[0]["bucket"] == NO_ESTIMATE


def test_paper_fills_ignores_unfilled():
    ledger = {"orders": [
        {"paper_order_id": "p1", "ts": "1", "symbol": "S", "outcome": "yes", "side": "buy", "quantity": "2",
         "price": "0.5", "fee": "0.02", "event_ticker": "E", "filled": True},
        {"paper_order_id": "p2", "ts": "2", "symbol": "S", "outcome": "yes", "side": "buy", "quantity": "2",
         "price": "0.4", "fee": "0.02", "event_ticker": "E", "filled": False}]}
    assert [f.ref for f in paper_fills(ledger)] == ["p1"]


def test_decision_summary():
    entries = [{"event": "decision", "kind": "no_trade", "reason": "wide spread: 0.9 > 0.04"},
               {"event": "decision", "kind": "no_trade", "reason": "wide spread: 0.5 > 0.04"},
               {"event": "decision", "kind": "hold", "reasons": ["hold: no exit condition met"]},
               {"event": "proposal"}]
    s = decision_summary(entries)
    assert s["by_kind"] == {"no_trade": 2, "hold": 1}
    assert s["top_reasons"][0] == {"kind": "no_trade", "reason": "wide spread", "count": 2}

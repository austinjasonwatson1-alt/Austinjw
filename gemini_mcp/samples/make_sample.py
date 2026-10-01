"""Build samples/dashboard_sample.html from simulated data (no network, no keys).

    python samples/make_sample.py

Simulates two weeks of the real runner and server in live-sandbox mode against tests/fake_gemini.py:
- 12 events (24 contracts) whose quotes drift daily; some books are thin.
- Seeded research estimates, with theses, invalidation conditions and sources.
- One placement that times out after the exchange accepted it, so it shows up as an "unknown" order.
- A late drawdown that trips the circuit breaker and creates KILL.
Contracts are then resolved with a seeded coin flip, report.py's own functions build report.json, and
dashboard.py renders the page. Everything lives in a temp dir except the output HTML.
"""

from __future__ import annotations

import asyncio
import json
import random
import sys
import tempfile
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

import dashboard  # noqa: E402
import report  # noqa: E402
import server  # noqa: E402
from fake_gemini import FakeGemini, contract, event, guard_for  # noqa: E402
from guardrails import PaperLedger, load_config  # noqa: E402
from research import Estimate  # noqa: E402
from runner import Runner  # noqa: E402

T0 = 1_790_208_000.0  # 2026-09-24 00:00 UTC
TOPICS = [
    ("FEDDEC26", "Fed December 2026 decision", "Economics", ["Cut 25bp", "Hold"]),
    ("CPIOCT26", "October CPI print", "Economics", ["Above 0.3% m/m", "At or below 0.2% m/m"]),
    ("NFPOCT26", "October payrolls", "Economics", ["Over 150k", "Under 50k"]),
    ("GDPQ326", "Q3 GDP advance estimate", "Economics", ["Above 2.5%", "Below 1.0%"]),
    ("NBAOPEN26", "NBA opening night", "Sports", ["Celtics win", "Lakers win"]),
    ("WS2026", "World Series 2026", "Sports", ["Goes to game 7", "Ends in a sweep"]),
    ("NFLWK8", "NFL week 8 marquee game", "Sports", ["Home team covers", "Over 47.5 points"]),
    ("ELECTGOV26", "Governor races", "Politics", ["Incumbent party holds VA", "Turnout above 2022"]),
    ("SENATE26", "Senate control", "Politics", ["Majority flips", "51+ seats for incumbents"]),
    ("BTCNOV26", "Bitcoin on Nov 30", "Crypto", ["Above $120k", "Below $80k"]),
    ("ETHETF26", "ETH ETF flows", "Crypto", ["Net inflow in Oct", "Record weekly outflow"]),
    ("RAINNYC", "NYC rainfall in November", "Climate", ["Above normal", "Below 2 inches"]),
]
SOURCES = ["https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", "https://www.bls.gov/cpi/",
           "https://www.bea.gov/data/gdp", "https://www.nba.com/schedule", "https://www.mlb.com/postseason",
           "https://www.reuters.com/markets/", "https://apnews.com/hub/elections", "https://www.weather.gov/okx/",
           "https://www.coindesk.com/markets/", "https://fred.stlouisfed.org/"]


class InProcessTools:
    def __init__(self, mcp):
        self.mcp = mcp

    async def call(self, name, **args):
        _, structured = await self.mcp.call_tool(name, {k: v for k, v in args.items() if v is not None})
        return structured.get("result", structured)


class SimClock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def build_world(tmp: Path, rng: random.Random):
    fake = FakeGemini(cash="500")
    truth: dict[str, float] = {}
    with fake.state() as st:
        st["events"], st["books"] = {}, {}
        for ticker, title, cat, labels in TOPICS:
            cs = []
            for j, label in enumerate(labels):
                sym = f"GEMI-{ticker}-{chr(65 + j)}"
                p_true = rng.uniform(0.12, 0.88)
                truth[sym] = p_true
                mid = min(max(p_true + rng.gauss(0, 0.08), 0.05), 0.95)
                bid, ask = round(mid - 0.01, 2), round(mid + 0.01, 2)
                cs.append(contract(sym, label, f"{bid:.2f}", f"{ask:.2f}"))
                depth = "6" if rng.random() < 0.15 else str(rng.randint(150, 900))
                st["books"][sym] = {"bids": [[f"{bid:.2f}", depth]], "asks": [[f"{ask:.2f}", depth]]}
            st["events"][ticker] = event(ticker, title, cs, category=cat)
        for sym in truth:
            st["fill_mode"][sym] = rng.choice(["fill", "fill", "partial:2", "rest"])
    return fake, truth


def research_factory(truth: dict[str, float], rng: random.Random, day: int):
    def research(info, prior):
        sym = info["instrument_symbol"]
        q = min(max(truth[sym] + rng.gauss(0, 0.10), 0.02), 0.98)
        label = info.get("contract_label") or sym
        thesis = (f"Base rates and the latest data put {label.lower()} near {q:.0%}. "
                  f"The market at the time priced it differently; the gap is mostly timing of the next data release.")
        srcs = [{"url": u, "title": u.split('/')[2].replace("www.", ""), "page_age": None, "via": "web_search"}
                for u in rng.sample(SOURCES, 3)]
        invalid = rng.random() < (0.12 if prior else 0.0)
        return Estimate(Decimal(f"{q:.3f}"), thesis, f"Resolves YES if {label} per the official source.",
                        [f"An official revision moves {label} the other way", "A schedule change before expiry"],
                        [f"Day {day} reading in line with consensus"], invalid,
                        "New data contradicts the thesis" if invalid else "", srcs,
                        "claude-opus-5-5", 3, {"input_tokens": 9000, "output_tokens": 900})
    return research


def drift(fake: FakeGemini, truth: dict[str, float], rng: random.Random):
    with fake.state() as st:
        for ev in st["events"].values():
            for c in ev["contracts"]:
                sym = c["instrumentSymbol"]
                mid = (float(c["prices"]["bestBid"]) + float(c["prices"]["bestAsk"])) / 2
                mid = min(max(mid + 0.25 * (truth[sym] - mid) + rng.gauss(0, 0.03), 0.04), 0.96)
                bid, ask = round(mid - 0.01, 2), round(mid + 0.01, 2)
                new = contract(sym, c["label"], f"{bid:.2f}", f"{ask:.2f}", c["expiryDate"])
                c.update(new)
                depth = st["books"][sym]["bids"][0][1]
                st["books"][sym] = {"bids": [[f"{bid:.2f}", depth]], "asks": [[f"{ask:.2f}", depth]]}


def main() -> int:
    rng = random.Random(20261001)
    tmp = Path(tempfile.mkdtemp(prefix="desk-sample-"))
    fake, truth = build_world(tmp, rng)
    clock = SimClock(T0)
    cfg = {"allowed_event_tickers": [t[0] for t in TOPICS], "max_order_usd": 3, "max_daily_spend_usd": 12,
           "max_open_orders": 6, "max_trades_per_day": 6, "max_research_per_run": 30, "min_edge": 0.04,
           "max_market_pct_of_balance": 0.12, "starting_balance_usd": 500, "equity_floor_pct": 0.6,
           "max_drawdown_pct": 0.2, "max_daily_loss_pct": 0.08}
    for day in range(14):
        clock.t = T0 + day * 86400 + 14 * 3600 + rng.randint(0, 3000)
        _, guard = guard_for(tmp, fake, live=True, clock=clock, config=cfg if day == 0 else None,
                             nonce_start=1_790_000_000 + day * 1_000_000)
        tools = InProcessTools(server.create_server(guard.market, guard))
        if day == 6:
            fake.fail_next("/v1/prediction-markets/order", "timeout_after_apply")
        if day == 12:
            fake.set_cash(str(Decimal(fake.snapshot()["cash"]) * Decimal("0.70")))  # a bad week: breaker trips
        runner = Runner(tools=tools, research=research_factory(truth, rng, day), config=load_config(tmp / "config.yaml"),
                        audit=guard.audit, paper=PaperLedger(tmp / "paper_ledger.json", Decimal("100")), dry_run=False,
                        confirm=lambda p: True, now=clock, out=lambda s: None)
        asyncio.run(runner.run())
        for o in fake.open_orders():  # some resting orders fill overnight
            if rng.random() < 0.5:
                fake.fill(o["orderId"])
        drift(fake, truth, rng)

    resolution = {sym: ("yes" if rng.random() < p else "no") for sym, p in truth.items()}
    resolver = lambda ev, sym: resolution.get(sym)  # noqa: E731
    audit = report.read_audit(tmp / "audit.log")
    ledger = json.loads((tmp / "paper_ledger.json").read_text())
    market = guard.market
    lots = report.build_lots(report.live_fills(audit, market, Decimal("0.02")), ledger.get("research") or {}, resolver)
    rep = {"buckets": report.summarize(lots), "all_estimates": report.estimate_brier(audit, resolver),
           "decisions": report.decision_summary(audit),
           "lots": [{**{k: (str(v) if isinstance(v, Decimal) else v) for k, v in l.__dict__.items()}} for l in lots]}
    (tmp / "report.json").write_text(json.dumps(rep, default=str))
    now = datetime.fromtimestamp(clock.t + 3600, tz=timezone.utc)
    model = dashboard.build_model(dashboard.load_inputs(tmp, tmp / "report.json"), now=now)
    out = HERE / "dashboard_sample.html"
    out.write_text(dashboard.render(model), encoding="utf-8")
    print(f"wrote {out} (data in {tmp})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

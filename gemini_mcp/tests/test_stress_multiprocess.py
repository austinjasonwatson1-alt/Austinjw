"""Task 4: several server processes propose and confirm concurrently against one shared fake exchange and one
shared state directory. Daily spend, trade count and open-order limits must never be exceeded."""

import json
import multiprocessing as mp
import random
import sys
from decimal import Decimal
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
LIMITS = {"max_daily_spend_usd": 10, "max_order_usd": 2, "max_open_orders": 4, "max_trades_per_day": 9,
          "allowed_event_tickers": ["FEDJAN26", "NBAFINALS"]}
SYMBOLS = [("GEMI-FEDJAN26-DN25", "0.62"), ("GEMI-FEDJAN26-HOLD", "0.32"), ("GEMI-NBAFINALS-BOS", "0.42")]


def worker(tmp: str, idx: int, attempts: int, barrier, out):
    sys.path[:0] = [str(HERE), str(HERE.parent)]
    from fake_gemini import FakeGemini, guard_for

    tmp = Path(tmp)
    fake = FakeGemini(state_path=tmp / "fake.json")
    _, guard = guard_for(tmp, fake, live=True, key=f"account-K{idx}", secret=f"S{idx}",
                         nonce_start=1_790_000_000 + idx * 10_000_000)
    rng = random.Random(idx)
    barrier.wait()
    results = []
    for _ in range(attempts):
        symbol, price = rng.choice(SYMBOLS)
        r = guard.propose(symbol, "yes", "buy", str(rng.randint(1, 3)), price)
        if r.get("ok"):
            c = guard.confirm(r["confirmation_token"])
            results.append(("confirm", bool(c.get("ok")), c.get("reason") or c.get("error")))
        else:
            results.append(("propose", False, r.get("reason")))
    out.put((idx, results))


@pytest.mark.parametrize("n_procs,attempts", [(6, 6)])
def test_concurrent_processes_never_exceed_caps(tmp_path, n_procs, attempts):
    sys.path[:0] = [str(HERE)]
    import yaml
    from fake_gemini import FakeGemini

    fake = FakeGemini(state_path=tmp_path / "fake.json")
    for i in range(n_procs):
        fake.add_key(f"account-K{i}", f"S{i}")
    fake.set_fill_mode("GEMI-FEDJAN26-HOLD", "fill")
    fake.set_fill_mode("GEMI-NBAFINALS-BOS", "partial:1")
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(LIMITS))

    ctx = mp.get_context("fork")
    barrier, out = ctx.Barrier(n_procs), ctx.Queue()
    procs = [ctx.Process(target=worker, args=(str(tmp_path), i, attempts, barrier, out)) for i in range(n_procs)]
    for p in procs:
        p.start()
    results = dict(out.get(timeout=240) for _ in procs)
    for p in procs:
        p.join(timeout=60)
        assert p.exitcode == 0

    snap = fake.snapshot()
    orders = list(snap["orders"].values())
    spent = sum(Decimal(o["quantity"]) * Decimal(o["price"]) for o in orders if o["side"] == "buy")
    confirmed_ok = sum(ok for rs in results.values() for kind, ok, _ in rs if kind == "confirm")
    ledger = json.loads((tmp_path / "state" / "daily_spend.json").read_text())
    (day,) = ledger["spend"]["sandbox:live"].keys()

    assert len(orders) == confirmed_ok > 0
    assert spent <= LIMITS["max_daily_spend_usd"]
    assert Decimal(ledger["spend"]["sandbox:live"][day]) <= LIMITS["max_daily_spend_usd"]
    assert len(orders) <= LIMITS["max_trades_per_day"]
    assert ledger["trades"]["sandbox:live"][day] <= LIMITS["max_trades_per_day"]
    assert snap["max_open_seen"] <= LIMITS["max_open_orders"]
    assert all(Decimal(o["quantity"]) * Decimal(o["price"]) <= LIMITS["max_order_usd"] for o in orders)
    # the caps were actually reached: something was refused for a cap, not just by luck
    reasons = " ".join(str(r) for rs in results.values() for _, ok, r in rs if not ok)
    assert "daily cap" in reasons or "max_trades_per_day" in reasons or "open orders" in reasons
    audit = [json.loads(x) for x in (tmp_path / "audit.log").read_text().splitlines()]
    intents = {e["intent_id"] for e in audit if e["event"] == "order_intent"}
    results_ = {e["intent_id"] for e in audit if e["event"] == "order_result"}
    assert intents == results_ and len(intents) == len(orders)

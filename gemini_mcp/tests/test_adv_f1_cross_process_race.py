"""F1: two server processes (e.g. the runner's and Claude Desktop's) share state files.

Validation and recording spend must be atomic across processes, or both can spend the last of the
daily budget.
"""

import threading
import time

from conftest import SYMBOL, write_config


def test_two_processes_cannot_both_spend_the_last_of_the_daily_budget(env):
    write_config(env.config_path, max_daily_spend_usd=10)
    g1, g2 = env.guard(), env.guard()  # separate instances = separate processes sharing state/
    t1 = g1.propose(SYMBOL, "yes", "buy", "16", "0.50")["confirmation_token"]  # $8
    t2 = g2.propose(SYMBOL, "yes", "buy", "16", "0.50")["confirmation_token"]  # $8
    release = threading.Event()
    real = g1._validate

    def slow_validate(*a, **k):
        v = real(*a, **k)
        release.wait(1.0)  # g1 has passed validation but hasn't recorded its spend yet
        return v

    g1._validate = slow_validate
    results = {}
    a = threading.Thread(target=lambda: results.__setitem__("g1", g1.confirm(t1)))
    a.start()
    time.sleep(0.2)
    results["g2"] = g2.confirm(t2)
    release.set()
    a.join(5)
    assert sum(bool(r["ok"]) for r in results.values()) == 1, results
    assert len(env.trader.placed) == 1
    assert g1.ledger.spent_on(g1._today()) <= 10

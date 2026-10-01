"""Task 4: fuzz the parsing of Gemini responses. Random missing, extra, wrongly-typed and extreme fields in
positions, open orders, balances and events. A required money field that is missing, wrongly typed or absurd
must make the proposal a logged rejection; an extra field must change nothing; nothing may ever crash."""

import copy
import tempfile
from pathlib import Path

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from conftest import EVENT, SYMBOL, Clock, FakeMarket, FakeTrader, make_contract, make_event, make_order, \
    make_position, write_config
from guardrails import AuditLog, Guardrails, RiskState, SpendLedger

NUM = "num"
STR = "str"    # free-form string (symbol, ticker, category): any non-empty string is plausible
ENUM = "enum"  # must be one of a few known values (outcome, side, status, currency, the traded ticker/symbol)
DICT = "dict"
LIST = "list"

# (target, path) -> kind, for every field the guardrails read and require. Everything else is optional.
REQUIRED = {
    ("position", ("symbol",)): STR, ("position", ("outcome",)): ENUM, ("position", ("totalQuantity",)): NUM,
    ("position", ("quantityOnHold",)): NUM, ("position", ("avgPrice",)): NUM,
    ("position", ("contractMetadata",)): DICT, ("position", ("contractMetadata", "eventTicker")): STR,
    ("position", ("contractMetadata", "category")): STR,
    ("buy_order", ("symbol",)): STR, ("buy_order", ("side",)): ENUM, ("buy_order", ("outcome",)): ENUM,
    ("buy_order", ("remainingQuantity",)): NUM, ("buy_order", ("price",)): NUM,
    ("buy_order", ("contractMetadata",)): DICT, ("buy_order", ("contractMetadata", "eventTicker")): STR,
    ("buy_order", ("contractMetadata", "category")): STR,
    ("sell_order", ("symbol",)): STR, ("sell_order", ("side",)): ENUM, ("sell_order", ("outcome",)): ENUM,
    ("sell_order", ("remainingQuantity",)): NUM, ("sell_order", ("contractMetadata",)): DICT,
    ("balance", ("currency",)): ENUM, ("balance", ("amount",)): NUM, ("balance", ("available",)): NUM,
    ("event", ("ticker",)): ENUM, ("event", ("status",)): ENUM, ("event", ("contracts",)): LIST,
    ("contract", ("instrumentSymbol",)): ENUM, ("contract", ("status",)): ENUM, ("contract", ("marketState",)): ENUM,
    ("contract", ("priceMinimum",)): NUM, ("contract", ("priceIncrement",)): NUM,
    ("contract", ("quantityMinimum",)): NUM, ("contract", ("quantityIncrement",)): NUM,
}
OPTIONAL = {
    "position": [("marketValue",), ("contractMetadata", "expiryDate")],
    "buy_order": [("orderId",), ("quantity",), ("filledQuantity",), ("orderType",), ("status",)],
    "sell_order": [("price",), ("orderId",), ("quantity",)],
    "balance": [("type",)],
    "event": [("title",), ("category",), ("expiryDate",)],
    "contract": [("label",), ("prices",), ("expiryDate",)],
}
BAD = {
    NUM: [None, "", "abc", [], {}, True, "NaN", "Infinity", "-Infinity", "-1", -1, "1e400", 10**30, "1e-400",
          "-0.5"],
    STR: [None, 123, [], {}, "", True],
    ENUM: [None, 123, [], {}, "", "maybe", True],
    DICT: [None, "x", [], 5],
    LIST: [None, "x", {}, 5],
}


def baseline():
    return {
        "position": make_position(total="10", avg="0.5"),
        "buy_order": make_order(1, side="buy", remaining="4", price="0.5"),
        "sell_order": make_order(2, side="sell", remaining="2", price="0.7"),
        "balance": {"type": "exchange", "currency": "USD", "amount": "1000", "available": "1000"},
        "event": {k: v for k, v in make_event(category="economics").items() if k != "contracts"},
        "contract": make_contract(),
    }


def build(tmp, objs):
    m = FakeMarket()
    m.positions = {"positions": [objs["position"]]}
    m.active = {"orders": [objs["buy_order"], objs["sell_order"]]}
    m.balances = [objs["balance"]]
    ev = dict(objs["event"])
    mode = objs.get("contracts_mode", "normal")
    if mode == "normal":
        ev["contracts"] = [objs["contract"]]
    elif mode == "set":
        ev["contracts"] = objs["contracts_value"]
    m.events = {EVENT: ev}  # mode "drop": no contracts key at all
    tmp = Path(tmp)
    write_config(tmp / "config.yaml", max_open_orders=10)
    clock = Clock()
    return Guardrails(config_path=tmp / "config.yaml", kill_path=tmp / "KILL",
                      ledger=SpendLedger(tmp / "s" / "d.json", "k"), audit=AuditLog(tmp / "a.log", clock=clock),
                      market=m, trader=FakeTrader(), dry_run=False, env="sandbox",
                      risk_state=RiskState(tmp / "s" / "r.json", "k"), clock=clock)


def decide(objs):
    with tempfile.TemporaryDirectory() as tmp:
        g = build(tmp, objs)
        out = []
        for args in ((SYMBOL, "yes", "buy", "2", "0.50"), (SYMBOL, "yes", "sell", "1", "0.70")):
            r = g.propose(*args)
            assert isinstance(r, dict) and r["ok"] in (True, False)
            out.append(r["ok"])
        return out, g.audit.path.read_text()


def apply(objs, target, path, op, value=None):
    objs = copy.deepcopy(objs)
    if target == "event" and path == ("contracts",):
        objs["contracts_mode"], objs["contracts_value"] = op, value
        return objs
    cur = objs[target]
    for k in path[:-1]:
        if not isinstance(cur.get(k), dict):
            return objs
        cur = cur[k]
    if op == "drop":
        cur.pop(path[-1], None)
    elif op == "set":
        cur[path[-1]] = value
    return objs


def test_baseline_is_tradable():
    assert decide(baseline())[0] == [True, True]


@settings(max_examples=250, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(data=st.data())
def test_bad_required_field_always_rejects(data):
    (target, path), kind = data.draw(st.sampled_from(sorted(REQUIRED.items())))
    op = data.draw(st.sampled_from(["drop", "set"]))
    value = data.draw(st.sampled_from(BAD[kind])) if op == "set" else None
    objs = apply(baseline(), target, path, op, value)
    oks, audit = decide(objs)
    assert oks == [False, False], (target, path, op, value, oks)
    assert audit.count('"event": "rejection"') == 2


@settings(max_examples=120, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(data=st.data())
def test_extra_fields_change_nothing(data):
    target = data.draw(st.sampled_from(sorted(baseline())))
    key = data.draw(st.text(min_size=1, max_size=12).filter(lambda k: k not in baseline()[target]))
    value = data.draw(st.one_of(st.none(), st.integers(), st.text(max_size=8), st.floats(allow_nan=True),
                                st.lists(st.integers(), max_size=2)))
    objs = baseline()
    objs[target][key] = value
    assert decide(objs)[0] == [True, True], (target, key, value)


@settings(max_examples=120, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(data=st.data())
def test_optional_fields_never_crash(data):
    target = data.draw(st.sampled_from(sorted(OPTIONAL)))
    path = data.draw(st.sampled_from(OPTIONAL[target]))
    op = data.draw(st.sampled_from(["drop", "set"]))
    value = data.draw(st.one_of(*[st.sampled_from(v) for v in BAD.values()])) if op == "set" else None
    decide(apply(baseline(), target, path, op, value))  # any decision is fine, as long as it's clean

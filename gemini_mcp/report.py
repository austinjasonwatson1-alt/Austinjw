"""Do bigger stated edges actually win more? Realized vs expected return by edge bucket.

    python report.py           # paper trades (and decisions) from paper_ledger.json + audit.log
    python report.py --live    # also fetch live fills from Gemini order history (read-only calls)
    python report.py --json

Each buy fill is a lot. Later sells of the same contract and outcome close lots
first-in, first-out; whatever is left settles at $1 or $0 once the contract
resolves (from the public event data). Open lots are counted but excluded
from returns.

  expected return = (q_adj - fill price - fee) / (fill price + fee)   using the estimate at entry
  realized return = (proceeds - cost) / cost,  cost = quantity * (fill price + fee)

Buckets use the edge recorded when the trade was decided.

Brier scores (lower is better) compare my raw estimate q with the market's probability on the same
contracts: the YES-space book mid logged when the decision was made (the outcome's side of it), falling
back to the fill price. A contract counts once it resolves, whether or not the position was held to
settlement. Buckets with fewer than 30 scored contracts are flagged: too few to conclude anything.
A second table scores every researched contract (traded or not), one sample per contract per UTC day.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
_ZERO = Decimal(0)
BUCKETS = [  # (low inclusive, high exclusive, label)
    (None, Decimal("0.05"), "edge < 5%"),
    (Decimal("0.05"), Decimal("0.10"), "5-10%"),
    (Decimal("0.10"), Decimal("0.20"), "10-20%"),
    (Decimal("0.20"), None, "20%+"),
]
NO_ESTIMATE = "no estimate"
MIN_N = 30


def bucket_of(edge: Decimal | None) -> str:
    if edge is None:
        return NO_ESTIMATE
    for lo, hi, label in BUCKETS:
        if (lo is None or edge >= lo) and (hi is None or edge < hi):
            return label
    return NO_ESTIMATE


def _d(v: Any) -> Decimal | None:
    try:
        d = Decimal(str(v))
        return d if d.is_finite() else None
    except (InvalidOperation, TypeError, ValueError):
        return None


@dataclass
class Fill:
    ref: str
    ts: str
    symbol: str
    outcome: str
    side: str
    quantity: Decimal
    price: Decimal
    fee: Decimal
    event_ticker: str


@dataclass
class Lot:
    ref: str
    symbol: str
    outcome: str
    event_ticker: str
    quantity: Decimal
    price: Decimal
    fee: Decimal
    edge: Decimal | None
    q: Decimal | None
    q_adj: Decimal | None
    remaining: Decimal
    proceeds: Decimal = _ZERO
    settled_win: bool | None = None
    market_q: Decimal | None = None      # market probability for this outcome at decision time
    resolved_win: bool | None = None     # contract resolved in this outcome's favour (held or not)

    @property
    def cost(self) -> Decimal:
        return self.quantity * (self.price + self.fee)

    @property
    def closed(self) -> bool:
        return self.remaining == 0

    @property
    def expected_return(self) -> Decimal | None:
        if self.q_adj is None:
            return None
        return (self.q_adj - self.price - self.fee) / (self.price + self.fee)

    @property
    def raw_expected_return(self) -> Decimal | None:
        if self.q is None:
            return None
        return (self.q - self.price - self.fee) / (self.price + self.fee)

    @property
    def realized_return(self) -> Decimal | None:
        return (self.proceeds - self.cost) / self.cost if self.closed and self.cost > 0 else None


def build_lots(fills: list[Fill], research: dict[str, dict], resolve: Callable[[str, str], str | None]) -> list[Lot]:
    lots: list[Lot] = []
    open_by_key: dict[tuple[str, str], list[Lot]] = {}
    for f in sorted(fills, key=lambda f: f.ts):
        key = (f.symbol, f.outcome)
        if f.side == "buy":
            r = research.get(f.ref) or {}
            lot = Lot(f.ref, f.symbol, f.outcome, f.event_ticker, f.quantity, f.price, f.fee,
                      _d(r.get("edge")), _d(r.get("q")), _d(r.get("q_adj")), f.quantity)
            mid = yes_mid(r.get("book"), f.outcome, None, None)
            lot.market_q = (mid if f.outcome == "yes" else Decimal(1) - mid) if mid is not None else f.price
            lots.append(lot)
            open_by_key.setdefault(key, []).append(lot)
        else:
            left = f.quantity
            for lot in open_by_key.get(key, []):
                take = min(lot.remaining, left)
                lot.proceeds += take * (f.price - f.fee)
                lot.remaining -= take
                left -= take
                if left == 0:
                    break
    for lot in lots:
        side = resolve(lot.event_ticker, lot.symbol)
        if side in ("yes", "no"):
            lot.resolved_win = side == lot.outcome
        if lot.remaining > 0:
            if side in ("yes", "no"):
                lot.settled_win = side == lot.outcome
                lot.proceeds += lot.remaining * (Decimal(1) if lot.settled_win else _ZERO)
                lot.remaining = _ZERO
    return lots


def _mean(xs: list[Decimal]) -> Decimal | None:
    return sum(xs, _ZERO) / len(xs) if xs else None


def yes_mid(book: Any, outcome: str | None, buy_price: Any, sell_price: Any) -> Decimal | None:
    """YES-space mid from a logged book (best_bid/best_ask), else from an outcome's buy/sell prices."""
    if isinstance(book, dict):
        bb, ba = _d(book.get("best_bid")), _d(book.get("best_ask"))
        if bb is not None and ba is not None:
            return (bb + ba) / 2
    b, s = _d(buy_price), _d(sell_price)
    if b is not None and s is not None and outcome in ("yes", "no"):
        mid = (b + s) / 2
        return mid if outcome == "yes" else Decimal(1) - mid
    return None


def brier(pairs: list[tuple[Decimal, bool]]) -> Decimal | None:
    """Mean squared error of probability forecasts against 0/1 outcomes."""
    return _mean([(f - (Decimal(1) if won else _ZERO)) ** 2 for f, won in pairs])


def summarize(lots: list[Lot]) -> list[dict[str, Any]]:
    rows = []
    labels = [b[2] for b in BUCKETS] + [NO_ESTIMATE, "ALL"]
    for label in labels:
        group = lots if label == "ALL" else [l for l in lots if bucket_of(l.edge) == label]
        if not group:
            continue
        closed = [l for l in group if l.closed]
        settled = [l for l in closed if l.settled_win is not None]
        cost = sum((l.cost for l in closed), _ZERO)
        pnl = sum((l.proceeds - l.cost for l in closed), _ZERO)

        def r(x: Decimal | None, places: str = "0.0001") -> str | None:
            return None if x is None else format(x.quantize(Decimal(places)), "f")

        scored = [l for l in group if l.resolved_win is not None and l.q is not None and l.market_q is not None]
        b_me = brier([(l.q, l.resolved_win) for l in scored])
        b_adj = brier([(l.q_adj, l.resolved_win) for l in scored if l.q_adj is not None])
        b_mkt = brier([(l.market_q, l.resolved_win) for l in scored])
        rows.append({
            "bucket": label,
            "trades": len(group),
            "n_scored": len(scored),
            "low_n": len(scored) < MIN_N,
            "brier_mine": r(b_me),
            "brier_mine_q_adj": r(b_adj),
            "brier_market": r(b_mkt),
            "brier_skill": r(Decimal(1) - b_me / b_mkt) if b_me is not None and b_mkt else None,
            "closed": len(closed),
            "open": len(group) - len(closed),
            "mean_expected_return": r(_mean([l.expected_return for l in closed if l.expected_return is not None])),
            "mean_raw_expected_return": r(_mean([l.raw_expected_return for l in closed
                                                 if l.raw_expected_return is not None])),
            "mean_realized_return": r(_mean([l.realized_return for l in closed if l.realized_return is not None])),
            "pnl_usd": r(pnl, "0.01"),
            "return_on_cost": r(pnl / cost) if cost > 0 else None,
            "held_to_settlement": len(settled),
            "win_rate": r(Decimal(sum(1 for l in settled if l.settled_win)) / len(settled)) if settled else None,
            "mean_q_adj_settled": r(_mean([l.q_adj for l in settled if l.q_adj is not None])),
        })
    return rows


def estimate_brier(entries: list[dict[str, Any]], resolve: Callable[[str, str], str | None]) -> dict[str, Any]:
    """Score every researched contract (traded or not): my P(YES) vs the market's YES mid at the time.

    One sample per contract per UTC day (the latest), so repeated runs don't overweight a contract.
    """
    latest: dict[tuple[str, str], tuple[str, Decimal, Decimal, str]] = {}
    for e in entries:
        if e.get("event") != "decision" or e.get("estimate") is None or not e.get("instrument_symbol"):
            continue
        p_yes = _d(e.get("estimate"))
        mid = yes_mid(e.get("book"), e.get("outcome"), e.get("buy_price"), e.get("sell_price"))
        if p_yes is None or mid is None:
            continue
        key = (e["instrument_symbol"], str(e.get("ts", ""))[:10])
        if key not in latest or str(e.get("ts", "")) >= latest[key][0]:
            latest[key] = (str(e.get("ts", "")), p_yes, mid, e.get("event_ticker") or "")
    mine, market, points = [], [], []
    models: Counter = Counter()
    for (symbol, day), (_, p_yes, mid, ev) in latest.items():
        side = resolve(ev, symbol)
        if side not in ("yes", "no"):
            continue
        won = side == "yes"
        mine.append((p_yes, won))
        market.append((mid, won))
        points.append({"symbol": symbol, "day": day, "p_yes": format(p_yes, "f"), "market": format(mid, "f"),
                       "won": won})
    b_me, b_mkt = brier(mine), brier(market)
    for e in entries:
        if e.get("event") == "decision" and e.get("research_model"):
            models[e["research_model"]] += 1
    fmt = (lambda x: None if x is None else format(x.quantize(Decimal("0.0001")), "f"))
    return {"n_scored": len(mine), "n_estimates": len(latest), "low_n": len(mine) < MIN_N,
            "brier_mine": fmt(b_me), "brier_market": fmt(b_mkt),
            "brier_skill": fmt(Decimal(1) - b_me / b_mkt) if b_me is not None and b_mkt else None,
            "estimates_by_model": dict(models), "points": points}


def decision_summary(entries: list[dict[str, Any]]) -> dict[str, Any]:
    decisions = [e for e in entries if e.get("event") == "decision"]
    kinds = Counter(e.get("kind") for e in decisions)
    reasons: Counter = Counter()
    for e in decisions:
        if e.get("kind") in ("no_trade", "hold", "exit", "skip"):
            text = e.get("reason") or "; ".join(e.get("reasons") or [])
            reasons[(e.get("kind"), str(text).split(":")[0][:60])] += 1
    return {"by_kind": dict(kinds), "top_reasons": [{"kind": k, "reason": r, "count": n}
                                                    for (k, r), n in reasons.most_common(15)]}


# --------------------------------------------------------------------------- data loading


def read_audit(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def paper_fills(ledger: dict[str, Any]) -> list[Fill]:
    out = []
    for o in ledger.get("orders") or []:
        if not o.get("filled"):
            continue
        q, p, fee = _d(o.get("quantity")), _d(o.get("price")), _d(o.get("fee")) or _ZERO
        if q is None or p is None:
            continue
        out.append(Fill(o["paper_order_id"], o.get("ts", ""), o["symbol"], o["outcome"], o["side"], q, p, fee,
                        o.get("event_ticker", "")))
    return out


def live_fills(audit: list[dict[str, Any]], client: Any, fee: Decimal) -> list[Fill]:
    """Live placements from audit.log, with fills from order history (read-only)."""
    placed = [e for e in audit if e.get("order_id") is not None and (
        e.get("event") == "placement"  # audit logs written before order_intent/order_result existed
        or (e.get("event") == "order_result" and e.get("result") == "placed"))]
    if not placed:
        return []
    history: dict[int, dict] = {}
    for page in range(5):
        orders = (client.list_order_history(limit=1000, offset=page * 1000) or {}).get("orders") or []
        for o in orders:
            try:
                history[int(o.get("orderId"))] = o
            except (TypeError, ValueError):
                continue
        if len(orders) < 1000:
            break
    out = []
    for e in placed:
        try:
            o = history.get(int(e["order_id"]))
        except (TypeError, ValueError):
            continue
        filled, avg = (_d(o.get("filledQuantity")), _d(o.get("avgExecutionPrice"))) if o else (None, None)
        if not filled or avg is None:
            continue
        out.append(Fill(f"live:{e['order_id']}", e.get("ts", ""), e["instrument_symbol"], e["outcome"], e["side"],
                        filled, avg, fee, e.get("resolved_event_ticker", "")))
    return out


def unknown_orders(audit: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Live sends whose outcome isn't known: an order_intent with no order_result, or an 'unconfirmed' result."""
    results = {e.get("intent_id"): e for e in audit if e.get("event") == "order_result"}
    out = []
    for e in audit:
        if e.get("event") != "order_intent":
            continue
        r = results.get(e.get("intent_id"))
        if r is not None and r.get("result") != "unconfirmed":
            continue
        if r is None:
            why = "no result logged"
        elif r.get("error"):  # timeout, connection error, 5xx...
            why = f"outcome unconfirmed: {str(r['error'])[:160]}"
        else:
            why = "outcome unconfirmed: Gemini's reply didn't confirm it"
        out.append({"intent_id": e.get("intent_id"), "ts": e.get("ts"), "action": e.get("action"),
                    "instrument_symbol": e.get("instrument_symbol"), "side": e.get("side"),
                    "outcome": e.get("outcome"), "quantity": e.get("quantity"), "limit_price": e.get("limit_price"),
                    "order_id": e.get("order_id"), "status": f"unknown, check Gemini ({why})"})
    return out


def make_resolver(client: Any) -> Callable[[str, str], str | None]:
    cache: dict[str, dict] = {}

    def resolve(event_ticker: str, symbol: str) -> str | None:
        if event_ticker not in cache:
            try:
                cache[event_ticker] = client.get_event(event_ticker)
            except Exception:  # noqa: BLE001 - unresolved means "still open" in the report
                cache[event_ticker] = {}
        for c in cache[event_ticker].get("contracts") or []:
            if c.get("instrumentSymbol") == symbol:
                side = c.get("resolutionSide")
                return side if side in ("yes", "no") else None
        return None

    return resolve


def format_report(rows: list[dict[str, Any]], decisions: dict[str, Any], est: dict[str, Any] | None = None,
                  unknown: list[dict[str, Any]] | None = None) -> str:
    cols = [("bucket", 10), ("trades", 6), ("closed", 6), ("open", 4), ("mean_expected_return", 9),
            ("mean_raw_expected_return", 9), ("mean_realized_return", 9), ("pnl_usd", 9), ("return_on_cost", 8),
            ("held_to_settlement", 7), ("win_rate", 8), ("mean_q_adj_settled", 8), ("n_scored", 6),
            ("brier_mine", 8), ("brier_market", 8), ("low_n", 7)]
    heads = ["bucket", "trades", "closed", "open", "exp", "exp(raw q)", "realized", "P&L $", "RoC", "settled",
             "win rate", "mean q_adj", "N", "Brier me", "Brier mkt", "flag"]
    lines = []
    if unknown:
        lines += [f"ORDERS WITH UNKNOWN OUTCOME ({len(unknown)}): an order or cancel was sent but its result is "
                  "unknown, check Gemini"]
        for u in unknown:
            what = (f"cancel order {u['order_id']}" if u["action"] == "cancel" else
                    f"{str(u['side']).upper()} {str(u['outcome']).upper()} x {u['quantity']} "
                    f"{u['instrument_symbol']} @ {u['limit_price']}")
            lines.append(f"  {u['ts']}  intent {u['intent_id']}  {what}  -> {u['status']}")
        lines.append("")
    lines += ["REALIZED vs EXPECTED RETURN BY STATED EDGE",
             "  ".join(h.rjust(w) for h, (_, w) in zip(heads, cols))]
    for row in rows:
        cells = {**row, "low_n": f"N<{MIN_N}" if row["low_n"] else ""}
        lines.append("  ".join(str(cells[c] if cells[c] is not None else "-").rjust(w) for c, w in cols))
    if not rows:
        lines.append("  (no filled trades yet)")
    lines += ["", "If realized trails expected in the high-edge buckets, the stated edges are overconfident.",
              "Compare win rate with mean q_adj for calibration. Brier: lower is better; if mine is not below",
              f"the market's, the estimates add nothing over the price. N = resolved contracts scored; N<{MIN_N} "
              "is too few to conclude anything."]
    if est is not None:
        flag = f"  [N<{MIN_N}: not enough data]" if est["low_n"] else ""
        lines += ["", "ALL RESEARCHED CONTRACTS (traded or not; one sample per contract per day)",
                  f"  N scored {est['n_scored']} of {est['n_estimates']} estimates   Brier me {est['brier_mine'] or '-'}"
                  f"   Brier market {est['brier_market'] or '-'}   skill {est['brier_skill'] or '-'}{flag}",
                  f"  estimates by model: {est['estimates_by_model'] or '-'}"]
    lines += ["", "DECISIONS"]
    for k, n in sorted(decisions["by_kind"].items(), key=lambda kv: -kv[1]):
        lines.append(f"  {k}: {n}")
    if decisions["top_reasons"]:
        lines.append("  top reasons:")
        for r in decisions["top_reasons"]:
            lines.append(f"    {r['count']:>4}  {r['kind']}: {r['reason']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", action="store_true", help="fetch live fills from Gemini order history")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    import os

    from dotenv import load_dotenv

    from gemini_client import ReadOnlyClient
    from guardrails import load_config, parse_env

    load_dotenv(HERE / ".env", override=False)
    config = load_config(HERE / "config.yaml")
    client = ReadOnlyClient(parse_env(os.environ.get("GEMINI_ENV")), os.environ.get("GEMINI_API_KEY"),
                            os.environ.get("GEMINI_API_SECRET"), os.environ.get("GEMINI_ACCOUNT"))
    ledger_path = HERE / "paper_ledger.json"
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    audit = read_audit(HERE / "audit.log")
    fills = paper_fills(ledger)
    if args.live:
        fills += live_fills(audit, client, config.fee_per_contract)
    resolver = make_resolver(client)
    lots = build_lots(fills, ledger.get("research") or {}, resolver)
    rows, decisions, est = summarize(lots), decision_summary(audit), estimate_brier(audit, resolver)
    unknown = unknown_orders(audit)
    if args.json:
        print(json.dumps({"unknown_orders": unknown, "buckets": rows, "all_estimates": est, "decisions": decisions,
                          "lots": [{**asdict(l), "closed": l.closed} for l in lots]}, default=str, indent=2))
    else:
        print(format_report(rows, decisions, est, unknown))
    return 0


if __name__ == "__main__":
    sys.exit(main())

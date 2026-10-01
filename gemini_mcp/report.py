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
        if lot.remaining > 0:
            side = resolve(lot.event_ticker, lot.symbol)
            if side in ("yes", "no"):
                lot.settled_win = side == lot.outcome
                lot.proceeds += lot.remaining * (Decimal(1) if lot.settled_win else _ZERO)
                lot.remaining = _ZERO
    return lots


def _mean(xs: list[Decimal]) -> Decimal | None:
    return sum(xs, _ZERO) / len(xs) if xs else None


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

        rows.append({
            "bucket": label,
            "trades": len(group),
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
    placed = [e for e in audit if e.get("event") == "placement" and e.get("order_id") is not None]
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


def format_report(rows: list[dict[str, Any]], decisions: dict[str, Any]) -> str:
    cols = [("bucket", 10), ("trades", 6), ("closed", 6), ("open", 4), ("mean_expected_return", 9),
            ("mean_raw_expected_return", 9), ("mean_realized_return", 9), ("pnl_usd", 9), ("return_on_cost", 8),
            ("held_to_settlement", 7), ("win_rate", 8), ("mean_q_adj_settled", 8)]
    heads = ["bucket", "trades", "closed", "open", "exp", "exp(raw q)", "realized", "P&L $", "RoC", "settled",
             "win rate", "mean q_adj"]
    lines = ["REALIZED vs EXPECTED RETURN BY STATED EDGE",
             "  ".join(h.rjust(w) for h, (_, w) in zip(heads, cols))]
    for row in rows:
        lines.append("  ".join(str(row[c] if row[c] is not None else "-").rjust(w) for c, w in cols))
    if not rows:
        lines.append("  (no filled trades yet)")
    lines += ["", "If realized trails expected in the high-edge buckets, the stated edges are overconfident.",
              "Compare win rate with mean q_adj for calibration.", "", "DECISIONS"]
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
    lots = build_lots(fills, ledger.get("research") or {}, make_resolver(client))
    rows, decisions = summarize(lots), decision_summary(audit)
    if args.json:
        print(json.dumps({"buckets": rows, "decisions": decisions,
                          "lots": [{**asdict(l), "closed": l.closed} for l in lots]}, default=str, indent=2))
    else:
        print(format_report(rows, decisions))
    return 0


if __name__ == "__main__":
    sys.exit(main())

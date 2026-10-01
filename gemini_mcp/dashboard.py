"""Read-only dashboard: one self-contained HTML file built from the local logs and state.

    python report.py --json > report.json     # optional: calibration and Brier panels (calls Gemini, read-only)
    python dashboard.py                       # writes dashboard.html next to this file
    python dashboard.py --out /tmp/d.html --report report.json

Inputs, all opened read-only: audit.log, paper_ledger.json, state/risk_state.json, state/daily_spend.json,
KILL, config.yaml and (optional) the JSON written by ``report.py --json``.

It never writes to any of those files. It never calls Gemini, Anthropic or anything else; it doesn't even
import the HTTP client. The only file it writes is the output HTML, and it refuses an output path that is
one of its inputs or inside state/. The page carries a Content-Security-Policy that blocks every network
request (connect-src 'none'). The only links are research source URLs (http/https only), which open in a new tab
when you click them. Every string from the logs (theses, sources, reasons) is HTML-escaped.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
MAX_TIMELINE = 250
MIN_N = 30  # same threshold report.py uses for "too few to conclude"


# =============================================================================================== loading


def _read_text(path: Path, limit: int = 50_000_000) -> str | None:
    """Read-only. Missing or unreadable -> None."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return None


def _read_json(path: Path) -> Any:
    raw = _read_text(path)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return {"_unreadable": True}


def _read_audit(path: Path) -> list[dict[str, Any]]:
    raw = _read_text(path)
    out = []
    for line in (raw or "").splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e, dict):
            out.append(e)
    return out


@dataclass
class Inputs:
    root: Path
    audit: list[dict[str, Any]]
    paper: Any
    risk: Any
    spend: Any
    kill: str | None
    config: dict[str, Any]
    config_error: str | None
    report: Any
    report_path: Path | None


def load_inputs(root: Path, report_path: Path | None = None) -> Inputs:
    import yaml  # PyYAML: pure parsing

    cfg_raw = _read_text(root / "config.yaml")
    config, config_error = {}, None
    try:
        config = yaml.safe_load(cfg_raw or "") or {}
        if not isinstance(config, dict):
            config, config_error = {}, "config.yaml is not a mapping"
    except yaml.YAMLError as e:
        config_error = f"config.yaml is not valid YAML: {e}"
    if cfg_raw is None:
        config_error = "config.yaml not found"
    if report_path is None and (root / "report.json").exists():
        report_path = root / "report.json"
    return Inputs(
        root=root, audit=_read_audit(root / "audit.log"), paper=_read_json(root / "paper_ledger.json"),
        risk=_read_json(root / "state" / "risk_state.json"), spend=_read_json(root / "state" / "daily_spend.json"),
        kill=_read_text(root / "KILL", 20_000) if (root / "KILL").exists() or (root / "KILL").is_symlink() else None,
        config=config, config_error=config_error,
        report=_read_json(report_path) if report_path else None, report_path=report_path,
    )


# =============================================================================================== model


def _d(v: Any) -> Decimal | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        d = Decimal(str(v))
    except InvalidOperation:
        return None
    return d if d.is_finite() else None


def mode_key_from_label(label: Any) -> str | None:
    """'LIVE (production): REAL MONEY' -> 'production:live'; 'DRY RUN (sandbox): ...' -> 'sandbox:dry_run'."""
    if not isinstance(label, str):
        return None
    env = "production" if "(production)" in label else "sandbox" if "(sandbox)" in label else None
    if env is None:
        return None
    return f"{env}:{'dry_run' if label.startswith('DRY RUN') else 'live'}"


@dataclass
class Model:
    generated: str
    mode_key: str | None
    mode_label: str | None
    other_modes: list[str]
    equity_series: list[dict[str, Any]] = field(default_factory=list)
    current: dict[str, Any] = field(default_factory=dict)
    limits: dict[str, Any] = field(default_factory=dict)
    positions: list[dict[str, Any]] = field(default_factory=list)
    positions_note: str = ""
    timeline: list[dict[str, Any]] = field(default_factory=list)
    kind_counts: Counter = field(default_factory=Counter)
    contracts: list[dict[str, Any]] = field(default_factory=list)
    calibration: dict[str, Any] = field(default_factory=dict)
    buckets: list[dict[str, Any]] = field(default_factory=list)
    brier_all: dict[str, Any] = field(default_factory=dict)
    attention: list[dict[str, Any]] = field(default_factory=list)
    report_note: str = ""
    config_error: str | None = None


def _today(now: datetime) -> str:
    return now.strftime("%Y-%m-%d")


def build_model(inp: Inputs, now: datetime | None = None) -> Model:
    now = now or datetime.now(timezone.utc)
    today = _today(now)
    audit = inp.audit

    # ---- which mode to show: the most recent one the server logged
    labels = [e.get("mode") for e in audit if isinstance(e.get("mode"), str) and mode_key_from_label(e.get("mode"))]
    mode_label = labels[-1] if labels else None
    keys = set()
    for src in (inp.risk, (inp.spend or {}).get("spend") if isinstance(inp.spend, dict) else None):
        if isinstance(src, dict):
            keys |= {k for k in src if isinstance(k, str) and ":" in k}
    mode_key = mode_key_from_label(mode_label) or (sorted(keys)[0] if keys else None)
    m = Model(generated=now.isoformat(timespec="seconds"), mode_key=mode_key, mode_label=mode_label,
              other_modes=sorted(k for k in keys if k != mode_key), config_error=inp.config_error)
    in_mode = [e for e in audit if mode_key_from_label(e.get("mode")) in (mode_key, None)]

    # ---- equity series from run_start risk snapshots and breaker trips (this mode only)
    for e in audit:
        risk = e.get("risk") if e.get("event") == "decision" and e.get("kind") == "run_start" else None
        if isinstance(risk, dict) and mode_key_from_label(risk.get("mode")) == mode_key:
            pt = {"ts": e.get("ts"), "equity": _d(risk.get("equity_usd")), "peak": _d(risk.get("peak_equity_usd")),
                  "floor": _d(risk.get("equity_floor_usd")), "day_start": _d(risk.get("day_start_equity_usd")),
                  "risk": risk}
        elif e.get("event") == "circuit_breaker_trip" and mode_key_from_label(e.get("mode")) == mode_key:
            pt = {"ts": e.get("ts"), "equity": _d(e.get("equity")), "peak": _d(e.get("peak")),
                  "floor": _d(e.get("floor")), "day_start": _d(e.get("day_start")), "trip": e.get("reason")}
        else:
            continue
        if pt["equity"] is not None and isinstance(pt["ts"], str):
            m.equity_series.append(pt)

    # ---- current state: state files + config + latest snapshot
    cfg = inp.config
    st = (inp.risk or {}).get(mode_key) if isinstance(inp.risk, dict) and mode_key else None
    st = st if isinstance(st, dict) else {}
    spend = inp.spend if isinstance(inp.spend, dict) else {}
    spent = _d(((spend.get("spend") or {}).get(mode_key) or {}).get(today)) or Decimal(0)
    trades = ((spend.get("trades") or {}).get(mode_key) or {}).get(today) or 0
    last = m.equity_series[-1] if m.equity_series else {}
    equity, peak = last.get("equity"), _d(st.get("peak")) or last.get("peak")
    day_start = _d(st.get("day_start")) if st.get("day") == today else None
    floor = last.get("floor")
    max_usd, max_pct = _d(cfg.get("max_daily_spend_usd", 25)), _d(cfg.get("max_daily_spend_pct", 0.25))
    daily_limit = None
    if max_usd is not None and max_pct is not None and day_start is not None:
        daily_limit = min(max_usd, max_pct * day_start)
    elif max_usd is not None:
        daily_limit = max_usd
    m.current = {"equity": equity, "peak": peak, "floor": floor, "day_start": day_start,
                 "drawdown": (peak - equity) / peak if equity is not None and peak else None,
                 "to_floor": (equity - floor) / equity if equity and floor is not None else None,
                 "tripped": st.get("tripped"), "as_of": last.get("ts")}
    m.limits = {"spent": spent, "daily_limit": daily_limit, "trades": trades,
                "max_trades": cfg.get("max_trades_per_day", 5), "max_open_orders": cfg.get("max_open_orders", 3),
                "max_order_usd": _d(cfg.get("max_order_usd", 10)), "max_drawdown_pct": _d(cfg.get("max_drawdown_pct", 0.20)),
                "max_daily_loss_pct": _d(cfg.get("max_daily_loss_pct", 0.08))}

    # ---- positions
    if mode_key and mode_key.endswith(":dry_run") and isinstance(inp.paper, dict):
        research = inp.paper.get("research") if isinstance(inp.paper.get("research"), dict) else {}
        for p in (inp.paper.get("positions") or {}).values():
            if not isinstance(p, dict):
                continue
            recs = [r for r in research.values() if isinstance(r, dict) and r.get("instrument_symbol") == p.get("symbol")
                    and r.get("outcome") == p.get("outcome") and r.get("kind") == "entry"]
            r = max(recs, key=lambda r: str(r.get("ts", ""))) if recs else {}
            m.positions.append({"symbol": p.get("symbol"), "outcome": p.get("outcome"), "event": p.get("event_ticker"),
                                "quantity": _d(p.get("quantity")), "cost": _d(p.get("cost_basis")),
                                "estimate": r.get("estimate"), "thesis": r.get("thesis")})
        m.positions_note = "Paper positions from paper_ledger.json (cost basis; no live quotes are fetched)."
    else:
        # Only the most recent run's position review: a position sold since then must not linger here.
        starts = [i for i, e in enumerate(in_mode) if e.get("event") == "decision" and e.get("kind") == "run_start"]
        last_run = in_mode[starts[-1]:] if starts else []
        latest: dict[tuple, dict] = {}
        for e in last_run:
            if e.get("event") == "decision" and e.get("held_quantity") is not None and e.get("instrument_symbol"):
                latest[(e["instrument_symbol"], e.get("outcome"))] = e
        for (sym, out), e in sorted(latest.items(), key=lambda kv: str(kv[0])):
            m.positions.append({"symbol": sym, "outcome": out, "event": e.get("event_ticker"),
                                "quantity": _d(e.get("held_quantity")), "cost": None, "estimate": e.get("estimate"),
                                "thesis": e.get("thesis"), "as_of": e.get("ts"), "last_decision": e.get("kind")})
        m.positions_note = ("Live positions from the last runner run's position review "
                            f"({fmt_ts(last_run[0].get('ts')) if last_run else 'no run yet'}). The dashboard never calls "
                            "Gemini; check the website for the current state.")

    # ---- decision timeline
    decisions = [e for e in in_mode if e.get("event") == "decision" and e.get("kind") not in ("run_start", "run_end")]
    m.kind_counts = Counter(e.get("kind") for e in decisions)
    for e in reversed(decisions[-MAX_TIMELINE:]):
        reason = e.get("reason") or "; ".join(r for r in (e.get("reasons") or []) if isinstance(r, str))
        m.timeline.append({"ts": e.get("ts"), "kind": str(e.get("kind")), "symbol": e.get("instrument_symbol"),
                           "outcome": e.get("outcome"), "reason": reason, "estimate": e.get("estimate"),
                           "edge": e.get("edge"), "quantity": e.get("quantity"), "price": e.get("limit_price")})

    # ---- per-contract research (latest per symbol)
    by_sym: dict[str, dict] = {}
    for e in decisions:
        if e.get("thesis") and e.get("instrument_symbol"):
            by_sym[e["instrument_symbol"]] = e
    for sym, e in sorted(by_sym.items(), key=lambda kv: str(kv[1].get("ts")), reverse=True):
        m.contracts.append({"symbol": sym, "ts": e.get("ts"), "kind": e.get("kind"), "estimate": e.get("estimate"),
                            "q_adj": e.get("q_adj") or e.get("q_adj_now"), "edge": e.get("edge") or e.get("edge_now"),
                            "thesis": e.get("thesis"), "invalidation": e.get("invalidation_conditions") or [],
                            "facts": e.get("key_facts") or [], "sources": e.get("sources") or [],
                            "model": e.get("research_model"), "fallback": e.get("research_fallback_used"),
                            "rules": e.get("resolution_rules_summary")})

    # ---- report-driven panels
    rep = inp.report
    if isinstance(rep, dict) and not rep.get("_unreadable"):
        m.buckets = [b for b in rep.get("buckets") or [] if isinstance(b, dict)]
        m.brier_all = rep.get("all_estimates") if isinstance(rep.get("all_estimates"), dict) else {}
        pts = []
        for p in (m.brier_all.get("points") or []):
            q, mk = _d(p.get("p_yes")), _d(p.get("market"))
            if q is not None and isinstance(p.get("won"), bool):
                pts.append((q, mk, p["won"]))
        if not pts:  # fall back to traded lots
            for lot in rep.get("lots") or []:
                q, mk = _d(lot.get("q")), _d(lot.get("market_q"))
                if q is not None and isinstance(lot.get("resolved_win"), bool):
                    pts.append((q, mk, lot["resolved_win"]))
        m.calibration = calibration_bins(pts)
        m.report_note = f"From {inp.report_path.name if inp.report_path else 'report'}."
    else:
        m.report_note = ("No report data. Run  python report.py --json > report.json  first (it resolves contracts "
                         "with read-only Gemini calls); the dashboard itself never calls an API.")

    m.attention = attention_items(inp, in_mode, mode_key, today, m)
    return m


def calibration_bins(points: list[tuple[Decimal, Decimal | None, bool]], n_bins: int = 10) -> dict[str, Any]:
    """Reliability bins: for my estimates and for the market, mean predicted vs observed YES rate, with N."""
    out: dict[str, Any] = {"n": len(points), "mine": [], "market": []}
    for name, idx in (("mine", 0), ("market", 1)):
        bins: dict[int, list[tuple[float, bool]]] = defaultdict(list)
        for p in points:
            v = p[idx]
            if v is None:
                continue
            b = min(int(float(v) * n_bins), n_bins - 1)
            bins[b].append((float(v), p[2]))
        for b in sorted(bins):
            vals = bins[b]
            out[name].append({"bin": b, "lo": b / n_bins, "hi": (b + 1) / n_bins, "n": len(vals),
                              "predicted": sum(v for v, _ in vals) / len(vals),
                              "observed": sum(1 for _, w in vals if w) / len(vals)})
    return out


def attention_items(inp: Inputs, in_mode: list[dict], mode_key: str | None, today: str, m: Model) -> list[dict]:
    items: list[dict[str, Any]] = []
    if inp.kill is not None:
        body = inp.kill.strip()
        try:
            k = json.loads(body)
            summary = f"created by {k.get('created_by')}: {k.get('reason')}" if isinstance(k, dict) else body
        except ValueError:
            summary = body or "(empty file)"
        items.append({"level": "critical", "title": "KILL file present: every order tool is disabled",
                      "detail": summary, "raw": body[:4000]})
    if m.current.get("tripped"):
        items.append({"level": "critical", "title": "Circuit breaker is tripped",
                      "detail": str((m.current["tripped"] or {}).get("reason", m.current["tripped"]))})
    try:
        from report import unknown_orders  # pure function; report.py imports no HTTP client at module level

        unknown = unknown_orders(inp.audit)
    except Exception:  # noqa: BLE001 - the dashboard must render even if report.py changes
        unknown = []
    for u in unknown:
        what = (f"cancel order {u.get('order_id')}" if u.get("action") == "cancel" else
                f"{str(u.get('side')).upper()} {str(u.get('outcome')).upper()} x {u.get('quantity')} "
                f"{u.get('instrument_symbol')} @ {u.get('limit_price')}")
        items.append({"level": "critical", "title": "Order with unknown outcome: check Gemini",
                      "detail": f"{fmt_ts(u.get('ts'))} · {what} · {u.get('status')}"})
    trips = [e for e in inp.audit if e.get("event") == "circuit_breaker_trip"]
    for e in trips[-5:]:
        items.append({"level": "serious", "title": "Circuit breaker trip", "detail": f"{fmt_ts(e.get('ts'))} · {e.get('reason')}"})
    for e in [e for e in inp.audit if e.get("event") in ("kill_detected", "kill_deleted")][-3:]:
        items.append({"level": "warning", "title": e["event"].replace("_", " ").capitalize(),
                      "detail": f"{fmt_ts(e.get('noticed_at') or e.get('ts'))} · {json.dumps(e.get('kill'))[:300]}"})
    thin = [e for e in in_mode if e.get("event") == "decision" and e.get("kind") == "no_trade"
            and "thin book" in str(e.get("reason"))]
    thin_today = [e for e in thin if str(e.get("ts", "")).startswith(today)]
    if thin:
        items.append({"level": "info", "title": "Skipped for no depth (thin book)",
                      "detail": f"{len(thin_today)} today · {len(thin)} in the log"})
    failed = [e for e in in_mode if e.get("event") == "decision" and str(e.get("kind", "")).endswith("_failed")]
    if failed:
        items.append({"level": "warning", "title": "Failed decisions (entry/exit/review)",
                      "detail": f"{len(failed)} in the log; latest: {fmt_ts(failed[-1].get('ts'))} · "
                                f"{str(failed[-1].get('reason'))[:200]}"})
    pending = [e for e in in_mode if e.get("event") == "decision" and e.get("kind") == "proposed_not_confirmed"]
    if pending:
        items.append({"level": "info", "title": "Live proposals not confirmed",
                      "detail": f"{len(pending)} (no terminal approval)"})
    last_risk = (m.equity_series[-1].get("risk") or {}) if m.equity_series else {}
    noquote = last_risk.get("positions_without_quote") or []
    if noquote:
        items.append({"level": "warning", "title": "Positions without a live quote (valued at $0)",
                      "detail": ", ".join(map(str, noquote))})
    if last_risk.get("breaker_would_trip"):
        items.append({"level": "serious", "title": "A breaker would trip on the next order",
                      "detail": str(last_risk["breaker_would_trip"])})
    if inp.config_error:
        items.append({"level": "serious", "title": "Config problem", "detail": inp.config_error})
    return items


# =============================================================================================== rendering


def esc(v: Any) -> str:
    return html.escape("" if v is None else str(v), quote=True)


def safe_url(u: Any) -> str | None:
    if not isinstance(u, str) or len(u) > 2000:
        return None
    p = urlparse(u.strip())
    return u.strip() if p.scheme in ("http", "https") and p.netloc else None


def money(v: Decimal | None, places: int = 2) -> str:
    return "—" if v is None else f"${v:,.{places}f}"


def pct(v: Decimal | float | None, places: int = 1) -> str:
    return "—" if v is None else f"{float(v) * 100:.{places}f}%"


def fmt_ts(ts: Any) -> str:
    if not isinstance(ts, str):
        return "—"
    return ts.replace("T", " ")[:16] + " UTC" if len(ts) >= 16 else ts


def _nice_ticks(lo: float, hi: float, n: int = 4) -> list[float]:
    if hi <= lo:
        hi = lo + 1
    raw = (hi - lo) / n
    mag = 10 ** math.floor(math.log10(raw))
    step = next(s * mag for s in (1, 2, 2.5, 5, 10) if s * mag >= raw)
    start = math.floor(lo / step) * step
    ticks, v = [], start
    while v <= hi + step * 0.5:
        ticks.append(round(v, 10))
        v += step
    return ticks


def equity_chart(series: list[dict[str, Any]]) -> str:
    pts = [p for p in series if p["equity"] is not None]
    if len(pts) < 2:
        return ('<p class="empty">Not enough history yet. Each runner start records a risk snapshot; '
                'the chart appears after two runs.</p>')
    W, H, L, R, T, B = 720, 260, 64, 108, 16, 32
    vals = [float(v) for p in pts for v in (p["equity"], p["peak"], p["floor"]) if v is not None]
    ticks = _nice_ticks(min(vals) * 0.98, max(vals) * 1.02)
    y0, y1 = ticks[0], ticks[-1]
    n = len(pts)

    def X(i: int) -> float:
        return L + (W - L - R) * (i / (n - 1))

    def Y(v: float) -> float:
        return T + (H - T - B) * (1 - (v - y0) / (y1 - y0))

    g = [f'<line class="grid" x1="{L}" x2="{W - R}" y1="{Y(t):.1f}" y2="{Y(t):.1f}"/>'
         f'<text class="tick" x="{L - 8}" y="{Y(t) + 4:.1f}" text-anchor="end">${t:,.0f}</text>' for t in ticks]
    eq = [(X(i), Y(float(p["equity"]))) for i, p in enumerate(pts)]
    pk = [(X(i), Y(float(p["peak"]))) for i, p in enumerate(pts) if p["peak"] is not None]
    fl = [(X(i), Y(float(p["floor"]))) for i, p in enumerate(pts) if p["floor"] is not None]

    def path(xy: list[tuple[float, float]]) -> str:
        return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in xy)

    out = [f'<svg class="chart" viewBox="0 0 {W} {H}" role="img" aria-label="Equity, peak and floor over time" '
           f'data-crosshair="equity">', *g]
    if len(pk) == len(eq):  # drawdown wash between peak and equity
        poly = eq + list(reversed(pk))
        out.append(f'<path class="dd-area" d="{path(poly)} Z"/>')
    if fl:
        out.append(f'<path class="line floor" d="{path(fl)}"/>')
        fx, fy = fl[-1]
        out.append(f'<text class="end-label crit" x="{fx + 8:.1f}" y="{fy + 4:.1f}">⚠ floor {money(pts[-1]["floor"], 0)}</text>')
    if pk:
        out.append(f'<path class="line peak" d="{path(pk)}"/>')
        px, py = pk[-1]
        out.append(f'<text class="end-label" x="{px + 8:.1f}" y="{py - 6:.1f}">peak {money(pts[-1]["peak"], 0)}</text>')
    out.append(f'<path class="line s1" d="{path(eq)}"/>')
    ex, ey = eq[-1]
    out.append(f'<circle class="dot s1" cx="{ex:.1f}" cy="{ey:.1f}" r="4.5"/>')
    out.append(f'<text class="end-label strong" x="{ex + 8:.1f}" y="{ey + 4:.1f}">{money(pts[-1]["equity"], 0)}</text>')
    for i, p in enumerate(pts):  # invisible hit targets with native tooltips
        tip = f"{fmt_ts(p['ts'])}\nequity {money(p['equity'])}\npeak {money(p['peak'])}\nfloor {money(p['floor'])}"
        if p.get("trip"):
            tip += f"\nTRIP: {p['trip']}"
            out.append(f'<text class="trip-mark" x="{X(i):.1f}" y="{T + 10}" text-anchor="middle">⚠</text>')
        out.append(f'<rect class="hit" x="{X(i) - 6:.1f}" y="{T}" width="12" height="{H - T - B}" '
                   f'data-i="{i}"><title>{esc(tip)}</title></rect>')
    out.append(f'<text class="tick" x="{L}" y="{H - 8}">{esc(fmt_ts(pts[0]["ts"]))}</text>'
               f'<text class="tick" x="{W - R}" y="{H - 8}" text-anchor="end">{esc(fmt_ts(pts[-1]["ts"]))}</text>')
    out.append("</svg>")
    data = [{"ts": fmt_ts(p["ts"]), "equity": money(p["equity"]), "peak": money(p["peak"]), "floor": money(p["floor"]),
             "x": round(X(i) / W, 4)} for i, p in enumerate(pts)]
    out.append(f'<script type="application/json" class="xh-data">{json.dumps(data).replace("<", "&lt;")}</script>')
    rows = "".join(f"<tr><td>{esc(fmt_ts(p['ts']))}</td><td>{money(p['equity'])}</td><td>{money(p['peak'])}</td>"
                   f"<td>{money(p['floor'])}</td><td>{esc(p.get('trip') or '')}</td></tr>" for p in pts)
    out.append(f'<details class="tableview"><summary>Table view</summary><div class="table-wrap"><table><thead><tr><th>Time</th><th>Equity</th>'
               f'<th>Peak</th><th>Floor</th><th>Trip</th></tr></thead><tbody>{rows}</tbody></table></div></details>')
    return "".join(out)


def meter(label: str, used: float | None, limit: float | None, fmt: str) -> str:
    if used is None or not limit:
        frac = 0.0
        text = f"{'—' if used is None else fmt.format(used)} of {fmt.format(limit) if limit else '—'}"
    else:
        frac, text = max(0.0, min(used / limit, 1.0)), f"{fmt.format(used)} of {fmt.format(limit)}"
    sev = "crit" if frac >= 0.9 else "warn" if frac >= 0.7 else "ok"
    icon = {"crit": "⚠ ", "warn": "▲ ", "ok": ""}[sev]
    return (f'<div class="meter {sev}"><div class="meter-head"><span>{esc(label)}</span>'
            f'<span class="num">{icon}{esc(text)}</span></div>'
            f'<div class="track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="{frac * 100:.0f}" '
            f'aria-label="{esc(label)}"><div class="fill" style="width:{frac * 100:.1f}%"></div></div></div>')


def calibration_chart(cal: dict[str, Any]) -> str:
    if not cal or not cal.get("n"):
        return '<p class="empty">No resolved contracts yet.</p>'
    S, P = 300, 40
    W = S + P + 20

    def C(v: float) -> float:
        return P + S * v

    def Yc(v: float) -> float:
        return 10 + S * (1 - v)

    out = [f'<svg class="chart square" viewBox="0 0 {W} {S + 50}" role="img" '
           f'aria-label="Calibration: predicted probability versus observed frequency">']
    for t in (0, 0.25, 0.5, 0.75, 1):
        out.append(f'<line class="grid" x1="{C(0)}" x2="{C(1)}" y1="{Yc(t)}" y2="{Yc(t)}"/>'
                   f'<text class="tick" x="{P - 6}" y="{Yc(t) + 4}" text-anchor="end">{t:.0%}</text>'
                   f'<text class="tick" x="{C(t)}" y="{S + 28}" text-anchor="middle">{t:.0%}</text>')
    out.append(f'<line class="ref" x1="{C(0)}" y1="{Yc(0)}" x2="{C(1)}" y2="{Yc(1)}"/>')
    for name, cls in (("market", "s2"), ("mine", "s1")):
        for b in cal.get(name) or []:
            r = 4 + min(b["n"], 50) / 50 * 5
            tip = (f"{'My estimates' if name == 'mine' else 'Market price'} {b['lo']:.0%}–{b['hi']:.0%}\n"
                   f"predicted {b['predicted']:.1%} · observed {b['observed']:.1%} · N={b['n']}")
            out.append(f'<circle class="dot {cls}{" low" if b["n"] < 5 else ""}" cx="{C(b["predicted"]):.1f}" '
                       f'cy="{Yc(b["observed"]):.1f}" r="{r:.1f}"><title>{esc(tip)}</title></circle>')
    out.append(f'<text class="axis-title" x="{C(0.5)}" y="{S + 46}" text-anchor="middle">predicted P(YES)</text>')
    out.append("</svg>")
    rows = "".join(f"<tr><td>{b['lo']:.0%}–{b['hi']:.0%}</td><td>{'mine' if k == 'mine' else 'market'}</td>"
                   f"<td class='num'>{b['predicted']:.1%}</td><td class='num'>{b['observed']:.1%}</td>"
                   f"<td class='num'>{b['n']}</td></tr>" for k in ("mine", "market") for b in cal.get(k) or [])
    out.append(f'<details class="tableview"><summary>Table view</summary><div class="table-wrap"><table><thead><tr><th>Bin</th><th>Series</th>'
               f'<th>Predicted</th><th>Observed</th><th>N</th></tr></thead><tbody>{rows}</tbody></table></div></details>')
    return "".join(out)


def brier_chart(buckets: list[dict[str, Any]], overall: dict[str, Any]) -> str:
    rows = [b for b in buckets if _d(b.get("brier_mine")) is not None or _d(b.get("brier_market")) is not None]
    head = ""
    if overall and overall.get("n_scored"):
        me, mk = _d(overall.get("brier_mine")), _d(overall.get("brier_market"))
        verdict = ("better than the market" if me is not None and mk is not None and me < mk else
                   "not better than the market" if me is not None and mk is not None else "")
        low = overall.get("low_n") or (overall.get("n_scored") or 0) < MIN_N
        head = (f'<div class="brier-head"><div><span class="kicker">All researched contracts</span>'
                f'<div class="big">{esc(overall.get("brier_mine") or "—")}<span class="vs">vs</span>'
                f'{esc(overall.get("brier_market") or "—")}</div>'
                f'<span class="sub">my Brier vs market Brier · lower is better · {esc(verdict)}</span></div>'
                f'<div class="nbadge{" low" if low else ""}">N={esc(overall.get("n_scored"))}'
                f'{"<br><small>too few to conclude</small>" if low else ""}</div></div>')
    if not rows:
        return head + '<p class="empty">No scored trades per edge bucket yet.</p>'
    W, L, rowh = 640, 120, 46
    H = 20 + rowh * len(rows) + 24
    vals = [float(v) for b in rows for v in (_d(b.get("brier_mine")), _d(b.get("brier_market"))) if v is not None]
    top = max(0.3, max(vals) * 1.1)

    def X(v: float) -> float:
        return L + (W - L - 70) * (v / top)

    out = [head, f'<svg class="chart" viewBox="0 0 {W} {H}" role="img" aria-label="Brier score by edge bucket">']
    for t in _nice_ticks(0, top, 4):
        if t <= top:
            out.append(f'<line class="grid" x1="{X(t):.1f}" x2="{X(t):.1f}" y1="12" y2="{H - 22}"/>'
                       f'<text class="tick" x="{X(t):.1f}" y="{H - 6}" text-anchor="middle">{t:.2f}</text>')
    for i, b in enumerate(rows):
        y = 18 + i * rowh
        low = b.get("low_n")
        out.append(f'<text class="cat" x="{L - 10}" y="{y + 15}" text-anchor="end">{esc(b.get("bucket"))}</text>'
                   f'<text class="tick" x="{L - 10}" y="{y + 30}" text-anchor="end">N={esc(b.get("n_scored"))}'
                   f'{" · low N" if low else ""}</text>')
        for j, (key, cls, name) in enumerate((("brier_mine", "s1", "mine"), ("brier_market", "s2", "market"))):
            v = _d(b.get(key))
            if v is None:
                continue
            x2 = X(float(v))
            yy = y + 4 + j * 15
            out.append(f'<path class="bar {cls}{" hatched" if low else ""}" d="M{L},{yy} H{x2 - 4:.1f} '
                       f'a4,4 0 0 1 4,4 v3 a4,4 0 0 1 -4,4 H{L} Z"><title>{esc(b.get("bucket"))} · {name} '
                       f'Brier {v} · N={esc(b.get("n_scored"))}</title></path>'
                       f'<text class="val" x="{x2 + 6:.1f}" y="{yy + 9}">{v}</text>')
    out.append("</svg>")
    trs = "".join(f"<tr><td>{esc(b.get('bucket'))}</td><td class='num'>{esc(b.get('n_scored'))}</td>"
                  f"<td class='num'>{esc(b.get('brier_mine') or '—')}</td><td class='num'>{esc(b.get('brier_market') or '—')}</td>"
                  f"<td class='num'>{esc(b.get('mean_realized_return') or '—')}</td><td class='num'>{esc(b.get('pnl_usd') or '—')}</td>"
                  f"<td>{'N&lt;' + str(MIN_N) if b.get('low_n') else ''}</td></tr>" for b in buckets)
    out.append(f'<details class="tableview"><summary>Table view (with returns)</summary><div class="table-wrap"><table><thead><tr>'
               f'<th>Edge bucket</th><th>N</th><th>Brier me</th><th>Brier market</th><th>Realized return</th>'
               f'<th>P&amp;L $</th><th></th></tr></thead><tbody>{trs}</tbody></table></div></details>')
    return "".join(out)


KIND_CLASS = {"entry": "k-entry", "exit": "k-exit", "hold": "k-hold", "skip": "k-skip", "no_trade": "k-skip",
              "proposed_not_confirmed": "k-warn", "review_failed": "k-bad", "exit_rejected": "k-bad",
              "run_skipped": "k-warn"}


def kind_class(kind: str) -> str:
    if kind.endswith("_failed"):
        return "k-bad"
    return KIND_CLASS.get(kind, "k-skip")


def render(m: Model) -> str:
    live = bool(m.mode_key and m.mode_key.endswith(":live"))
    prod = bool(m.mode_key and m.mode_key.startswith("production"))
    mode_cls = "mode-live-prod" if live and prod else "mode-live" if live else "mode-dry"
    mode_word = ("LIVE · REAL MONEY" if live and prod else "LIVE · SANDBOX" if live else
                 "DRY RUN · PAPER" if m.mode_key else "NO DATA YET")
    c, lim = m.current, m.limits

    # ---- header + hero
    dd = c.get("drawdown")
    eq, ds = c.get("equity"), c.get("day_start")
    day_loss = max(float((ds - eq) / ds), 0.0) if eq is not None and ds else None
    tiles = [
        ("Peak", money(c.get("peak")), ""),
        ("Drawdown from peak", pct(dd), f"breaker at {pct(lim.get('max_drawdown_pct'), 0)}"),
        ("Equity floor", money(c.get("floor")), f"{pct(c.get('to_floor'))} above it" if c.get("to_floor") is not None else ""),
        ("Today's start", money(c.get("day_start")), f"daily-loss breaker {pct(lim.get('max_daily_loss_pct'), 0)}"),
    ]
    tile_html = "".join(f'<div class="tile"><span class="label">{esc(a)}</span><span class="value">{esc(b)}</span>'
                        f'<span class="sub">{esc(s)}</span></div>' for a, b, s in tiles)

    att = m.attention
    order = {"critical": 0, "serious": 1, "warning": 2, "info": 3}
    icons = {"critical": "⛔", "serious": "⚠", "warning": "▲", "info": "ℹ"}
    att_html = "".join(
        f'<li class="att {esc(a["level"])}"><span class="att-icon" aria-hidden="true">{icons[a["level"]]}</span>'
        f'<div><strong>{esc(a["title"])}</strong><span class="lvl">{esc(a["level"])}</span>'
        f'<p>{esc(a["detail"])}</p>'
        + (f'<details><summary>File contents</summary><pre>{esc(a["raw"])}</pre></details>' if a.get("raw") else "")
        + "</div></li>"
        for a in sorted(att, key=lambda a: order[a["level"]]))
    att_block = (f'<ul class="att-list">{att_html}</ul>' if att else
                 '<p class="allclear"><span aria-hidden="true">✓</span> Nothing needs attention: no KILL file, no '
                 'unknown orders, no breaker trips.</p>')

    meters = (meter("Spent today (UTC)", float(lim["spent"]), float(lim["daily_limit"]) if lim.get("daily_limit") else None,
                    "${:,.2f}")
              + meter("Orders placed today", float(lim.get("trades") or 0), float(lim.get("max_trades") or 0), "{:,.0f}")
              + meter("Drawdown vs breaker", float(dd) if dd is not None else None,
                      float(lim["max_drawdown_pct"]) if lim.get("max_drawdown_pct") else None, "{:.1%}")
              + meter("Today's loss vs breaker", day_loss, float(lim["max_daily_loss_pct"])
                      if lim.get("max_daily_loss_pct") else None, "{:.1%}"))
    limits_note = (f'Per-order ceiling {money(lim.get("max_order_usd"))} · max open orders {esc(lim.get("max_open_orders"))}. '
                   'The daily limit is the lower of max_daily_spend_usd and max_daily_spend_pct × today\'s start.')

    paper_mode = not live
    pos_rows = "".join(
        f"<tr><td class='sym'>{esc(p['symbol'])}</td><td>{esc(str(p.get('outcome') or '').upper())}</td>"
        f"<td class='num'>{esc(p['quantity'])}</td>"
        + (f"<td class='num'>{money(p.get('cost'))}</td>" if paper_mode else
           f"<td><span class='kind {kind_class(str(p.get('last_decision')))}'>{esc(p.get('last_decision'))}</span></td>")
        + f"<td class='num'>{esc(p.get('estimate') or '—')}</td><td class='thesis' title='{esc(p.get('thesis') or '')}'>"
        f"<span class='clamp'>{esc(p.get('thesis') or '')}</span></td></tr>"
        for p in m.positions)
    col3 = "Cost" if paper_mode else "Last decision"
    pos_html = (f'<div class="table-wrap"><table class="data"><thead><tr><th>Contract</th><th>Side</th><th>Qty</th>'
                f'<th>{col3}</th><th>P(YES) est.</th><th>Thesis</th></tr></thead><tbody>{pos_rows}</tbody></table></div>'
                if m.positions else '<p class="empty">No open positions.</p>')

    kinds = sorted(m.kind_counts.items(), key=lambda kv: -kv[1])
    chips = '<button class="chip on" data-kind="*">All <span>{}</span></button>'.format(sum(m.kind_counts.values())) + "".join(
        f'<button class="chip" data-kind="{esc(k)}"><i class="{kind_class(str(k))}"></i>{esc(k)} <span>{n}</span></button>'
        for k, n in kinds)
    tl = "".join(
        f'<li data-kind="{esc(t["kind"])}"><time>{esc(fmt_ts(t["ts"]))}</time>'
        f'<span class="kind {kind_class(t["kind"])}">{esc(t["kind"])}</span>'
        f'<span class="sym">{esc(t["symbol"] or "")}{(" · " + esc(str(t["outcome"]).upper())) if t.get("outcome") else ""}</span>'
        f'<span class="reason">{esc(t["reason"])}</span>'
        + (f'<span class="meta">P(YES) {esc(t["estimate"])}' + (f' · edge {esc(t["edge"])}' if t.get("edge") else "")
           + (f' · {esc(t["quantity"])} @ {esc(t["price"])}' if t.get("quantity") else "") + "</span>"
           if t.get("estimate") else "")
        + "</li>" for t in m.timeline)
    tl_html = (f'<div class="chips" role="toolbar" aria-label="Filter decisions">{chips}</div><ol class="timeline">{tl}</ol>'
               if m.timeline else '<p class="empty">No decisions logged yet.</p>')

    def src_list(sources: list) -> str:
        items = []
        for s in sources[:12]:
            if not isinstance(s, dict):
                continue
            url = safe_url(s.get("url"))
            title = s.get("title") or s.get("url") or "source"
            host = urlparse(url).netloc if url else ""
            bare = host[4:] if host.startswith("www.") else host
            label = esc(title) + (f' <span class="host">{esc(host)}</span>' if host and bare not in str(title) else "")
            items.append(f'<li><a href="{esc(url)}" target="_blank" rel="noopener noreferrer nofollow">{label}</a></li>'
                         if url else f"<li>{label}</li>")
        return f'<ul class="sources">{"".join(items)}</ul>' if items else '<p class="empty">No sources recorded.</p>'

    cards = [
        f'<article class="contract"><header><span class="sym">{esc(k["symbol"])}</span>'
        f'<span class="kind {kind_class(str(k["kind"]))}">{esc(k["kind"])}</span><time>{esc(fmt_ts(k["ts"]))}</time></header>'
        f'<dl><div><dt>P(YES)</dt><dd>{esc(k["estimate"] or "—")}</dd></div><div><dt>q adj</dt><dd>{esc(k["q_adj"] or "—")}</dd></div>'
        f'<div><dt>edge</dt><dd>{esc(k["edge"] or "—")}</dd></div></dl>'
        f'<p class="model">{esc(k["model"] or "model unknown")}{" · fallback model used" if k.get("fallback") else ""}'
        f' · {len(k["sources"])} sources</p>'
        f'<p class="thesis">{esc(k["thesis"])}</p>'
        + (f'<p class="rules"><span class="kicker">Resolves</span> {esc(k["rules"])}</p>' if k.get("rules") else "")
        + (f'<p class="kicker">Would invalidate it</p><ul class="inval">{"".join(f"<li>{esc(x)}</li>" for x in k["invalidation"][:6])}</ul>'
           if k["invalidation"] else "")
        + f'<p class="kicker">Sources</p>{src_list(k["sources"])}</article>'
        for k in m.contracts[:60]]
    contracts_html = (f'<div class="contracts">{"".join(cards[:6])}</div>'
                      + (f'<details class="more"><summary>Show {len(cards) - 6} more contracts</summary>'
                         f'<div class="contracts">{"".join(cards[6:])}</div></details>' if len(cards) > 6 else "")
                      if cards else '<p class="empty">No research recorded yet.</p>')

    other = (f'<span class="other">Also in the logs: {esc(", ".join(m.other_modes))}</span>' if m.other_modes else "")
    body = f"""
<header class="top {mode_cls}">
  <div class="brand"><span class="mark" aria-hidden="true"></span><span>gemini_mcp</span><span class="sep">/</span><span>desk</span></div>
  <div class="mode"><span class="mode-word">{esc(mode_word)}</span><span class="mode-key">{esc(m.mode_key or '')}</span>{other}</div>
  <div class="meta"><span>Generated {esc(fmt_ts(m.generated))}</span>
    <button id="theme" class="theme" type="button" aria-label="Switch color theme">◐ <span>auto</span></button></div>
</header>
<main>
  <section class="hero card">
    <div class="hero-main">
      <span class="kicker">Equity · {esc(m.mode_key or '')}</span>
      <div class="hero-figure">{esc(money(c.get('equity')))}</div>
      <span class="sub">as of {esc(fmt_ts(c.get('as_of')))} (last runner start or breaker check)</span>
    </div>
    <div class="tiles">{tile_html}</div>
  </section>

  <section class="card attention" aria-labelledby="h-att"><h2 id="h-att">Needs attention</h2>{att_block}</section>

  <section class="card span2" aria-labelledby="h-eq"><h2 id="h-eq">Equity, peak and floor</h2>
    <div class="legend"><span><i class="key s1"></i>equity</span><span><i class="key peak"></i>peak</span>
      <span><i class="key floor"></i>⚠ absolute floor</span><span><i class="key dd"></i>drawdown from peak</span></div>
    <div class="chart-wrap">{equity_chart(m.equity_series)}<div class="xh-tip" hidden></div></div></section>

  <section class="card" aria-labelledby="h-lim"><h2 id="h-lim">Today vs limits</h2>{meters}
    <p class="note">{limits_note}</p></section>

  <section class="card wide" aria-labelledby="h-pos"><h2 id="h-pos">Open positions</h2>{pos_html}
    <p class="note">{esc(m.positions_note)}</p></section>

  <section class="card wide" aria-labelledby="h-tl"><h2 id="h-tl">Decisions</h2>{tl_html}</section>

  <section class="card" aria-labelledby="h-cal"><h2 id="h-cal">Calibration</h2>
    <div class="legend"><span><i class="key dot s1"></i>my estimates</span><span><i class="key dot s2"></i>market price</span>
      <span><i class="key diag"></i>perfect calibration</span><span class="muted">dot size = N per bin</span></div>
    {calibration_chart(m.calibration)}<p class="note">{esc(m.report_note)}</p></section>

  <section class="card span2" aria-labelledby="h-brier"><h2 id="h-brier">Brier score: me vs market</h2>
    <div class="legend"><span><i class="key sq s1"></i>mine</span><span><i class="key sq s2"></i>market</span>
      <span class="muted">faded = fewer than {MIN_N} scored (too few to conclude)</span></div>
    {brier_chart(m.buckets, m.brier_all)}</section>

  <section class="card wide" aria-labelledby="h-res"><h2 id="h-res">Research by contract</h2>
    {contracts_html}</section>
</main>
<footer>Read-only view of local files. It never calls Gemini or Anthropic, and never changes state. Untrusted text from
research is shown as plain text.</footer>
"""
    return PAGE.replace("{{BODY}}", body)


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<title>Trading desk</title>
<style>
:root {
  color-scheme: light;
  --page: #f4f3ef; --surface: #fcfcfb; --raise: #ffffff; --ink: #0b0b0b; --ink-2: #52514e; --muted: #7a7873;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,.10);
  --s1: #2a78d6; --s2: #eb6834; --s1-wash: rgba(42,120,214,.10); --track: #cde2fb;
  --good: #0ca30c; --good-ink: #006300; --warn: #fab219; --serious: #ec835a; --crit: #d03b3b; --crit-wash: rgba(208,59,59,.10);
  --live-prod: #b42323; --live-sbx: #8a5a00; --dry: #1c5cab;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --raise: #20201f; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #8f8d86;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,.10);
    --s1: #3987e5; --s2: #d95926; --s1-wash: rgba(57,135,229,.12); --track: #184f95;
    --good-ink: #0ca30c; --crit-wash: rgba(208,59,59,.16);
    --live-prod: #e66767; --live-sbx: #eda100; --dry: #6da7ec;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --raise: #20201f; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #8f8d86;
  --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,.10);
  --s1: #3987e5; --s2: #d95926; --s1-wash: rgba(57,135,229,.12); --track: #184f95;
  --good-ink: #0ca30c; --crit-wash: rgba(208,59,59,.16);
  --live-prod: #e66767; --live-sbx: #eda100; --dry: #6da7ec;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.sym, time { white-space: nowrap; }
.sym, time, .mode-key, pre, .host { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .86em; }
.num, td.num, .tick, .meter-head .num { font-variant-numeric: tabular-nums; }
a { color: var(--s1); }
.top { position: sticky; top: 0; z-index: 5; display: grid; grid-template-columns: auto 1fr auto; gap: 16px; align-items: center;
  padding: 12px 24px; background: color-mix(in srgb, var(--page) 88%, transparent); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--ring); }
.top::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 4px; background: var(--mode-color); }
.mode-live-prod { --mode-color: var(--live-prod); } .mode-live { --mode-color: var(--live-sbx); } .mode-dry { --mode-color: var(--dry); }
.brand { display: flex; gap: 6px; align-items: center; font-weight: 600; letter-spacing: -.01em; }
.brand .sep { color: var(--muted); } .mark { width: 14px; height: 14px; border-radius: 3px; background: var(--mode-color); }
.mode { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; justify-content: center; }
.mode-word { font-weight: 700; letter-spacing: .14em; font-size: 13px; color: var(--mode-color); }
.mode-key, .other, .meta { color: var(--ink-2); font-size: 13px; }
.meta { display: flex; gap: 12px; align-items: center; }
.theme { font: inherit; font-size: 13px; color: var(--ink); background: var(--raise); border: 1px solid var(--ring); border-radius: 999px;
  padding: 4px 12px; cursor: pointer; }
main { max-width: 1280px; margin: 0 auto; padding: 24px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.card { background: var(--surface); border: 1px solid var(--ring); border-radius: 14px; padding: 20px 22px; min-width: 0; }
.wide, .hero, .attention { grid-column: 1 / -1; } .span2 { grid-column: span 2; }
.table-wrap { overflow-x: auto; max-width: 100%; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.more { margin-top: 14px; } .more > summary { cursor: pointer; color: var(--ink-2); font-size: 14px; margin-bottom: 12px; }
h2 { margin: 0 0 14px; font-size: 13px; font-weight: 650; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); }
.kicker { display: block; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 10px 0 4px; }
.hero { display: grid; grid-template-columns: minmax(240px, 1fr) 2fr; gap: 24px; align-items: center; }
.hero-figure { font-size: clamp(44px, 7vw, 68px); font-weight: 650; letter-spacing: -.035em; line-height: 1; margin: 4px 0 8px; }
.sub { color: var(--ink-2); font-size: 13px; }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.tile { border-left: 1px solid var(--grid); padding: 2px 0 2px 14px; display: flex; flex-direction: column; gap: 2px; }
.tile .label { font-size: 13px; color: var(--ink-2); } .tile .value { font-size: 24px; font-weight: 600; letter-spacing: -.02em; }
.attention { border-color: var(--ring); }
.att-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.att { display: grid; grid-template-columns: 28px 1fr; gap: 10px; padding: 12px 14px; border-radius: 10px; background: var(--raise);
  border: 1px solid var(--ring); border-left: 4px solid var(--lvl); }
.att.critical { --lvl: var(--crit); background: var(--crit-wash); } .att.serious { --lvl: var(--serious); }
.att.warning { --lvl: var(--warn); } .att.info { --lvl: var(--axis); }
.att-icon { font-size: 18px; line-height: 1.3; } .att p { margin: 2px 0 0; color: var(--ink-2); overflow-wrap: anywhere; }
.att .lvl { margin-left: 8px; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.att pre { white-space: pre-wrap; max-height: 260px; overflow: auto; background: var(--surface); padding: 10px; border-radius: 8px; }
.allclear { margin: 0; color: var(--good-ink); font-weight: 600; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--ink-2); margin: -4px 0 10px; }
.legend .muted { color: var(--muted); }
.key { display: inline-block; width: 16px; height: 2px; vertical-align: middle; margin-right: 6px; background: var(--ink-2); }
.key.s1 { background: var(--s1); } .key.s2 { background: var(--s2); } .key.peak { background: var(--ink-2); height: 1.5px; }
.key.floor { background: var(--crit); } .key.dd { height: 10px; background: var(--crit-wash); border: 1px solid var(--grid); }
.key.dot { width: 10px; height: 10px; border-radius: 50%; } .key.sq { width: 10px; height: 10px; border-radius: 2px; }
.key.diag { width: 14px; height: 1px; background: var(--axis); transform: rotate(-35deg); }
.chart-wrap { position: relative; }
svg.chart { width: 100%; height: auto; display: block; overflow: visible; }
svg.chart.square { max-width: 420px; margin: 0 auto; }
.grid { stroke: var(--grid); stroke-width: 1; } .ref { stroke: var(--axis); stroke-width: 1; }
.tick, .cat, .val, .end-label, .axis-title, .trip-mark { fill: var(--muted); font-size: 12px; }
.cat { fill: var(--ink); font-size: 13px; } .val { fill: var(--ink-2); } .end-label { fill: var(--ink-2); }
.end-label.strong { fill: var(--ink); font-weight: 600; } .end-label.crit, .trip-mark { fill: var(--crit); }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.line.s1 { stroke: var(--s1); } .line.peak { stroke: var(--ink-2); stroke-width: 1.5; } .line.floor { stroke: var(--crit); stroke-width: 1.5; }
.dd-area { fill: var(--crit-wash); }
.dot { stroke: var(--surface); stroke-width: 2; } .dot.s1 { fill: var(--s1); } .dot.s2 { fill: var(--s2); } .dot.low { opacity: .55; }
.bar.s1 { fill: var(--s1); } .bar.s2 { fill: var(--s2); } .bar.hatched { opacity: .55; }
.hit { fill: transparent; } .hit:hover { fill: var(--s1-wash); }
.xh-tip { position: absolute; top: 8px; pointer-events: none; background: var(--raise); border: 1px solid var(--ring); border-radius: 8px;
  padding: 8px 10px; font-size: 12px; line-height: 1.5; box-shadow: 0 6px 20px rgba(0,0,0,.12); min-width: 150px; }
.xh-line { position: absolute; top: 16px; bottom: 32px; width: 1px; background: var(--axis); pointer-events: none; }
.meter { margin: 0 0 18px; } .meter-head { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; margin-bottom: 6px; }
.track { height: 10px; border-radius: 999px; background: var(--track); overflow: hidden; }
.fill { height: 100%; border-radius: 999px; background: var(--s1); }
.meter.warn .fill { background: var(--warn); } .meter.crit .fill { background: var(--crit); }
.note { margin: 10px 0 0; font-size: 13px; color: var(--ink-2); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .06em;
  padding: 6px 8px; border-bottom: 1px solid var(--grid); }
td { padding: 8px; border-bottom: 1px solid var(--grid); vertical-align: top; } td.num { text-align: right; }
td.thesis { color: var(--ink-2); min-width: 200px; }
.tableview { margin-top: 10px; font-size: 13px; } .tableview summary { cursor: pointer; color: var(--ink-2); }
.tableview table { margin-top: 8px; }
.empty { color: var(--muted); margin: 6px 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.chip { font: inherit; font-size: 13px; border: 1px solid var(--ring); background: var(--raise); color: var(--ink); border-radius: 999px;
  padding: 3px 10px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.chip span { color: var(--muted); } .chip.on { border-color: var(--ink); }
.chip i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.timeline { list-style: none; margin: 0; padding: 0; max-height: 640px; overflow: auto; }
.timeline li { display: grid; grid-template-columns: 158px 150px minmax(0, 1fr); gap: 2px 12px; padding: 9px 4px;
  align-items: start;
  border-bottom: 1px solid var(--grid); }
.timeline li[hidden] { display: none; }
.timeline .reason { grid-column: 3; color: var(--ink-2); overflow-wrap: anywhere; } .timeline .sym { grid-column: 3; grid-row: 1; }
.timeline .reason { grid-row: 2; } .timeline .meta { grid-column: 3; grid-row: 3; font-size: 12px; color: var(--muted); }
.timeline time { color: var(--muted); }
.kind { justify-self: start; font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--ring);
  display: inline-flex; align-items: center; gap: 6px; height: fit-content; }
.kind::before, .chip i { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--k); }
.k-entry { --k: var(--s1); } .k-exit { --k: var(--s2); } .k-hold { --k: var(--ink-2); } .k-skip { --k: var(--axis); }
.k-warn { --k: var(--warn); } .k-bad { --k: var(--crit); }
.contracts { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.contract { border: 1px solid var(--ring); border-radius: 12px; padding: 14px 16px; background: var(--raise); min-width: 0; }
.contract header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.contract header time { margin-left: auto; color: var(--muted); }
.contract .model { margin: 0 0 6px; font-size: 12px; color: var(--muted); }
.contract dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 0 0 8px; }
.contract dt { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
.contract dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.contract .thesis { margin: 6px 0; } .contract .rules { color: var(--ink-2); font-size: 13px; }
.inval, .sources { margin: 0; padding-left: 18px; font-size: 13px; color: var(--ink-2); } .sources li { overflow-wrap: anywhere; }
.host { color: var(--muted); margin-left: 4px; }
.brier-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; }
.brier-head .big { font-size: 30px; font-weight: 650; letter-spacing: -.02em; } .brier-head .vs { font-size: 14px; color: var(--muted); margin: 0 8px; }
.nbadge { border: 1px solid var(--ring); border-radius: 10px; padding: 6px 10px; text-align: center; font-weight: 600; }
.nbadge.low { border-color: var(--warn); } .nbadge small { font-weight: 400; color: var(--ink-2); }
footer { max-width: 1280px; margin: 0 auto; padding: 8px 24px 40px; color: var(--muted); font-size: 12px; }
@media (max-width: 860px) {
  main { grid-template-columns: minmax(0, 1fr); padding: 16px; gap: 14px; } .span2 { grid-column: auto; }
  .hero { grid-template-columns: 1fr; } .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .top { grid-template-columns: 1fr auto; padding: 10px 16px; } .mode { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
  .timeline li { grid-template-columns: 1fr; } .timeline .sym, .timeline .reason, .timeline .meta { grid-column: 1; grid-row: auto; }
  .contract dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .card { padding: 16px; } table { font-size: 13px; }
}
@media print { .top { position: static; } .chips, .theme { display: none; } }
@media (forced-colors: active) { .fill, .key, .dot, .bar { forced-color-adjust: none; } }
</style>
</head>
<body>
{{BODY}}
<script>
(function () {
  var root = document.documentElement, btn = document.getElementById("theme"), modes = ["auto", "light", "dark"], cur = "auto";
  try { cur = localStorage.getItem("desk-theme") || "auto"; } catch (e) {}
  function apply(m) { cur = m; if (m === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", m);
    if (btn) btn.querySelector("span").textContent = m; try { localStorage.setItem("desk-theme", m); } catch (e) {} }
  apply(cur);
  if (btn) btn.addEventListener("click", function () { apply(modes[(modes.indexOf(cur) + 1) % 3]); });
  document.querySelectorAll(".chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      var k = chip.getAttribute("data-kind");
      document.querySelectorAll(".chip").forEach(function (c) { c.classList.toggle("on", c === chip); });
      document.querySelectorAll(".timeline li").forEach(function (li) { li.hidden = !(k === "*" || li.getAttribute("data-kind") === k); });
    });
  });
  document.querySelectorAll(".chart-wrap").forEach(function (wrap) {
    var svg = wrap.querySelector("svg[data-crosshair]"), dataEl = wrap.querySelector(".xh-data"), tip = wrap.querySelector(".xh-tip");
    if (!svg || !dataEl || !tip) return;
    var data = JSON.parse(dataEl.textContent), line = document.createElement("div");
    line.className = "xh-line"; line.hidden = true; wrap.appendChild(line);
    svg.addEventListener("mousemove", function (ev) {
      var r = svg.getBoundingClientRect(), fx = (ev.clientX - r.left) / r.width, best = 0;
      data.forEach(function (d, i) { if (Math.abs(d.x - fx) < Math.abs(data[best].x - fx)) best = i; });
      var d = data[best], left = d.x * r.width;
      line.style.left = left + "px"; line.hidden = false;
      tip.textContent = ""; [d.ts, "equity " + d.equity, "peak " + d.peak, "floor " + d.floor].forEach(function (t, i) {
        var s = document.createElement(i ? "div" : "strong"); s.textContent = t; tip.appendChild(s); });
      tip.hidden = false; tip.style.left = Math.min(left + 12, r.width - 170) + "px";
    });
    svg.addEventListener("mouseleave", function () { tip.hidden = true; line.hidden = true; });
  });
})();
</script>
</body>
</html>
"""


# =============================================================================================== main


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=HERE, help="folder holding audit.log, state/, ... (default: here)")
    ap.add_argument("--out", type=Path, default=None, help="output HTML (default: <root>/dashboard.html)")
    ap.add_argument("--report", type=Path, default=None, help="JSON from report.py --json (default: <root>/report.json)")
    args = ap.parse_args(argv)
    root = args.root.resolve()
    out = (args.out or root / "dashboard.html").resolve()
    protected = {root / n for n in ("audit.log", "paper_ledger.json", "KILL", "config.yaml", "report.json", ".env")}
    if args.report:
        protected.add(args.report.resolve())
    if out in protected or (root / "state") in out.parents or out.suffix.lower() not in (".html", ".htm"):
        print(f"refusing to write {out}: choose a new .html path outside state/", file=sys.stderr)
        return 2
    model = build_model(load_inputs(root, args.report))
    out.write_text(render(model), encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

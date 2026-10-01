"""Research-driven runner: reviews open positions, then scans allowlisted markets for entries.

    python runner.py                 # one pass; schedule it (cron) if you want it recurring
    python runner.py --auto-confirm  # live only: confirm without asking, if config allows it

It starts server.py as an MCP subprocess and only calls that server's tools, so
every guardrail (allowlist, caps, sizing ceilings, circuit breakers, KILL,
DRY_RUN) still applies. Each run:

1. Position review. Each open position (paper positions in DRY_RUN) is
   researched again. It's sold when the price has reached the estimate, the
   estimate dropped so the edge is gone, the thesis is invalidated, or it's
   near expiry and not clearly winning.
2. Entry scan. For each contract in an allowlisted event: skip wide spreads
   and thin books, research, compare both sides' edge with min_edge, let the
   server size the buy (Kelly, capped), check depth for that size, then
   confirm.

Every decision, including no-trade and hold, is written to audit.log as a
"decision" entry with its reasoning. Research for each trade is also stored
in paper_ledger.json.

Confirmation: DRY_RUN confirms automatically. Live asks on the terminal,
unless you pass --auto-confirm AND config.yaml sets runner_auto_confirm_live:
true. With no terminal (cron), live proposals are logged and not confirmed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable

from guardrails import (
    AuditLog,
    BookCheck,
    Config,
    PaperLedger,
    _levels,
    check_book,
    edge_after_fee,
    load_config,
    parse_dry_run,
    parse_env,
    shrink,
)
from research import Estimate, ResearchError

HERE = Path(__file__).resolve().parent
_ONE = Decimal(1)


# --------------------------------------------------------------------------- pure decisions


def outcome_prices(book: Any, outcome: str) -> tuple[Decimal | None, Decimal | None]:
    """(buy price, sell price) for an outcome from a YES-space book. None where a side is empty."""
    try:
        bids = sorted(_levels(book.get("bids")), key=lambda x: -x[0])
        asks = sorted(_levels(book.get("asks")), key=lambda x: x[0])
    except (AttributeError, TypeError, ValueError, IndexError, InvalidOperation):
        return None, None
    best_bid = bids[0][0] if bids else None
    best_ask = asks[0][0] if asks else None
    if outcome == "yes":
        return best_ask, best_bid
    return (_ONE - best_bid if best_bid is not None else None,
            _ONE - best_ask if best_ask is not None else None)


@dataclass
class EntryChoice:
    outcome: str | None
    p: Decimal | None
    q: Decimal | None
    q_adj: Decimal | None
    edge: Decimal | None
    sides: dict[str, dict[str, str]] = field(default_factory=dict)
    reason: str | None = None


def choose_entry(q_yes: Decimal, book: BookCheck, config: Config) -> EntryChoice:
    """Pick the side (YES or NO) with the larger shrunk edge; no trade below min_edge."""
    sides: dict[str, dict[str, Decimal]] = {}
    for outcome in ("yes", "no"):
        p = book.best_ask if outcome == "yes" else (_ONE - book.best_bid if book.best_bid is not None else None)
        if p is None or not (Decimal(0) < p < _ONE):
            continue
        q = q_yes if outcome == "yes" else _ONE - q_yes
        q_adj = shrink(q, p, config.estimate_weight)
        sides[outcome] = {"p": p, "q": q, "q_adj": q_adj, "edge": edge_after_fee(q_adj, p, config.fee_per_contract)}
    logged = {o: {k: format(v.quantize(Decimal("0.0001")), "f") for k, v in s.items()} for o, s in sides.items()}
    if not sides:
        return EntryChoice(None, None, None, None, None, logged, "no usable price on either side")
    best = max(sides, key=lambda o: sides[o]["edge"])
    s = sides[best]
    if s["edge"] < config.min_edge:
        return EntryChoice(None, s["p"], s["q"], s["q_adj"], s["edge"], logged,
                           f"best edge {s['edge']:.4f} ({best.upper()}) is below min_edge {config.min_edge}")
    return EntryChoice(best, s["p"], s["q"], s["q_adj"], s["edge"], logged)


@dataclass
class ExitDecision:
    sell: bool
    reasons: list[str]
    details: dict[str, Any]


def decide_exit(
    *,
    outcome: str,
    q_yes_now: Decimal,
    buy_price: Decimal | None,
    sell_price: Decimal | None,
    entry_q_adj: Decimal | None,
    thesis_invalidated: bool,
    invalidation_reason: str,
    hours_to_expiry: Decimal | None,
    config: Config,
) -> ExitDecision:
    """Sell when any exit condition holds; every condition that fired is listed."""
    q_now = q_yes_now if outcome == "yes" else _ONE - q_yes_now
    q_adj_now = shrink(q_now, buy_price, config.estimate_weight) if buy_price is not None else q_now
    edge_now = edge_after_fee(q_adj_now, buy_price, config.fee_per_contract) if buy_price is not None else None
    details = {
        "q_now": format(q_now, "f"),
        "q_adj_now": format(q_adj_now.quantize(Decimal("0.0001")), "f"),
        "buy_price": None if buy_price is None else format(buy_price, "f"),
        "sell_price": None if sell_price is None else format(sell_price, "f"),
        "edge_now": None if edge_now is None else format(edge_now.quantize(Decimal("0.0001")), "f"),
        "entry_q_adj": None if entry_q_adj is None else format(entry_q_adj, "f"),
        "hours_to_expiry": None if hours_to_expiry is None else format(hours_to_expiry.quantize(Decimal("0.1")), "f"),
    }
    if sell_price is None:
        return ExitDecision(False, ["hold: no bid to sell into"], details)

    reasons = []
    if sell_price >= q_adj_now:
        reasons.append(f"price_reached_estimate: sell price {sell_price} >= estimate {q_adj_now:.4f}; value is gone")
    dropped = entry_q_adj is None or q_adj_now < entry_q_adj
    if dropped and edge_now is not None and edge_now <= 0:
        reasons.append(f"edge_gone: estimate {q_adj_now:.4f} (entry {entry_q_adj}) leaves edge {edge_now:.4f} <= 0")
    if thesis_invalidated:
        reasons.append(f"thesis_invalidated: {invalidation_reason or 'no reason given'}")
    if hours_to_expiry is not None and hours_to_expiry <= config.exit_hours_before_expiry \
            and sell_price < config.clearly_winning_price:
        reasons.append(f"near_expiry_not_winning: {hours_to_expiry:.1f}h to expiry and sell price {sell_price} "
                       f"< clearly_winning_price {config.clearly_winning_price}")
    return ExitDecision(bool(reasons), reasons or ["hold: no exit condition met"], details)


def hours_until(expiry: Any, now: float) -> Decimal | None:
    if not isinstance(expiry, str) or not expiry:
        return None
    try:
        dt = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return Decimal(str(round((dt.timestamp() - now) / 3600, 3)))


# Charged when a research call's token usage is unknown or malformed (e.g. the API call itself failed): more than
# a typical call, so an unknown cost never under-counts the budget. Searches are charged at research_max_searches.
UNKNOWN_USAGE = {"input_tokens": 200_000, "output_tokens": 16_000}
_CENT = Decimal("0.01")


def _usage_ok(usage: Any) -> bool:
    return (isinstance(usage, dict) and all(isinstance(v, int) and not isinstance(v, bool) and v >= 0
                                            for v in usage.values()))


def research_cost_usd(usage: Any, searches: Any, config: Config) -> Decimal:
    """Estimated dollars for one research call, rounded up to the cent. Unknown or malformed usage is charged
    UNKNOWN_USAGE; unknown searches are charged research_max_searches."""
    if not _usage_ok(usage):
        usage, searches = UNKNOWN_USAGE, None
    if isinstance(searches, bool) or not isinstance(searches, int) or searches < 0:
        searches = config.research_max_searches
    m = Decimal(1_000_000)
    cost = (Decimal(usage.get("input_tokens", 0)) * config.research_input_usd_per_mtok / m
            + Decimal(usage.get("output_tokens", 0)) * config.research_output_usd_per_mtok / m
            + Decimal(searches) * config.research_usd_per_search)
    return cost.quantize(_CENT, rounding=ROUND_CEILING)


def contract_info(market: dict[str, Any], contract: dict[str, Any]) -> dict[str, Any]:
    """What the research step sees: the resolution rules, not prices."""
    return {
        "event_ticker": market.get("event_ticker"),
        "event_title": market.get("title"),
        "event_description": market.get("description"),
        "terms_link": market.get("terms_link"),
        "instrument_symbol": contract.get("instrument_symbol"),
        "contract_label": contract.get("label"),
        "contract_description": contract.get("description"),
        "terms_url": contract.get("terms_and_conditions_url"),
        "expiry": contract.get("expiry") or market.get("expiry"),
    }


# --------------------------------------------------------------------------- runner


def make_confirm(dry_run: bool, auto_flag: bool, config: Config, interactive: bool,
                 ask: Callable[[str], str] = input) -> Callable[[dict[str, Any]], str | bool]:
    """The confirm callback returns how the order was approved ("dry_run", "auto", "hand"), or False. "hand"
    means a person typed yes at the terminal; preflight's auto-confirm gate counts only those."""
    def confirm(preview: dict[str, Any]) -> str | bool:
        if dry_run:
            return "dry_run"
        if auto_flag and config.runner_auto_confirm_live:
            return "auto"
        if not interactive:
            return False
        answer = ask(f"\n{preview.get('mode')}\n{preview.get('summary')}\n"
                     f"worst-case ${preview.get('worst_case_cost_usd')}. Type 'yes' to confirm: ")
        return "hand" if answer.strip().lower() == "yes" else False
    return confirm


class Runner:
    def __init__(
        self,
        *,
        tools: Any,
        research: Callable[[dict[str, Any], dict[str, Any] | None], Estimate],
        config: Config,
        audit: AuditLog,
        paper: PaperLedger,
        dry_run: bool,
        confirm: Callable[[dict[str, Any]], bool],
        now: Callable[[], float] = time.time,
        out: Callable[[str], None] = print,
    ):
        self.tools = tools
        self.research = research
        self.config = config
        self.audit = audit
        self.paper = paper
        self.dry_run = dry_run
        self.confirm = confirm
        self.now = now
        self.out = out
        self.research_left = config.max_research_per_run
        self.run_cost = Decimal(0)        # estimated research dollars this run
        self.day_cost = Decimal(0)        # ... today (UTC), all runs and modes, read from audit.log at run start
        self.max_call_cost = Decimal(0)   # costliest single research call seen today: the next call's projection
        self.budget_logged = False
        self.held: set[str] = set()
        self.decisions: list[dict[str, Any]] = []

    # ---- helpers

    def log(self, kind: str, **fields: Any) -> None:
        rec = {"kind": kind, "mode": "dry_run" if self.dry_run else "live", **fields}
        self.decisions.append(rec)
        self.audit.write("decision", **rec)
        reason = fields.get("reason") or "; ".join(fields.get("reasons") or [])
        self.out(f"[{kind}] {fields.get('instrument_symbol', '')} {reason}".rstrip())

    def prior_for(self, symbol: str, outcome: str) -> dict[str, Any] | None:
        # Live and paper records share paper_ledger.json; never use one mode's estimate for the other.
        recs = [r for r in self.paper.snapshot()["research"].values()
                if r.get("instrument_symbol") == symbol and r.get("outcome") == outcome and r.get("kind") == "entry"
                and str(r.get("order_ref", "")).startswith("live:") == (not self.dry_run)]
        return max(recs, key=lambda r: r.get("ts", "")) if recs else None

    async def do_research(self, info: dict[str, Any], prior: dict[str, Any] | None) -> Estimate:
        self.research_left -= 1
        try:
            est = await asyncio.to_thread(self.research, info, prior)
        except ResearchError as e:
            self._charge(info, e.usage, e.searches, ok=False, model=None)
            raise
        except Exception:
            self._charge(info, None, None, ok=False, model=None)
            raise
        self._charge(info, est.usage, est.searches, ok=True, model=est.model)
        return est

    def _charge(self, info: dict[str, Any], usage: Any, searches: Any, *, ok: bool, model: str | None) -> None:
        cost = research_cost_usd(usage, searches, self.config)
        self.run_cost += cost
        self.day_cost += cost
        self.max_call_cost = max(self.max_call_cost, cost)
        self.audit.write("research_cost", mode="dry_run" if self.dry_run else "live",
                         instrument_symbol=info.get("instrument_symbol"), ok=ok, model=model,
                         usage=usage if _usage_ok(usage) else None, usage_known=_usage_ok(usage), searches=searches,
                         research_cost_usd=format(cost, "f"), run_cost_usd=format(self.run_cost, "f"),
                         day_cost_usd=format(self.day_cost, "f"))

    def _load_day_cost(self) -> None:
        """Today's research dollars from audit.log (every mode: research is real money in DRY_RUN too). A
        research_cost line with an unreadable amount is charged the unknown-usage estimate."""
        today = datetime.fromtimestamp(self.now(), tz=timezone.utc).date().isoformat()
        prefix = '{"ts": "' + today
        unknown = research_cost_usd(None, None, self.config)
        total, biggest = Decimal(0), Decimal(0)
        try:
            f = open(self.audit.path, encoding="utf-8")
        except FileNotFoundError:
            f = None
        if f is not None:
            with f:
                for line in f:
                    if not line.startswith(prefix) or '"research_cost"' not in line:
                        continue
                    try:
                        e = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(e, dict) or e.get("event") != "research_cost":
                        continue
                    try:
                        c = Decimal(str(e.get("research_cost_usd")))
                        if not c.is_finite() or c < 0:
                            raise InvalidOperation
                    except (InvalidOperation, ValueError):
                        c = unknown
                    total += c
                    biggest = max(biggest, c)
        self.day_cost, self.max_call_cost = total, biggest

    def research_block(self) -> str | None:
        """Why no more research may run now, or None. A cost cap stops research when the next call, projected at
        the costliest call seen today, would pass it; the first time that happens it is logged once."""
        if self.research_left <= 0:
            return "research budget exhausted for this run (max_research_per_run)"
        nxt = self.max_call_cost
        why = None
        cap = self.config.max_research_cost_usd_per_run
        if cap is not None and self.run_cost + nxt > cap:
            why = (f"this run spent ~${self.run_cost} and another call (~${nxt}) would pass "
                   f"max_research_cost_usd_per_run {cap}")
        cap = self.config.max_research_cost_usd_per_day
        if why is None and cap is not None and self.day_cost + nxt > cap:
            why = (f"today's research spent ~${self.day_cost} and another call (~${nxt}) would pass "
                   f"max_research_cost_usd_per_day {cap}")
        if why is None:
            return None
        if not self.budget_logged:
            self.budget_logged = True
            self.log("research_budget_reached", reason=f"research cost budget reached: {why}; no more research "
                     "this run", run_cost_usd=format(self.run_cost, "f"), day_cost_usd=format(self.day_cost, "f"))
        return f"research cost budget reached ({why})"

    @staticmethod
    def _find_contract(market: dict[str, Any], symbol: str) -> dict[str, Any] | None:
        return next((c for c in market.get("contracts") or [] if c.get("instrument_symbol") == symbol), None)

    def _record(self, est: Estimate) -> dict[str, Any]:
        e = est.as_log()
        return {"estimate": e["probability_yes"], "thesis": e["thesis"],
                "invalidation_conditions": e["invalidation_conditions"], "key_facts": e["key_facts"],
                "resolution_rules_summary": e["resolution_rules_summary"], "sources": e["sources"],
                "research_model": e["model"],
                "research_model_requested": e["model_requested"] or self.config.research_model,
                "research_models_used": e["models_used"] or ([e["model"]] if e["model"] else []),
                "research_fallback_used": e["fallback_used"],
                "searches": e["searches"], "usage": e["usage"]}

    async def _confirm_and_record(self, kind: str, prop: dict[str, Any], record: dict[str, Any]) -> None:
        preview = prop["preview"]
        sizing = preview.get("sizing") or {}
        fields = {**record, "instrument_symbol": preview["instrument_symbol"], "outcome": preview["outcome"].lower(),
                  "side": preview["side"].lower(), "quantity": preview["quantity"], "limit_price": preview["limit_price"],
                  "worst_case_cost_usd": preview["worst_case_cost_usd"], "event_ticker": preview["resolved_event_ticker"],
                  "kelly_fraction": sizing.get("kelly_fraction"), "stake_usd": sizing.get("stake_usd"),
                  "binding_limit": sizing.get("binding_limit"), "sizing": sizing or None}
        how = self.confirm(preview)
        if not how:
            self.log("proposed_not_confirmed", reason="live proposal not confirmed (no terminal approval)", **fields)
            return
        # Only a terminal "yes" is reported as hand-confirmed; any other approval (incl. a plain True) is "auto".
        fields["confirmed_by"] = how if how in ("hand", "auto", "dry_run") else "auto"
        res = await self.tools.call("confirm_order", token=prop["confirmation_token"],
                                    confirmed_by=fields["confirmed_by"] if not self.dry_run else None)
        if not res.get("ok"):
            self.log(f"{kind}_failed", reason=res.get("reason") or res.get("error"), **fields)
            return
        ref = res.get("paper_order_id") if self.dry_run else f"live:{res.get('order_id')}"
        ts = datetime.fromtimestamp(self.now(), tz=timezone.utc).isoformat(timespec="seconds")
        self.paper.attach_research(str(ref), {"kind": kind, "ts": ts, "order_ref": ref,
                                              "probability_yes": record.get("estimate"), **fields})
        self.log(kind, order_ref=ref, paper_filled=res.get("paper_filled"), **fields)

    # ---- phases

    async def run(self) -> list[dict[str, Any]]:
        self._load_day_cost()
        bal = await self.tools.call("get_balances")
        self.log("run_start", risk=bal.get("risk"), risk_error=bal.get("risk_error"),
                 research_budget=self.research_left, research_cost_today_usd=format(self.day_cost, "f"))
        # Breakers first, before any research or proposal: a breach must trip even if nothing would be proposed.
        chk = await self.tools.call("check_circuit_breakers")
        if not chk.get("ok"):
            self.log("run_stopped", reason=f"circuit breaker check at run start: {chk.get('reason') or chk.get('error')}",
                     tripped=bool(chk.get("tripped")))
            self.log("run_end", research_left=self.research_left, research_cost_usd=format(self.run_cost, "f"))
            return self.decisions
        await self.review_positions()
        await self.scan_entries()
        self.log("run_end", research_left=self.research_left, research_cost_usd=format(self.run_cost, "f"))
        return self.decisions

    async def review_positions(self) -> None:
        resp = await self.tools.call("get_positions")
        positions = resp.get("review_positions")
        if not resp.get("ok") or not isinstance(positions, list):
            self.log("review_failed", reason=resp.get("review_error") or resp.get("error") or "no positions data")
            return
        for pos in positions:
            symbol, outcome, ev = pos.get("symbol"), pos.get("outcome"), pos.get("event_ticker")
            self.held.add(symbol)
            base = {"instrument_symbol": symbol, "outcome": outcome, "event_ticker": ev,
                    "held_quantity": pos.get("quantity"), "available": pos.get("available")}
            available = Decimal(str(pos.get("available") or "0"))
            if available <= 0:
                self.log("hold", reason="nothing available to sell (all on hold)", **base)
                continue
            block = self.research_block()
            if block:
                self.log("hold", reason=f"{block}; position not reviewed this run", **base)
                continue
            market = await self.tools.call("get_market", event_ticker=ev)
            contract = self._find_contract(market, symbol) if market.get("ok") else None
            if contract is None:
                self.log("review_failed", reason=market.get("error") or "contract not found in event", **base)
                continue
            book = await self.tools.call("get_order_book", instrument_symbol=symbol)
            buy_p, sell_p = outcome_prices(book, outcome) if book.get("ok") else (None, None)
            prior = self.prior_for(symbol, outcome)
            try:
                est = await self.do_research(contract_info(market, contract), prior)
            except ResearchError as e:
                self.log("review_failed", reason=f"research failed: {e}; holding", **base)
                continue
            entry_q_adj = Decimal(str(prior["q_adj"])) if prior and prior.get("q_adj") else None
            d = decide_exit(
                outcome=outcome, q_yes_now=est.probability_yes, buy_price=buy_p, sell_price=sell_p,
                entry_q_adj=entry_q_adj, thesis_invalidated=est.thesis_invalidated,
                invalidation_reason=est.invalidation_reason,
                hours_to_expiry=hours_until(contract.get("expiry"), self.now()), config=self.config,
            )
            record = {**self._record(est), **d.details, "thesis_invalidated": est.thesis_invalidated,
                      "invalidation_reason": est.invalidation_reason, "reasons": d.reasons,
                      "prior_thesis": prior.get("thesis") if prior else None}
            if not d.sell:
                self.log("hold", **base, **record)
                continue
            prop = await self.tools.call("propose_order", instrument_symbol=symbol, outcome=outcome, side="sell",
                                         limit_price=format(sell_p, "f"), quantity=format(available, "f"))
            if not prop.get("ok"):
                self.log("exit_rejected", reason=prop.get("reason") or prop.get("error"), **base, **record)
                continue
            await self._confirm_and_record("exit", prop, record)

    async def _resting_symbols(self) -> set[str] | None:
        """Live only: symbols with an open order (any side). None if the open orders can't be read."""
        resp = await self.tools.call("list_open_orders")
        orders = resp.get("orders") if resp.get("ok") else None
        if not isinstance(orders, list):
            return None
        return {o.get("symbol") for o in orders if isinstance(o, dict)}

    def _outside_window(self, hours: Decimal) -> str | None:
        """Why a contract expiring in `hours` is outside the entry window, or None if it's inside."""
        lo, hi_days = self.config.min_hours_to_expiry, self.config.max_days_to_expiry
        if hours < lo:
            return f"outside expiry window: expires in {hours:.1f} h, sooner than min_hours_to_expiry {lo}"
        if hours > hi_days * 24:
            return (f"outside expiry window: expires in {hours / 24:.1f} days, later than "
                    f"max_days_to_expiry {hi_days}")
        return None

    async def scan_entries(self) -> None:
        # A resting order from an earlier run isn't a position yet; without this the runner would stack
        # another entry on the same contract every run (bounded only by the caps).
        resting: set[str] = set()
        if not self.dry_run:
            got = await self._resting_symbols()
            if got is None:
                self.log("no_trade", reason="couldn't read open orders; no entries this run")
                return
            resting = got
        for ticker in self.config.allowed_event_tickers:
            market = await self.tools.call("get_market", event_ticker=ticker)
            if not market.get("ok"):
                self.log("no_trade", event_ticker=ticker, reason=f"get_market failed: {market.get('error')}")
                continue
            for c in market.get("contracts") or []:
                symbol = c.get("instrument_symbol")
                base = {"instrument_symbol": symbol, "event_ticker": ticker, "contract_label": c.get("label")}
                if c.get("status") != "active" or c.get("market_state") != "open":
                    self.log("no_trade", reason=f"contract not tradable (status {c.get('status')}, "
                                                f"market {c.get('market_state')})", **base)
                    continue
                if symbol in resting:
                    self.log("skip", reason="open order already resting on this contract; not stacking another",
                             **base)
                    continue
                if symbol in self.held:
                    self.log("skip", reason="held (or exited) this run; handled by position review, "
                                            "not re-entered", **base)
                    continue
                expiry = c.get("expiry") or market.get("expiry")
                hours = hours_until(expiry, self.now())
                if hours is None:
                    self.log("no_trade", reason=f"no expiry date (got {expiry!r}); the near-expiry exit rule "
                                                "can't apply, so the contract isn't entered", **base)
                    continue
                window = self._outside_window(hours)
                if window:
                    self.log("no_trade", reason=window, hours_to_expiry=format(hours, "f"), **base)
                    continue
                block = self.research_block()
                if block:
                    self.log("no_trade", reason=block, **base)
                    continue
                book = await self.tools.call("get_order_book", instrument_symbol=symbol)
                bc = check_book(book if book.get("ok") else None, "yes", max_spread=self.config.max_spread)
                if not bc.ok:
                    self.log("no_trade", reason=bc.reason or book.get("error"), book=bc.as_log(), **base)
                    continue
                try:
                    est = await self.do_research(contract_info(market, c), None)
                except ResearchError as e:
                    self.log("no_trade", reason=f"research failed: {e}", **base)
                    continue
                record = self._record(est)
                if len(est.sources) < self.config.min_sources:
                    self.log("no_trade", reason=f"only {len(est.sources)} sources (min_sources "
                                                f"{self.config.min_sources})", **base, **record)
                    continue
                choice = choose_entry(est.probability_yes, bc, self.config)
                record.update({"sides": choice.sides, "book": bc.as_log()})
                if choice.outcome is None:
                    self.log("no_trade", reason=choice.reason, **base, **record)
                    continue
                record.update({"q": format(choice.q, "f"), "q_adj": format(choice.q_adj.quantize(Decimal("0.0001")), "f"),
                               "p": format(choice.p, "f"), "edge": format(choice.edge.quantize(Decimal("0.0001")), "f")})
                prop = await self.tools.call("propose_order", instrument_symbol=symbol, outcome=choice.outcome,
                                             side="buy", limit_price=format(choice.p, "f"),
                                             my_probability=format(choice.q, "f"))
                if not prop.get("ok"):
                    self.log("no_trade", reason=f"server rejected: {prop.get('reason') or prop.get('error')}",
                             sizing=prop.get("sizing"), **base, **record)
                    continue
                qty = Decimal(prop["preview"]["quantity"])
                depth = check_book(book, choice.outcome, max_spread=self.config.max_spread, side="buy",
                                   limit_price=choice.p, quantity=qty, min_depth_multiple=self.config.min_depth_multiple)
                if not depth.ok:
                    record["book"] = depth.as_log()
                    self.log("no_trade", reason=depth.reason, sizing=prop["preview"].get("sizing"), **base, **record)
                    continue
                await self._confirm_and_record("entry", prop, record)


# --------------------------------------------------------------------------- MCP wiring


class McpTools:
    """Calls the guarded server's tools over MCP. The runner has no other way to act."""

    def __init__(self, session: Any):
        self.session = session

    async def call(self, name: str, **args: Any) -> dict[str, Any]:
        res = await self.session.call_tool(name, {k: v for k, v in args.items() if v is not None})
        data = res.structuredContent
        if isinstance(data, dict) and set(data) == {"result"}:
            data = data["result"]
        if data is None:
            text = "".join(getattr(c, "text", "") for c in res.content or [])
            data = json.loads(text) if text else {}
        return data if isinstance(data, dict) else {"ok": False, "error": f"unexpected tool output: {data!r}"}


async def run_with_server(make_runner: Callable[[Any], Runner]) -> list[dict[str, Any]]:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    # The server needs Gemini settings only; it never sees the Anthropic key.
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    params = StdioServerParameters(command=sys.executable, args=[str(HERE / "server.py")], env=env)
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as session:
            await session.initialize()
            return await make_runner(McpTools(session)).run()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--auto-confirm", action="store_true",
                    help="live only: confirm without asking (also needs runner_auto_confirm_live: true)")
    args = ap.parse_args(argv)

    from dotenv import load_dotenv

    load_dotenv(HERE / ".env", override=False)
    # The launchd job (launchd/*.plist.template) sets GEMINI_MCP_SCHEDULE=dry_run_only. A scheduled run may never
    # be live, whatever .env or the plist's DRY_RUN says.
    sched = os.environ.get("GEMINI_MCP_SCHEDULE")
    if sched is not None:
        try:
            dry = parse_dry_run(os.environ.get("DRY_RUN"))
        except Exception:  # noqa: BLE001 - a malformed DRY_RUN is not dry
            dry = False
        if sched != "dry_run_only" or not dry:
            print(f"GEMINI_MCP_SCHEDULE={sched!r} with DRY_RUN={os.environ.get('DRY_RUN')!r}: refusing to start. "
                  "Scheduled runs are dry_run_only; live runs need a terminal (see RUNBOOK.md).", file=sys.stderr)
            return 3
    import preflight

    if not preflight.enforce(os.environ):
        return 1
    config = load_config(HERE / "config.yaml")
    dry_run = parse_dry_run(os.environ.get("DRY_RUN"))
    parse_env(os.environ.get("GEMINI_ENV"))
    secrets = [os.environ.get(k) for k in ("GEMINI_API_KEY", "GEMINI_API_SECRET", "ANTHROPIC_API_KEY")]
    audit = AuditLog(HERE / "audit.log", redact=[s for s in secrets if s])
    if os.path.lexists(HERE / "KILL"):
        audit.write("decision", kind="run_skipped", reason="KILL file present")
        print("KILL file present; not running.")
        return 2

    import anthropic

    from research import research_contract

    client = anthropic.Anthropic()

    def research(info: dict[str, Any], prior: dict[str, Any] | None) -> Estimate:
        try:
            return research_contract(
                client, model=config.research_model, contract=info, prior=prior,
                now_iso=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                max_searches=config.research_max_searches,
            )
        except ResearchError:
            raise
        except anthropic.APIError as e:
            raise ResearchError(f"{type(e).__name__}: {getattr(e, 'message', e)}")

    paper = PaperLedger(HERE / "paper_ledger.json", config.paper_bankroll_usd)
    confirm = make_confirm(dry_run, args.auto_confirm, config, interactive=sys.stdin.isatty())
    asyncio.run(run_with_server(lambda tools: Runner(
        tools=tools, research=research, config=config, audit=audit, paper=paper,
        dry_run=dry_run, confirm=confirm)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

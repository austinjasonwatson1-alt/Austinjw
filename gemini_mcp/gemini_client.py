"""Gemini Prediction Markets REST client.

Endpoint paths and payload fields follow Gemini's official docs:
  https://developer.gemini.com/prediction-markets-spec
  https://developer.gemini.com/authentication/api-key

Safety properties of this module:
- Two clients. ``ReadOnlyClient`` can only reach public market data and signed
  *read* endpoints. ``TradingClient`` adds exactly two write endpoints: place a
  limit order and cancel an order. In dry-run mode the server never builds a
  ``TradingClient``, so the order-placement endpoint can't be reached in code.
- Every request must match the explicit method+path allowlist (``ALLOWED_ENDPOINTS``)
  and must not contain deposit/withdraw/transfer/address/fund/bank anywhere in its
  path. This is checked twice: when the request is built, and again by an httpx
  request hook on the final URL (host, scheme, port and normalized path), so code
  that bypasses the helper methods is refused too. Refusals are logged.
- Private paths are also checked against a per-class allowlist before signing.
  There is no withdrawal, transfer, batch, stop-limit or terms-accept call.
- The API secret is kept in a private attribute, left out of ``repr`` and never
  logged. Error messages include the HTTP status and response body, never
  request headers.
- There's one signing implementation and no automatic retries. A failed
  request is reported as-is.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import threading
import time
from decimal import Decimal
from typing import Any, Callable
from urllib.parse import quote, unquote

import httpx

BASE_URLS = {
    "sandbox": "https://api.sandbox.gemini.com",
    "production": "https://api.gemini.com",
}

# Public market-data WebSocket (order book depth). Per Gemini's demo-environment page.
WS_URLS = {
    "sandbox": "wss://ws.sandbox.gemini.com",
    "production": "wss://ws.gemini.com",
}
_WS_SYMBOL_RE = re.compile(r"^[A-Za-z0-9._:-]{1,120}$")

EVENTS_PATH = "/v1/prediction-markets/events"
BALANCES_PATH = "/v1/balances"
POSITIONS_PATH = "/v1/prediction-markets/positions"
ACTIVE_ORDERS_PATH = "/v1/prediction-markets/orders/active"
ORDER_HISTORY_PATH = "/v1/prediction-markets/orders/history"
PLACE_ORDER_PATH = "/v1/prediction-markets/order"
CANCEL_ORDER_PATH = "/v1/prediction-markets/order/cancel"

EVENT_STATUSES = frozenset({"approved", "active", "closed", "under_review", "settled", "invalid"})

_MAX_ERROR_BODY = 2000

log = logging.getLogger("gemini_mcp.client")

# The only requests this code may ever send: (method, full-match path regex). Event tickers are limited to a
# conservative character set that can't contain "/" or "%" or start with ".", so they can't escape the path.
_TICKER_SEGMENT = r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}"
ALLOWED_ENDPOINTS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (m, re.compile(p)) for m, p in (
        ("GET", re.escape(EVENTS_PATH)),
        ("GET", re.escape(EVENTS_PATH) + "/" + _TICKER_SEGMENT),
        ("POST", re.escape(BALANCES_PATH)),
        ("POST", re.escape(POSITIONS_PATH)),
        ("POST", re.escape(ACTIVE_ORDERS_PATH)),
        ("POST", re.escape(ORDER_HISTORY_PATH)),
        ("POST", re.escape(PLACE_ORDER_PATH)),
        ("POST", re.escape(CANCEL_ORDER_PATH)),
    )
)
# Refused anywhere in a path (after percent-decoding), even if a pattern above would match.
FORBIDDEN_PATH_WORDS = re.compile(r"deposit|withdraw|transfer|address|fund|bank", re.IGNORECASE)
_WS_STREAM_RE = re.compile(r"[A-Za-z0-9._:-]{1,120}@depth(5|10|20)")


def endpoint_allowed(method: str, path: str) -> bool:
    """True only for an allowlisted method+path. ``path`` excludes the query string."""
    decoded = unquote(unquote(path))
    if FORBIDDEN_PATH_WORDS.search(decoded) or ".." in decoded.split("/"):
        return False
    return any(method == m and p.fullmatch(path) for m, p in ALLOWED_ENDPOINTS)


def check_endpoint(method: str, path: str) -> None:
    if not endpoint_allowed(method, path):
        log.warning("refused request %s %s: not on the endpoint allowlist", method, path[:200])
        raise PathNotAllowed(f"{method} {path[:200]} is not on the endpoint allowlist")


class GeminiAPIError(Exception):
    """A non-2xx response or unusable body from Gemini."""

    def __init__(self, path: str, status: int | None, body: str):
        self.path = path
        self.status = status
        self.body = body[:_MAX_ERROR_BODY]
        super().__init__(f"Gemini API error on {path}: HTTP {status}: {self.body}")


class CredentialsMissing(Exception):
    pass


class PathNotAllowed(Exception):
    """Raised when code tries to reach an endpoint this client isn't allowed to call."""


# --------------------------------------------------------------------------- signing


def encode_payload(payload: dict[str, Any]) -> bytes:
    """Base64 of the JSON payload, the value sent in X-GEMINI-PAYLOAD."""
    return base64.b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))


def sign(b64_payload: bytes, api_secret: str) -> str:
    """hex(HMAC_SHA384(base64(payload), key=api_secret)), per Gemini's API-key auth docs."""
    return hmac.new(api_secret.encode("utf-8"), b64_payload, hashlib.sha384).hexdigest()


def build_auth_headers(api_key: str, api_secret: str, payload: dict[str, Any]) -> dict[str, str]:
    b64 = encode_payload(payload)
    return {
        "Content-Type": "text/plain",
        "Content-Length": "0",
        "X-GEMINI-APIKEY": api_key,
        "X-GEMINI-PAYLOAD": b64.decode("ascii"),
        "X-GEMINI-SIGNATURE": sign(b64, api_secret),
        "Cache-Control": "no-cache",
    }


class NonceGenerator:
    """Strictly increasing, time-based nonces in whole seconds.

    Gemini's recommended time-based nonces are Unix seconds within +/-30 s of
    server time. To keep them strictly increasing as well, a second request in
    the same second waits for the next second instead of running ahead of the
    clock.
    """

    def __init__(self, clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep):
        self._clock = clock
        self._sleep = sleep
        self._last = 0
        self._lock = threading.Lock()

    def next(self) -> int:
        with self._lock:
            now = int(self._clock())
            if now <= self._last:
                self._sleep(self._last + 1 - self._clock())
                now = max(int(self._clock()), self._last + 1)
            self._last = now
            return now


# --------------------------------------------------------------------------- clients


class ReadOnlyClient:
    """Public market data plus signed read-only endpoints. Can't place or cancel orders."""

    PRIVATE_PATHS: frozenset[str] = frozenset(
        {BALANCES_PATH, POSITIONS_PATH, ACTIVE_ORDERS_PATH, ORDER_HISTORY_PATH}
    )

    def __init__(
        self,
        env: str,
        api_key: str | None = None,
        api_secret: str | None = None,
        account: str | None = None,
        transport: httpx.BaseTransport | None = None,
        nonces: NonceGenerator | None = None,
        timeout: float = 15.0,
        ws_connect: Callable[..., Any] | None = None,
    ):
        if env not in BASE_URLS:
            raise ValueError(f"env must be one of {sorted(BASE_URLS)}")
        self.env = env
        self.base_url = BASE_URLS[env]
        self._api_key = api_key or None
        self.__secret = api_secret or None
        self._account = account or None
        self._nonces = nonces or NonceGenerator()
        self._ws_connect = ws_connect
        self._http = httpx.Client(
            base_url=self.base_url,
            transport=transport,
            timeout=timeout,
            follow_redirects=False,
            event_hooks={"request": [self._guard_request]},
        )

    def _guard_request(self, request: httpx.Request) -> None:
        """Last check on the final request, after URL normalization, before anything is sent."""
        url = request.url
        path = url.raw_path.decode("ascii", "replace").split("?", 1)[0]
        expected = httpx.URL(self.base_url)
        if (url.scheme, url.host, url.port) != (expected.scheme, expected.host, expected.port):
            log.warning("refused request %s %s://%s%s: wrong host", request.method, url.scheme, url.host, path[:200])
            raise PathNotAllowed(f"request to {url.scheme}://{url.host} refused; only {self.base_url} is allowed")
        check_endpoint(request.method, path)

    def __repr__(self) -> str:
        return f"{type(self).__name__}(env={self.env!r}, credentials={'set' if self.has_credentials else 'missing'})"

    @property
    def has_credentials(self) -> bool:
        return bool(self._api_key and self.__secret)

    def secrets(self) -> list[str]:
        """Values the audit log must never contain."""
        return [s for s in (self._api_key, self.__secret) if s]

    # ---- transport

    @staticmethod
    def _parse(path: str, resp: httpx.Response) -> Any:
        if resp.status_code < 200 or resp.status_code >= 300:
            raise GeminiAPIError(path, resp.status_code, resp.text)
        try:
            return resp.json()
        except ValueError:
            raise GeminiAPIError(path, resp.status_code, f"non-JSON response: {resp.text}")

    def _public_get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        check_endpoint("GET", path)
        return self._parse(path, self._http.get(path, params=params))

    def _private_post(self, path: str, params: dict[str, Any] | None = None) -> Any:
        check_endpoint("POST", path)
        if path not in self.PRIVATE_PATHS:
            log.warning("refused request POST %s: not allowed for %s", path[:200], type(self).__name__)
            raise PathNotAllowed(f"{type(self).__name__} may not call {path}")
        if not self.has_credentials:
            raise CredentialsMissing("GEMINI_API_KEY / GEMINI_API_SECRET are not set")
        payload: dict[str, Any] = {"request": path, "nonce": str(self._nonces.next())}
        if self._account:
            payload["account"] = self._account
        payload.update(params or {})
        headers = build_auth_headers(self._api_key, self.__secret, payload)  # type: ignore[arg-type]
        return self._parse(path, self._http.post(path, headers=headers, content=b""))

    # ---- public market data

    def list_events(self, search: str | None = None, status: list[str] | None = None, limit: int = 20) -> Any:
        params: dict[str, Any] = {"limit": limit}
        if search:
            params["search"] = search
        if status:
            params["status"] = status
        return self._public_get(EVENTS_PATH, params)

    def get_event(self, event_ticker: str) -> Any:
        if not isinstance(event_ticker, str) or not re.fullmatch(_TICKER_SEGMENT, event_ticker):
            log.warning("refused request GET %s/<malformed ticker>", EVENTS_PATH)
            raise PathNotAllowed("malformed event ticker; refused")
        return self._public_get(f"{EVENTS_PATH}/{quote(event_ticker, safe='')}")

    def get_order_book(self, symbol: str, depth: int = 20, timeout: float = 8.0) -> dict[str, Any]:
        """One public L2 partial-depth snapshot ({symbol}@depth{N}). Levels are YES-space [price, qty].

        Unauthenticated and read-only: it subscribes, takes the first snapshot,
        and disconnects.
        """
        if not _WS_SYMBOL_RE.match(symbol or ""):
            raise ValueError("malformed instrument symbol")
        if depth not in (5, 10, 20):
            raise ValueError("depth must be 5, 10 or 20")
        connect = self._ws_connect
        if connect is None:
            from websockets.sync.client import connect  # imported lazily; only this call needs it
        stream = f"{symbol}@depth{depth}"
        if not _WS_STREAM_RE.fullmatch(stream):
            raise ValueError("malformed order-book stream")
        deadline = time.monotonic() + timeout
        with connect(WS_URLS[self.env], open_timeout=timeout, close_timeout=2) as ws:
            ws.send(json.dumps({"id": "1", "method": "SUBSCRIBE", "params": [stream]}))
            while (left := deadline - time.monotonic()) > 0:
                try:
                    msg = json.loads(ws.recv(timeout=left))
                except TimeoutError:
                    break
                if not isinstance(msg, dict):
                    continue
                if msg.get("error"):
                    raise GeminiAPIError(f"ws:{stream}", None, json.dumps(msg))
                if isinstance(msg.get("bids"), list) and isinstance(msg.get("asks"), list):
                    return {"symbol": symbol, "bids": msg["bids"], "asks": msg["asks"],
                            "last_update_id": msg.get("lastUpdateId")}
        raise GeminiAPIError(f"ws:{stream}", None, "no depth snapshot received before timeout")

    # ---- signed reads

    def get_balances(self) -> Any:
        return self._private_post(BALANCES_PATH)

    def get_positions(self, **params: Any) -> Any:
        return self._private_post(POSITIONS_PATH, params)

    def list_active_orders(self, limit: int = 100, offset: int = 0) -> Any:
        return self._private_post(ACTIVE_ORDERS_PATH, {"limit": limit, "offset": offset})

    def list_order_history(self, limit: int = 1000, offset: int = 0) -> Any:
        return self._private_post(ORDER_HISTORY_PATH, {"limit": limit, "offset": offset})


class TradingClient(ReadOnlyClient):
    """Adds limit-order placement and cancel. Only built when DRY_RUN=false."""

    PRIVATE_PATHS = ReadOnlyClient.PRIVATE_PATHS | {PLACE_ORDER_PATH, CANCEL_ORDER_PATH}

    def place_limit_order(
        self, symbol: str, side: str, outcome: str, quantity: Decimal, price: Decimal
    ) -> Any:
        # Order type and time-in-force are fixed here on purpose: limit / good-til-cancel only.
        return self._private_post(
            PLACE_ORDER_PATH,
            {
                "symbol": symbol,
                "orderType": "limit",
                "side": side,
                "quantity": format(quantity, "f"),
                "price": format(price, "f"),
                "outcome": outcome,
                "timeInForce": "good-til-cancel",
            },
        )

    def cancel_order(self, order_id: int) -> Any:
        return self._private_post(CANCEL_ORDER_PATH, {"orderId": order_id})

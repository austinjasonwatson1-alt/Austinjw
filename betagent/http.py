"""Shared HTTP session with retries and timeouts."""
from __future__ import annotations

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

DEFAULT_TIMEOUT = 20


class SourceError(RuntimeError):
    """A data source failed after retries."""


def make_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(total=3, backoff_factor=1.0, status_forcelist=(429, 500, 502, 503, 504), allowed_methods=("GET",))
    s.mount("https://", HTTPAdapter(max_retries=retry))
    # Keep the default python-requests User-Agent: ESPN's CDN rejects unknown and spoofed-browser agents.
    s.headers["Accept"] = "application/json"
    return s


def get_json(session: requests.Session, url: str, params=None, timeout: int = DEFAULT_TIMEOUT):
    try:
        resp = session.get(url, params=params, timeout=timeout)
    except requests.RequestException as exc:
        raise SourceError(f"GET {url} failed: {exc}") from exc
    if resp.status_code != 200:
        raise SourceError(f"GET {url} -> HTTP {resp.status_code}")
    try:
        return resp.json(), resp.headers
    except ValueError as exc:
        raise SourceError(f"GET {url} returned non-JSON") from exc

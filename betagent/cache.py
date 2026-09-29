"""Tiny on-disk JSON cache so same-day reruns don't burn API credits."""
from __future__ import annotations

import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)


class Cache:
    """Entries live at <root>/<day>/<namespace>/<key>.json.

    mode: "normal"  - use cached value if fresh, else fetch
          "refresh" - always fetch (and overwrite)
          "offline" - never fetch; return cached value regardless of age, else None
    """

    def __init__(self, root: Path, day: str, mode: str = "normal"):
        self.root = Path(root)
        self.day = day
        self.mode = mode

    def path(self, namespace: str, key: str) -> Path:
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in key)
        if len(safe) > 80:
            safe = safe[:60] + "_" + hashlib.sha1(key.encode()).hexdigest()[:12]
        return self.root / self.day / namespace / f"{safe}.json"

    def get(self, namespace: str, key: str, ttl_minutes: Optional[float] = None) -> Optional[Any]:
        p = self.path(namespace, key)
        if not p.exists():
            return None
        try:
            blob = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            return None
        if self.mode != "offline" and ttl_minutes is not None:
            if time.time() - blob.get("fetched_at", 0) > ttl_minutes * 60:
                return None
        return blob.get("data")

    def put(self, namespace: str, key: str, data: Any) -> None:
        p = self.path(namespace, key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps({"fetched_at": time.time(), "data": data}))
        tmp.replace(p)

    def fetch(self, namespace: str, key: str, fn: Callable[[], Any], ttl_minutes: Optional[float] = None) -> Optional[Any]:
        """Return cached data or call fn(); fn failures fall back to any stale cached copy."""
        if self.mode != "refresh":
            hit = self.get(namespace, key, ttl_minutes)
            if hit is not None:
                return hit
        if self.mode == "offline":
            return None
        try:
            data = fn()
        except Exception as exc:  # noqa: BLE001 - any source failure should degrade, not crash
            stale = self.get(namespace, key, ttl_minutes=None)
            log.warning("%s/%s fetch failed (%s)%s", namespace, key, exc, "; using stale cache" if stale else "")
            if stale is not None:
                return stale
            raise
        if data is not None:
            self.put(namespace, key, data)
        return data

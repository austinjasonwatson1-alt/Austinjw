"""Task 4: capture_samples.py makes exactly two read-only calls (positions, open orders), refuses if anything
looks like a secret, redacts sensitive values while keeping every field name, nesting and value type, never
prints credentials, and reports which documented fields were present, absent or empty."""

import json
import re
import stat
import subprocess
from pathlib import Path

import httpx
import pytest

import capture_samples as cs
import gemini_client as gc
from conftest import Clock
from fake_gemini import TEST_KEY, TEST_SECRET, FakeGemini, guard_for

ROOT = Path(__file__).resolve().parents[1]
ENV = {"GEMINI_API_KEY": TEST_KEY, "GEMINI_API_SECRET": TEST_SECRET, "GEMINI_ENV": "sandbox"}


def with_position_and_order(tmp_path):
    """A fake account holding a partly filled position plus a resting buy and a resting sell."""
    fake = FakeGemini()
    fake.set_fill_mode("GEMI-FEDJAN26-DN25", "partial:3")
    (tmp_path / "srv").mkdir(exist_ok=True)
    _, g = guard_for(tmp_path / "srv", fake, live=True, clock=Clock())
    assert g.confirm(g.propose("GEMI-FEDJAN26-DN25", "yes", "buy", "5", "0.62")["confirmation_token"])["ok"]
    fake.set_fill_mode("GEMI-FEDJAN26-DN25", "rest")  # the sell rests
    assert g.confirm(g.propose("GEMI-FEDJAN26-DN25", "yes", "sell", "1", "0.70")["confirmation_token"])["ok"]
    with fake.state() as st:
        st["requests"] = []
    return fake


def install(monkeypatch, fake, mutate=None):
    """Point capture_samples at the fake, optionally rewriting response bodies."""
    def handler(request):
        resp = fake.handle(request)
        if mutate is None:
            return resp
        body = resp.json()
        mutate(request.url.path, body)
        return httpx.Response(resp.status_code, json=body, request=request)

    def make_client(environ):
        return gc.ReadOnlyClient("sandbox", environ.get("GEMINI_API_KEY"), environ.get("GEMINI_API_SECRET"),
                                 transport=httpx.MockTransport(handler))

    monkeypatch.setattr(cs, "make_client", make_client)


def run(tmp_path, capsys, environ=ENV):
    out = tmp_path / "out" / "real"
    code = cs.main(["--out", str(out), "--no-git-check"], environ=dict(environ))
    printed = capsys.readouterr()
    return code, out, printed.out + printed.err


def shape(v):
    if isinstance(v, dict):
        return {k: shape(x) for k, x in v.items()}
    if isinstance(v, list):
        return [shape(x) for x in v]
    return type(v).__name__


def add_personal_fields(path, body):
    entries = body.get("positions") or body.get("orders") or []
    for e in entries:
        e["accountName"] = "Jane Q. Trader"
        e["email"] = "jane@example.com"
        e["subaccount"] = "primary"
        e["owner"] = {"address": "1 Main St, Springfield", "zip": 12345, "verified": True, "score": 1.5}
        e["notes"] = "contact jane@example.com"
        e["contractMetadata"]["accountId"] = 778899


def test_writes_two_redacted_files_after_exactly_two_requests(tmp_path, monkeypatch, capsys):
    fake = with_position_and_order(tmp_path)
    raw = {}

    def mutate(path, body):
        add_personal_fields(path, body)
        raw[path] = json.loads(json.dumps(body))

    install(monkeypatch, fake, mutate)
    code, out, text = run(tmp_path, capsys)
    assert code == 0, text
    reqs = [(m, p.split("?")[0]) for m, p, _ in fake.requests]
    assert reqs == [("POST", "/v1/prediction-markets/positions"), ("POST", "/v1/prediction-markets/orders/active")]
    pos = json.loads((out / "positions.json").read_text())
    orders = json.loads((out / "active_orders.json").read_text())
    assert shape(pos) == shape(raw["/v1/prediction-markets/positions"])  # names, nesting and types kept
    assert shape(orders) == shape(raw["/v1/prediction-markets/orders/active"])
    p0 = pos["positions"][0]
    assert p0["accountName"] == "REDACTED" and p0["email"] == "REDACTED" and p0["subaccount"] == "REDACTED"
    assert p0["owner"] == {"address": "REDACTED", "zip": 0, "verified": False, "score": 0.0}
    assert p0["notes"] == "contact REDACTED"  # email inside free text
    assert p0["contractMetadata"]["accountId"] == 0
    assert p0["symbol"] == "GEMI-FEDJAN26-DN25" and p0["totalQuantity"] == "3"  # market data kept
    assert {o["side"] for o in orders["orders"]} == {"buy", "sell"}
    files = list(out.iterdir())
    assert sorted(f.name for f in files) == ["active_orders.json", "positions.json"]
    assert all(stat.S_IMODE(f.stat().st_mode) == 0o600 for f in files)
    for f in files:
        assert "jane" not in f.read_text().lower() and "Main St" not in f.read_text()


@pytest.mark.parametrize("leak", [TEST_SECRET, TEST_KEY, "account-ZZZZ9999XXXX", "master-AAAA1111BBBB",
                                  "sk-ant-api03-abcdefghijklmnop", "-----BEGIN RSA PRIVATE KEY-----",
                                  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
                                  "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5d2FsZG8"])
def test_refuses_when_anything_looks_like_a_secret(tmp_path, monkeypatch, capsys, leak):
    fake = with_position_and_order(tmp_path)

    def mutate(path, body):
        if "orders" in body:
            body["orders"][0]["contractMetadata"]["description"] = f"see {leak}"

    install(monkeypatch, fake, mutate)
    code, out, text = run(tmp_path, capsys)
    assert code == 2
    assert not out.exists() or list(out.iterdir()) == []
    assert leak not in text and TEST_SECRET not in text
    assert "orders[0].contractMetadata.description" in text and "nothing was written" in text.lower()


def test_never_prints_credentials(tmp_path, monkeypatch, capsys):
    fake = with_position_and_order(tmp_path)
    install(monkeypatch, fake)
    code, out, text = run(tmp_path, capsys)
    assert code == 0
    assert TEST_KEY not in text and TEST_SECRET not in text and "TESTKEY" not in text
    for f in out.iterdir():
        assert TEST_KEY not in f.read_text() and TEST_SECRET not in f.read_text()


def test_api_error_is_reported_without_the_body(tmp_path, monkeypatch, capsys):
    fake = FakeGemini()
    fake.fail_next("/v1/prediction-markets/positions", "status:400")
    install(monkeypatch, fake)
    code, out, text = run(tmp_path, capsys)
    assert code == 1 and "HTTP 400" in text and "Injected" not in text
    assert not out.exists() or list(out.iterdir()) == []


def table(text):
    rows = {}
    for line in text.splitlines():
        m = re.match(r"\s*((?:positions|orders)\S*)\s+(\S.*?)\s*$", line)
        if m:
            rows[m.group(1)] = m.group(2)
    return rows


def test_table_reports_present_absent_and_empty(tmp_path, monkeypatch, capsys):
    fake = with_position_and_order(tmp_path)

    def mutate(path, body):
        for p in body.get("positions") or []:
            p.pop("quantityOnHold", None)
            p["contractMetadata"]["category"] = ""

    install(monkeypatch, fake, mutate)
    code, out, text = run(tmp_path, capsys)
    assert code == 0
    rows = table(text)
    assert rows["positions[].symbol"].startswith("present")
    assert rows["positions[].quantityOnHold"].startswith("ABSENT")
    assert rows["positions[].contractMetadata.category"].startswith("EMPTY")
    assert rows["orders[].side"].startswith("present")
    for field in cs.FIELDS["positions"] + cs.FIELDS["orders"]:
        assert field in rows, field
    assert "an empty list proves nothing about field names" in text.lower()


def test_empty_lists_are_flagged_as_proving_nothing(tmp_path, monkeypatch, capsys):
    install(monkeypatch, FakeGemini())  # no positions, no open orders
    code, out, text = run(tmp_path, capsys)
    assert code == 0
    rows = table(text)
    assert rows["positions"].startswith("empty list")
    assert rows["positions[].symbol"].startswith("unknown")
    assert "proves nothing" in text


def test_refuses_without_credentials(tmp_path, monkeypatch, capsys):
    install(monkeypatch, FakeGemini())
    code, out, text = run(tmp_path, capsys, environ={"GEMINI_ENV": "sandbox"})
    assert code == 1 and "GEMINI_API_KEY" in text and not out.exists()


def test_refuses_an_output_dir_that_git_would_track(tmp_path, monkeypatch, capsys):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    install(monkeypatch, with_position_and_order(tmp_path))
    out = tmp_path / "real"
    code = cs.main(["--out", str(out)], environ=dict(ENV))
    text = capsys.readouterr().out
    assert code == 2 and "gitignore" in text and not out.exists()


def test_samples_real_is_gitignored():
    r = subprocess.run(["git", "-C", str(ROOT), "check-ignore", "-q", "--no-index", "samples/real/positions.json"])
    assert r.returncode == 0


def test_field_list_matches_the_doc():
    doc = (ROOT / "docs" / "real_response_check.md").read_text()
    documented = set(re.findall(r"`((?:positions|orders)(?:\[\])?(?:\.[A-Za-z]+)*)`", doc))
    documented |= {f"{t}[].contractMetadata.{f}" for t in ("positions", "orders") for f in ("eventTicker", "category")}
    listed = set(cs.FIELDS["positions"] + cs.FIELDS["orders"])
    assert listed == documented


def test_only_read_only_client_and_two_calls_in_source():
    src = (ROOT / "capture_samples.py").read_text()
    assert "TradingClient" not in src and "place_limit_order" not in src and "cancel_order" not in src
    assert src.count("client.get_positions(") == 1 and src.count("client.list_active_orders(") == 1

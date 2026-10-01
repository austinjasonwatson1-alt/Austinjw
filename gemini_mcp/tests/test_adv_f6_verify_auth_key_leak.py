"""F6: verify_auth printed key.split('-', 1)[0], which is the whole key when it has no '-'."""

import verify_auth


def test_verify_auth_never_prints_a_key_without_a_prefix(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(verify_auth, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setattr(verify_auth, "HERE", tmp_path)
    monkeypatch.setenv("GEMINI_API_KEY", "ABCDEFSECRETKEY123")
    monkeypatch.setenv("GEMINI_API_SECRET", "s3cr3tvalue")
    monkeypatch.delenv("GEMINI_ENV", raising=False)

    def fail(self):
        raise RuntimeError("HTTP 400 InvalidSignature")

    monkeypatch.setattr(verify_auth.ReadOnlyClient, "get_balances", fail)
    assert verify_auth.main() == 1
    out = capsys.readouterr().out
    assert "ABCDEFSECRETKEY123" not in out and "s3cr3tvalue" not in out

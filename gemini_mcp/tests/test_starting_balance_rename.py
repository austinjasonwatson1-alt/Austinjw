"""initial_deposit_usd is renamed to starting_balance_usd. The old key still loads, with a DeprecationWarning;
giving both is an error rather than a guess."""

from contextlib import nullcontext as _nullcontext
from pathlib import Path

import pytest

from conftest import SYMBOL, write_config
from guardrails import Config, ConfigError, load_config


def test_new_name_loads(tmp_path):
    p = tmp_path / "c.yaml"
    write_config(p, starting_balance_usd=250)
    assert str(load_config(p).starting_balance_usd) == "250"


def test_old_name_still_loads_with_deprecation_warning(tmp_path):
    p = tmp_path / "c.yaml"
    write_config(p, initial_deposit_usd=250)
    with pytest.warns(DeprecationWarning, match="starting_balance_usd"):
        assert str(load_config(p).starting_balance_usd) == "250"


def test_both_names_is_an_error(tmp_path):
    p = tmp_path / "c.yaml"
    write_config(p, initial_deposit_usd=250, starting_balance_usd=250)
    with pytest.raises(ConfigError, match="both"):
        load_config(p)


@pytest.mark.parametrize("key", ["starting_balance_usd", "initial_deposit_usd"])
@pytest.mark.parametrize("bad", [0, -5, "x"])
def test_bad_values_rejected_under_either_name(tmp_path, key, bad):
    p = tmp_path / "c.yaml"
    write_config(p, **{key: bad})
    with pytest.raises(ConfigError), pytest.warns(DeprecationWarning) if key == "initial_deposit_usd" \
            else _nullcontext():
        load_config(p)


def test_config_has_only_the_new_field():
    assert hasattr(Config(), "starting_balance_usd") and not hasattr(Config(), "initial_deposit_usd")


def test_floor_basis_source_uses_new_name(env):
    write_config(env.config_path, starting_balance_usd=1000)
    g = env.guard()
    g.propose(SYMBOL, "yes", "buy", "1", "0.40")
    assert g.risk_summary()["equity_floor_basis"] == {"usd": "1000", "source": "starting_balance_usd"}


def test_shipped_files_use_the_new_name():
    root = Path(__file__).resolve().parents[1]
    for name in ("config.yaml", "README.md", "preflight.py"):
        text = (root / name).read_text()
        assert "starting_balance_usd" in text, name
        assert "initial_deposit_usd" not in text.replace("(formerly initial_deposit_usd)", ""), name

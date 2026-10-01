"""F12: only one page (100) of open orders is read, so max_open_orders above 100 could never be enforced."""

import pytest

from conftest import write_config
from guardrails import ConfigError, load_config


def test_max_open_orders_above_page_size_is_rejected(tmp_path):
    p = tmp_path / "c.yaml"
    write_config(p, max_open_orders=150)
    with pytest.raises(ConfigError):
        load_config(p)
    write_config(p, max_open_orders=100)
    assert load_config(p).max_open_orders == 100

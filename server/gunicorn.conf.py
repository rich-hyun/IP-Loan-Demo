"""Gunicorn settings; load public chain settings before importing Flask.

The existing systemd unit does not load .env. HUP reload reads this file.
Keep the existing service DB path and all other environment values unchanged.
"""
from pathlib import Path
import shlex

threads = 4
timeout = 120
graceful_timeout = 120

_public_keys = {
    "IPLOAN_RPC_URL", "IPLOAN_CHAIN_ID", "IPLOAN_MANAGER_ADDRESS", "IPLOAN_ZERO_GAS_PRICE",
    "IPLOAN_ASSIGNMENT_EVALUATOR", "IPLOAN_ASSIGNMENT_BANK",
}
raw_env = []
_env_file = Path(__file__).resolve().parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text(encoding="utf-8").splitlines():
        _key, _sep, _value = _line.partition("=")
        _key = _key.strip()
        if _sep and _key in _public_keys:
            _parts = shlex.split(_value, comments=True)
            raw_env.append(_key + "=" + (_parts[0] if _parts else ""))

"""Read/write the `enabledPlugins` map in ~/.claude/settings.json.

Claude Code tracks per-plugin enablement under a top-level `enabledPlugins`
key, with composite keys `"<plugin>@<marketplace>"` mapping to bool. The
settings file also holds many unrelated keys (hooks, theme, etc.), so we
always do a partial update preserving everything else.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from . import config


def _settings_path() -> Path:
    return config.claude_home() / "settings.json"


def _read() -> dict:
    p = _settings_path()
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _atomic_write(data: dict) -> None:
    p = _settings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def _key(plugin_name: str, marketplace_name: str) -> str:
    return f"{plugin_name}@{marketplace_name}"


def load_enabled_plugins() -> dict[str, bool]:
    """Return the `enabledPlugins` map. Coerces non-bool values to bool."""
    data = _read()
    raw = data.get("enabledPlugins") if isinstance(data, dict) else None
    if not isinstance(raw, dict):
        return {}
    return {k: bool(v) for k, v in raw.items() if isinstance(k, str)}


def get_enabled(plugin_name: str, marketplace_name: str) -> Optional[bool]:
    """None = no entry; True/False = explicit value."""
    m = load_enabled_plugins()
    return m.get(_key(plugin_name, marketplace_name))


def set_enabled(plugin_name: str, marketplace_name: str, value: bool) -> None:
    data = _read()
    enabled = data.get("enabledPlugins")
    if not isinstance(enabled, dict):
        enabled = {}
    enabled[_key(plugin_name, marketplace_name)] = bool(value)
    data["enabledPlugins"] = enabled
    _atomic_write(data)


def remove_entry(plugin_name: str, marketplace_name: str) -> None:
    """Delete the entry entirely (used on uninstall)."""
    data = _read()
    enabled = data.get("enabledPlugins")
    if not isinstance(enabled, dict):
        return
    enabled.pop(_key(plugin_name, marketplace_name), None)
    data["enabledPlugins"] = enabled
    _atomic_write(data)

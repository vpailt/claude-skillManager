"""Track PRs opened by the admin panel that haven't yet been merged.

Persisted as `%APPDATA%\\SkillManager\\pending_prs.json`. Each entry is keyed
by `(marketplace_name, plugin_name, action)` and survives across runs so the
plugins tab can show a "Pending PR" status for plugins whose change isn't yet
visible in the marketplace registry.

Entries are removed by the user (manual "Clear pending") or automatically when
a refresh confirms the change has been merged.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from . import config


PENDING_FILE_NAME = "pending_prs.json"


@dataclass
class PendingPR:
    marketplace_name: str
    plugin_name: str
    action: str              # "add" | "bump" | "remove"
    pr_url: str
    pr_number: int
    branch: str
    target_repo: str         # repo where the PR was opened
    new_version: str = ""    # filled for "add" and "bump"
    plugin_source_repo: str = ""  # plugin's own repo (filled for "add")
    created_at: str = ""


def _file() -> Path:
    return config.app_settings_dir() / PENDING_FILE_NAME


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def load_all() -> list[PendingPR]:
    f = _file()
    if not f.exists():
        return []
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out: list[PendingPR] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        try:
            out.append(PendingPR(
                marketplace_name=entry.get("marketplace_name", ""),
                plugin_name=entry.get("plugin_name", ""),
                action=entry.get("action", ""),
                pr_url=entry.get("pr_url", ""),
                pr_number=int(entry.get("pr_number", 0) or 0),
                branch=entry.get("branch", ""),
                target_repo=entry.get("target_repo", ""),
                new_version=entry.get("new_version", "") or "",
                plugin_source_repo=entry.get("plugin_source_repo", "") or "",
                created_at=entry.get("created_at", "") or "",
            ))
        except (TypeError, ValueError):
            continue
    return out


def save_all(items: list[PendingPR]) -> None:
    f = _file()
    f.parent.mkdir(parents=True, exist_ok=True)
    payload = [asdict(it) for it in items]
    tmp = f.with_suffix(f.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(f)


def for_marketplace(name: str) -> list[PendingPR]:
    return [p for p in load_all() if p.marketplace_name == name]


def find(marketplace_name: str, plugin_name: str) -> Optional[PendingPR]:
    for p in load_all():
        if p.marketplace_name == marketplace_name and p.plugin_name == plugin_name:
            return p
    return None


def upsert(item: PendingPR) -> None:
    """Insert a new pending PR, replacing any existing entry for the same
    (marketplace, plugin, action) triple."""
    if not item.created_at:
        item.created_at = _now_iso()
    items = load_all()
    items = [p for p in items
             if not (p.marketplace_name == item.marketplace_name
                     and p.plugin_name == item.plugin_name
                     and p.action == item.action)]
    items.append(item)
    save_all(items)


def remove(marketplace_name: str, plugin_name: str, action: str = "") -> None:
    items = load_all()
    kept = []
    for p in items:
        if p.marketplace_name == marketplace_name and p.plugin_name == plugin_name:
            if not action or p.action == action:
                continue
        kept.append(p)
    if len(kept) != len(items):
        save_all(kept)

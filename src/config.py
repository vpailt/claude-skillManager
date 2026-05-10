"""Paths and persisted user settings.

Settings live in %APPDATA%\\SkillManager\\settings.json so the .exe stays portable
and writes user state outside the install directory.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any


def claude_home() -> Path:
    return Path(os.path.expandvars("%USERPROFILE%")) / ".claude"


def claude_plugins_dir() -> Path:
    return claude_home() / "plugins"


def claude_user_skills_dir() -> Path:
    return claude_home() / "skills"


def installed_plugins_file() -> Path:
    return claude_plugins_dir() / "installed_plugins.json"


def known_marketplaces_file() -> Path:
    return claude_plugins_dir() / "known_marketplaces.json"


def plugins_cache_dir() -> Path:
    return claude_plugins_dir() / "cache"


def app_settings_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    p = Path(base) / "SkillManager"
    p.mkdir(parents=True, exist_ok=True)
    return p


def settings_file() -> Path:
    return app_settings_dir() / "settings.json"


@dataclass
class MarketplaceConfig:
    """User-configured marketplace.

    `github_repo` is the canonical source — used for browsing the marketplace
    registry and for admin uploads. `source_path` is an optional local checkout
    we still support for users who haven't moved off directory marketplaces yet.
    """
    name: str
    github_repo: str = ""        # "owner/repo" — empty if not browseable remotely
    default_branch: str = "main"
    owned: bool = False          # True = admin upload allowed for this marketplace
    source_path: str = ""        # optional local clone path
    auto_update: bool = False    # re-pull on every refresh when remote SHA differs


@dataclass
class Settings:
    github_token: str = ""
    marketplaces: list[MarketplaceConfig] = field(default_factory=list)

    def get_marketplace(self, name: str) -> MarketplaceConfig | None:
        for m in self.marketplaces:
            if m.name == name:
                return m
        return None


def load_settings() -> Settings:
    f = settings_file()
    if not f.exists():
        return Settings()
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return Settings()
    mps = [MarketplaceConfig(**m) for m in data.get("marketplaces", [])]
    return Settings(github_token=data.get("github_token", ""), marketplaces=mps)


def save_settings(s: Settings) -> None:
    payload: dict[str, Any] = {
        "github_token": s.github_token,
        "marketplaces": [asdict(m) for m in s.marketplaces],
    }
    settings_file().write_text(json.dumps(payload, indent=2), encoding="utf-8")

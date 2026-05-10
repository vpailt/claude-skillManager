"""Domain types: marketplaces, plugins, skills, and install status."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional


class InstallState(str, Enum):
    NOT_INSTALLED = "not_installed"
    INSTALLED = "installed"
    OUTDATED = "outdated"
    LOCAL_ONLY = "local_only"   # installed but not present on remote marketplace
    UNKNOWN = "unknown"


@dataclass
class Skill:
    name: str
    description: str = ""
    folder: Optional[Path] = None       # local folder if installed
    skill_md_path: Optional[Path] = None
    relative_path: str = ""             # path inside the plugin (e.g. "skills/foo")
    plugin_name: Optional[str] = None
    marketplace_name: Optional[str] = None
    # remote info (when listed by marketplace)
    remote_present: bool = False


@dataclass
class PluginSource:
    """Where a plugin lives — read from a marketplace.json entry."""
    kind: str = ""           # "url" | "github" | "directory" | ""
    repo: str = ""           # "owner/repo" when resolvable
    url: str = ""            # original source string (https://…/foo.git etc.)
    ref: str = ""            # tag, branch, or commit
    path: str = ""           # for directory sources


@dataclass
class Plugin:
    name: str
    marketplace_name: str
    installed_version: Optional[str] = None
    latest_version: Optional[str] = None
    install_path: Optional[Path] = None
    git_commit_sha: Optional[str] = None
    description: str = ""
    skills: list[Skill] = field(default_factory=list)
    remote_present: bool = False
    install_state: InstallState = InstallState.UNKNOWN
    manifest: Optional[dict] = None     # cached manifest.json content
    source: Optional[PluginSource] = None  # how to fetch this plugin
    # Mirrors `enabledPlugins["<plugin>@<marketplace>"]` in ~/.claude/settings.json.
    # None = no entry (treated as disabled by Claude Code).
    enabled: Optional[bool] = None
    last_updated: str = ""              # ISO timestamp from installed_plugins.json


@dataclass
class Marketplace:
    name: str
    source_kind: str                    # "github" | "directory" | "unknown"
    source_repo: str = ""               # "owner/repo" for github sources
    source_path: str = ""               # local path for directory sources
    install_location: str = ""
    plugins: list[Plugin] = field(default_factory=list)
    owned: bool = False                 # legacy: user-toggled flag (no longer surfaced in UI)
    editable: bool = False              # auto-detected from GitHub permissions
    remote_browseable: bool = False     # has a github_repo configured
    installed: bool = False             # registered in known_marketplaces.json
    last_updated: str = ""              # ISO timestamp from known_marketplaces.json


@dataclass
class UserSkill:
    """A standalone skill in ~/.claude/skills/ (not tied to a plugin)."""
    name: str
    folder: Path
    description: str = ""


@dataclass
class SkillFile:
    """A file or subfolder living under a skill's local folder.

    Surfaced in the tree so users can browse a skill's resources beyond SKILL.md.
    """
    path: Path
    is_dir: bool
    skill_name: str
    plugin_name: Optional[str] = None
    marketplace_name: Optional[str] = None

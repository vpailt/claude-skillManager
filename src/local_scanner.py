"""Scans the local Claude install for marketplaces, plugins and skills."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from . import config, plugin_state
from .frontmatter import parse_frontmatter
from .models import Marketplace, Plugin, Skill, UserSkill, InstallState
from .registry import parse_marketplace_json


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_known_marketplaces() -> dict[str, dict]:
    return _read_json(config.known_marketplaces_file())


def load_installed_plugins() -> dict[str, list[dict]]:
    """Return { 'plugin@marketplace': [install_record, ...] }."""
    data = _read_json(config.installed_plugins_file())
    return data.get("plugins", {}) if isinstance(data, dict) else {}


def _scan_skills_in_folder(plugin_folder: Path, plugin_name: str, marketplace_name: str) -> list[Skill]:
    skills: list[Skill] = []
    skills_root = plugin_folder / "skills"
    if not skills_root.is_dir():
        return skills
    for entry in sorted(skills_root.iterdir()):
        if not entry.is_dir():
            continue
        skill = _scan_skill_folder(entry, plugin_folder, plugin_name, marketplace_name)
        if skill:
            skills.append(skill)
        else:
            for sub in sorted(entry.iterdir()):
                if sub.is_dir():
                    nested = _scan_skill_folder(sub, plugin_folder, plugin_name, marketplace_name)
                    if nested:
                        skills.append(nested)
    return skills


def _scan_skill_folder(folder: Path, plugin_folder: Path, plugin_name: str, marketplace_name: str) -> Optional[Skill]:
    skill_md = folder / "SKILL.md"
    if not skill_md.exists():
        skill_md = folder / "skill.md"
        if not skill_md.exists():
            return None
    try:
        text = skill_md.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    fm, _ = parse_frontmatter(text)
    rel = folder.relative_to(plugin_folder).as_posix()
    return Skill(
        name=fm.get("name", folder.name),
        description=fm.get("description", ""),
        folder=folder,
        skill_md_path=skill_md,
        relative_path=rel,
        plugin_name=plugin_name,
        marketplace_name=marketplace_name,
        remote_present=False,
    )


def scan_local_plugin(install_path: Path, plugin_name: str, marketplace_name: str,
                      installed_version: str = "", git_sha: str = "",
                      last_updated: str = "") -> Plugin:
    manifest_path = install_path / "manifest.json"
    manifest = _read_json(manifest_path) if manifest_path.exists() else {}
    description = ""
    if isinstance(manifest, dict):
        description = manifest.get("description", "") or ""
    skills = _scan_skills_in_folder(install_path, plugin_name, marketplace_name)
    return Plugin(
        name=plugin_name,
        marketplace_name=marketplace_name,
        installed_version=installed_version or (manifest.get("version") if isinstance(manifest, dict) else None),
        install_path=install_path,
        git_commit_sha=git_sha or None,
        description=description,
        skills=skills,
        manifest=manifest if isinstance(manifest, dict) else None,
        install_state=InstallState.INSTALLED,
        last_updated=last_updated,
    )


def scan_directory_marketplace(source_path: Path, marketplace_name: str) -> list[Plugin]:
    """Read `.claude-plugin/marketplace.json` from a directory marketplace.

    Returns plugin entries with their PluginSource set, so the installer knows
    where to fetch each plugin from. Skills are NOT scanned here (the plugin
    isn't extracted yet).
    """
    if not source_path.is_dir():
        return []
    registry = source_path / ".claude-plugin" / "marketplace.json"
    if not registry.exists():
        return []
    try:
        text = registry.read_text(encoding="utf-8")
    except Exception:
        return []
    return parse_marketplace_json(text, marketplace_name=marketplace_name)


def _merge_directory_plugins(installed: list[Plugin], available: list[Plugin]) -> list[Plugin]:
    """Combine installed records with registry-discovered plugins.

    For matching names, copy `latest_version`, `description`, and `source` from
    the registry entry onto the installed Plugin and recompute install_state.
    Add not-installed entries from the registry for plugins we don't have locally.
    """
    by_name = {p.name: p for p in installed}
    for av in available:
        if av.name in by_name:
            local = by_name[av.name]
            local.latest_version = av.latest_version
            if not local.description:
                local.description = av.description
            local.source = av.source
            local.install_state = (
                InstallState.INSTALLED
                if (local.installed_version or "") == (av.latest_version or "")
                else InstallState.OUTDATED
            )
        else:
            installed.append(av)
    return installed


def installed_plugins_by_marketplace() -> dict[str, list[Plugin]]:
    """Build Plugin objects from installed_plugins.json, grouped by marketplace name."""
    installed = load_installed_plugins()
    enabled_map = plugin_state.load_enabled_plugins()
    out: dict[str, list[Plugin]] = {}
    for key, records in installed.items():
        if "@" not in key:
            continue
        plugin_name, marketplace_name = key.split("@", 1)
        record = records[0] if records else {}
        install_path = Path(record.get("installPath", ""))
        plugin = scan_local_plugin(
            install_path,
            plugin_name=plugin_name,
            marketplace_name=marketplace_name,
            installed_version=record.get("version", ""),
            git_sha=record.get("gitCommitSha", ""),
            last_updated=record.get("lastUpdated", "") or record.get("installedAt", ""),
        )
        plugin.enabled = enabled_map.get(key)
        out.setdefault(marketplace_name, []).append(plugin)
    return out


def build_marketplaces_from_settings(settings_marketplaces) -> list[Marketplace]:
    """Build the marketplace list the user configured in app settings.

    Each entry produces a Marketplace populated with:
     - installed plugins (from installed_plugins.json, matched by marketplace name)
     - if there's a local directory checkout we know about, the plugins listed in its
       .claude-plugin/marketplace.json (so plugins remain visible after uninstall)

    Remote registry data is fetched separately by the UI worker.
    """
    installed_map = installed_plugins_by_marketplace()
    known = load_known_marketplaces()
    out: list[Marketplace] = []
    for cfg in settings_marketplaces:
        kind = "github" if cfg.github_repo else "directory" if cfg.source_path else "unknown"
        plugins = installed_map.pop(cfg.name, [])
        if cfg.source_path:
            available = scan_directory_marketplace(Path(cfg.source_path), cfg.name)
            plugins = _merge_directory_plugins(plugins, available)
        info = known.get(cfg.name) or {}
        install_location = info.get("installLocation", "") if isinstance(info, dict) else ""
        last_updated = info.get("lastUpdated", "") if isinstance(info, dict) else ""
        # If the marketplace is installed locally but settings has no source_path,
        # also scan the install location so plugins from its registry show up.
        if install_location and not cfg.source_path:
            available = scan_directory_marketplace(Path(install_location), cfg.name)
            plugins = _merge_directory_plugins(plugins, available)
        out.append(Marketplace(
            name=cfg.name,
            source_kind=kind,
            source_repo=cfg.github_repo or "",
            source_path=cfg.source_path or "",
            install_location=install_location,
            plugins=plugins,
            owned=cfg.owned,
            remote_browseable=bool(cfg.github_repo),
            installed=bool(info),
            last_updated=last_updated,
        ))
    # Surface marketplaces that are present locally (installed or with installed
    # plugins) but missing from settings — so the user can still see and act on them.
    seen = {m.name for m in out}
    orphan_names = set(installed_map.keys()) | (set(known.keys()) - seen)
    for orphan_name in orphan_names:
        if orphan_name in seen:
            continue
        info = known.get(orphan_name) or {}
        plugins = installed_map.get(orphan_name, [])
        install_location = info.get("installLocation", "") if isinstance(info, dict) else ""
        if install_location:
            available = scan_directory_marketplace(Path(install_location), orphan_name)
            plugins = _merge_directory_plugins(plugins, available)
        out.append(Marketplace(
            name=orphan_name,
            source_kind="unknown",
            plugins=plugins,
            install_location=install_location,
            installed=bool(info),
            last_updated=info.get("lastUpdated", "") if isinstance(info, dict) else "",
        ))
    return out


def scan_user_skills() -> list[UserSkill]:
    """Standalone skills under ~/.claude/skills/ — not tied to plugins."""
    root = config.claude_user_skills_dir()
    if not root.is_dir():
        return []
    out: list[UserSkill] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        skill_md = entry / "SKILL.md"
        if not skill_md.exists():
            skill_md = entry / "skill.md"
            if not skill_md.exists():
                continue
        try:
            text = skill_md.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        fm, _ = parse_frontmatter(text)
        out.append(UserSkill(
            name=fm.get("name", entry.name),
            folder=entry,
            description=fm.get("description", ""),
        ))
    return out


# Synthetic marketplace name used to surface standalone user skills in the
# UI. The leading "(" makes it sort first and keeps it visually distinct.
LOCAL_MARKETPLACE_NAME = "(local skills)"


def build_local_only_marketplace() -> Marketplace:
    """Synthetic marketplace listing standalone skills under ~/.claude/skills/.

    Each user skill is wrapped as a 1-skill Plugin so the existing tree/detail
    pipeline can render and act on it (notably: upload to a real marketplace).
    The marketplace is flagged `installed=False` and `source_kind="local"` so
    install/uninstall buttons stay hidden — these are read from disk, not
    fetched from anywhere.
    """
    skills = scan_user_skills()
    plugins: list[Plugin] = []
    for s in skills:
        skill_md = s.folder / "SKILL.md"
        if not skill_md.exists():
            skill_md = s.folder / "skill.md"
        plugin_skill = Skill(
            name=s.name,
            description=s.description,
            folder=s.folder,
            skill_md_path=skill_md if skill_md.exists() else None,
            relative_path="",
            plugin_name=s.name,
            marketplace_name=LOCAL_MARKETPLACE_NAME,
            remote_present=False,
        )
        plugins.append(Plugin(
            name=s.name,
            marketplace_name=LOCAL_MARKETPLACE_NAME,
            installed_version="local",
            install_path=s.folder,
            description=s.description,
            skills=[plugin_skill],
            install_state=InstallState.LOCAL_ONLY,
            enabled=None,
        ))
    return Marketplace(
        name=LOCAL_MARKETPLACE_NAME,
        source_kind="local",
        source_path=str(config.claude_user_skills_dir()),
        plugins=plugins,
        installed=False,
        owned=False,
        remote_browseable=False,
    )

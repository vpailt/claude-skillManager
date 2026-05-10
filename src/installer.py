"""Install / update / uninstall plugins by manipulating ~/.claude/plugins/.

A marketplace is just an *index*. The actual plugin lives at the location given
by its `source` entry in `marketplace.json`. So install means:

 1. Resolve the plugin's source (a GitHub URL or directory path).
 2. Download/copy the plugin source at the configured ref into
    `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.
 3. Patch `installed_plugins.json` with a fresh install record.
"""
from __future__ import annotations

import json
import os
import shutil
import stat
from datetime import datetime, timezone
from pathlib import Path

from . import config, plugin_state
from .github_client import GitHubClient
from .models import Plugin, PluginSource


def _rmtree_robust(path: Path) -> None:
    """Remove a directory tree even when paths exceed Windows MAX_PATH or files are read-only."""
    if not path.exists():
        return

    def _onerror(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except Exception:
            pass

    target = str(path)
    if os.name == "nt" and not target.startswith("\\\\?\\"):
        target = "\\\\?\\" + str(path.resolve())
    shutil.rmtree(target, onerror=_onerror)


def _atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(path)


def _load_installed() -> dict:
    f = config.installed_plugins_file()
    if not f.exists():
        return {"version": 2, "plugins": {}}
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return {"version": 2, "plugins": {}}


def _save_installed(data: dict) -> None:
    _atomic_write_json(config.installed_plugins_file(), data)


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _cache_path(marketplace: str, plugin: str, version: str) -> Path:
    return config.plugins_cache_dir() / marketplace / plugin / version


def install_plugin(gh: GitHubClient, plugin: Plugin) -> Path:
    """Install (or update) a plugin using its embedded `source` info.

    Raises ValueError if the plugin has no resolvable source.
    """
    if not plugin.source:
        raise ValueError(f"Plugin {plugin.name} has no source — cannot install.")
    src: PluginSource = plugin.source
    version = plugin.latest_version or src.ref or "0.0.0"

    if src.repo:
        ref = src.ref or gh.get_default_branch(src.repo)
        return _install_from_github(gh, src.repo, plugin.marketplace_name, plugin.name, version, ref)
    if src.kind == "directory" and src.path:
        return _install_from_directory(Path(src.path), plugin.marketplace_name, plugin.name, version)
    raise ValueError(f"Plugin {plugin.name}: unsupported source ({src.kind}: {src.url or src.path})")


def _install_from_github(gh: GitHubClient, repo: str, marketplace_name: str,
                         plugin_name: str, version: str, ref: str) -> Path:
    zip_bytes = gh.download_zipball(repo, ref=ref)
    install_path = _cache_path(marketplace_name, plugin_name, version)
    _rmtree_robust(install_path)
    install_path.mkdir(parents=True, exist_ok=True)
    GitHubClient.extract_zipball(zip_bytes, install_path)

    sha = ""
    try:
        commit = gh.get_latest_commit(repo, branch=ref)
        sha = commit.get("sha", "")
    except Exception:
        sha = ref if len(ref) == 40 else ""

    _register_install(marketplace_name, plugin_name, version, install_path, sha)
    return install_path


def _install_from_directory(source_dir: Path, marketplace_name: str,
                            plugin_name: str, version: str) -> Path:
    install_path = _cache_path(marketplace_name, plugin_name, version)
    _rmtree_robust(install_path)
    shutil.copytree(source_dir, install_path)
    _register_install(marketplace_name, plugin_name, version, install_path, "")
    return install_path


def _register_install(marketplace_name: str, plugin_name: str, version: str,
                      install_path: Path, git_sha: str) -> None:
    data = _load_installed()
    plugins = data.setdefault("plugins", {})
    key = f"{plugin_name}@{marketplace_name}"
    record = {
        "scope": "user",
        "installPath": str(install_path),
        "version": version,
        "installedAt": _now_iso(),
        "lastUpdated": _now_iso(),
    }
    if git_sha:
        record["gitCommitSha"] = git_sha
    plugins[key] = [record]
    data["version"] = data.get("version", 2)
    _save_installed(data)
    # Mirror Claude Code's `/plugin install`: newly installed plugins are enabled
    # by default, but only if the user hasn't already set an explicit value.
    if plugin_state.get_enabled(plugin_name, marketplace_name) is None:
        plugin_state.set_enabled(plugin_name, marketplace_name, True)


def uninstall(plugin: Plugin) -> None:
    data = _load_installed()
    key = f"{plugin.name}@{plugin.marketplace_name}"
    if key in data.get("plugins", {}):
        data["plugins"].pop(key, None)
        _save_installed(data)
    if plugin.install_path and plugin.install_path.exists():
        _rmtree_robust(plugin.install_path)
    plugin_state.remove_entry(plugin.name, plugin.marketplace_name)

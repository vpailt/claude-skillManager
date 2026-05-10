"""Install / uninstall marketplaces by manipulating known_marketplaces.json.

A "marketplace install" is what Claude Code does when you run
`/plugins marketplace add owner/repo`:
 1. Clone the marketplace repo into ~/.claude/plugins/marketplaces/<name>/
 2. Register it in ~/.claude/plugins/known_marketplaces.json with installLocation
    and lastUpdated.

This module mirrors that behavior using the GitHub REST API (no git binary).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from . import config
from .github_client import GitHubClient
from .installer import _atomic_write_json, _rmtree_robust


def known_marketplaces_dir() -> Path:
    return config.claude_plugins_dir() / "marketplaces"


def _load_known() -> dict:
    f = config.known_marketplaces_file()
    if not f.exists():
        return {}
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _save_known(data: dict) -> None:
    _atomic_write_json(config.known_marketplaces_file(), data)


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def is_marketplace_installed(name: str) -> bool:
    return name in _load_known()


def get_install_info(name: str) -> dict:
    """Return the known_marketplaces.json record for a marketplace, or {}."""
    return _load_known().get(name, {}) or {}


def install_marketplace(gh: GitHubClient, name: str, repo: str, ref: str = "",
                        auto_update: bool | None = None) -> Path:
    """Download a marketplace repo and register it in known_marketplaces.json.

    `auto_update`:
      - True/False  → write the flag to the record.
      - None        → preserve the existing value, default False if no record yet.

    Raises ValueError if name/repo are missing, GitHubError on download failure.
    """
    if not name:
        raise ValueError("Marketplace name is required.")
    if not repo:
        raise ValueError(f"Marketplace '{name}' has no GitHub repo configured.")

    if not ref:
        ref = gh.get_default_branch(repo)

    install_path = known_marketplaces_dir() / name
    zip_bytes = gh.download_zipball(repo, ref=ref)
    _rmtree_robust(install_path)
    install_path.mkdir(parents=True, exist_ok=True)
    GitHubClient.extract_zipball(zip_bytes, install_path)

    sha = ""
    try:
        sha = (gh.get_latest_commit(repo, branch=ref) or {}).get("sha", "")
    except Exception:
        pass

    data = _load_known()
    existing = data.get(name) if isinstance(data.get(name), dict) else {}
    record = {
        "source": {"source": "github", "repo": repo},
        "installLocation": str(install_path),
        "lastUpdated": _now_iso(),
    }
    if sha:
        record["gitCommitSha"] = sha
    if auto_update is None:
        record["autoUpdate"] = bool(existing.get("autoUpdate", False))
    else:
        record["autoUpdate"] = bool(auto_update)
    data[name] = record
    _save_known(data)
    return install_path


def set_auto_update(name: str, value: bool) -> bool:
    """Update the `autoUpdate` flag in known_marketplaces.json for `name`.

    Returns False if the marketplace isn't installed (no record to patch).
    """
    data = _load_known()
    info = data.get(name)
    if not isinstance(info, dict):
        return False
    info["autoUpdate"] = bool(value)
    data[name] = info
    _save_known(data)
    return True


def auto_update_if_changed(gh: GitHubClient, name: str, repo: str, ref: str = "") -> tuple[bool, str]:
    """Re-install the marketplace if its remote HEAD differs from the stored SHA.

    Returns (updated, message). `updated=False` means "already up to date" or
    "no SHA recorded yet — skipping to avoid forced redownload" depending on
    `message`.
    """
    if not repo:
        return False, "no repo"
    if not ref:
        try:
            ref = gh.get_default_branch(repo)
        except Exception:
            ref = "main"
    info = get_install_info(name)
    stored = info.get("gitCommitSha", "") if isinstance(info, dict) else ""
    try:
        latest = (gh.get_latest_commit(repo, branch=ref) or {}).get("sha", "")
    except Exception as e:
        return False, f"check failed: {e}"
    if stored and latest and stored == latest:
        return False, "up to date"
    install_marketplace(gh, name, repo, ref=ref)
    return True, latest or "updated"


def uninstall_marketplace(name: str) -> None:
    """Remove the entry from known_marketplaces.json and delete the folder."""
    data = _load_known()
    info = data.pop(name, None)
    if info is not None:
        _save_known(data)
    install_path = (info or {}).get("installLocation") if isinstance(info, dict) else None
    if install_path:
        _rmtree_robust(Path(install_path))
    else:
        # Fallback: delete the conventional location if it exists
        _rmtree_robust(known_marketplaces_dir() / name)

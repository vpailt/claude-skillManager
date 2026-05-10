"""Parse `.claude-plugin/marketplace.json` and resolve plugin sources.

The marketplace.json schema (per claude-code) lists plugins like:
    {
      "name": "vpailt-marketplace",
      "plugins": [
        {
          "name": "afv-library",
          "version": "1.7.5",
          "description": "...",
          "source": { "source": "url", "url": "https://github.com/vpailt/afv-library.git", "ref": "1.7.5-claude.1" }
        }
      ]
    }

A marketplace is therefore an *index* — each plugin entry tells us where to
fetch the actual plugin from.
"""
from __future__ import annotations

import json
import re
from typing import Optional

from .models import Plugin, PluginSource, InstallState


_GITHUB_URL_RE = re.compile(
    r"^(?:https?://(?:www\.)?github\.com/|git@github\.com:|github\.com/)"
    r"(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+?)(?:\.git)?"
    r"(?:/(?:tree|blob|commits?|releases|pulls?|issues|wiki|actions)(?:/[^\s]*)?)?"
    r"/?(?:\?[^\s]*)?(?:#[^\s]*)?$"
)


def parse_marketplace_json(text: str, marketplace_name: str = "") -> list[Plugin]:
    """Parse a marketplace.json text into a list of Plugin entries.

    Each Plugin gets `latest_version` and `source` populated from the registry.
    Skills are NOT populated here — the caller fetches them on demand.
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, dict):
        return []
    name = marketplace_name or data.get("name") or ""
    raw_plugins = data.get("plugins") or []
    plugins: list[Plugin] = []
    for entry in raw_plugins:
        if not isinstance(entry, dict):
            continue
        src = _parse_source(entry.get("source"))
        plugins.append(Plugin(
            name=entry.get("name") or "",
            marketplace_name=name,
            latest_version=entry.get("version"),
            description=entry.get("description", "") or "",
            manifest=None,
            source=src,
            install_state=InstallState.NOT_INSTALLED,
            remote_present=True,
        ))
    return plugins


def _parse_source(raw) -> PluginSource:
    # The marketplace.json schema allows the plugin's `source` to be either a
    # dict (typed source: github / git-subdir / url) or a string. A string source
    # is a path relative to the marketplace repo itself (e.g. "./plugins/foo").
    if isinstance(raw, str):
        return PluginSource(kind="path", repo="", url="", ref="", path=raw)
    if not isinstance(raw, dict):
        return PluginSource(kind="", repo="", url="", ref="", path="")

    kind = raw.get("source", "") or ""
    url = raw.get("url", "") or ""
    repo = raw.get("repo", "") or ""
    ref = raw.get("ref", "") or ""
    path = raw.get("path", "") or ""

    if not repo and url:
        m = _GITHUB_URL_RE.match(url.strip())
        if m:
            repo = f"{m.group('owner')}/{m.group('repo')}"

    return PluginSource(kind=kind, repo=repo, url=url, ref=ref, path=path)


def parse_github_marketplace_url(url: str) -> Optional[str]:
    """Convert a github clone URL ('https://github.com/owner/repo.git') to 'owner/repo'."""
    if not url:
        return None
    m = _GITHUB_URL_RE.match(url.strip())
    return f"{m.group('owner')}/{m.group('repo')}" if m else None


def read_git_remote_origin(repo_dir) -> Optional[str]:
    """Read `.git/config` and return the origin URL — no `git` binary needed."""
    from pathlib import Path
    cfg = Path(repo_dir) / ".git" / "config"
    if not cfg.exists():
        return None
    try:
        text = cfg.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    in_origin = False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            in_origin = s == '[remote "origin"]'
            continue
        if in_origin and s.startswith("url"):
            _, _, value = s.partition("=")
            return value.strip() or None
    return None

"""Fetch a marketplace registry from a GitHub repo and merge with local install state.

A marketplace repo is expected to contain `.claude-plugin/marketplace.json` —
the registry of plugins. We never look for plugins under the marketplace repo
itself; each plugin's `source` tells us where it actually lives.
"""
from __future__ import annotations

from .github_client import GitHubClient, GitHubError
from .models import Plugin, PluginSource, Skill, InstallState
from .registry import parse_marketplace_json


REGISTRY_PATH = ".claude-plugin/marketplace.json"


def fetch_marketplace_plugins(gh: GitHubClient, repo: str, ref: str = "",
                              marketplace_name: str = "") -> list[Plugin]:
    """Return plugins listed in a marketplace's `.claude-plugin/marketplace.json`.

    Falls back to root `marketplace.json` for backwards compat.
    """
    if not ref:
        try:
            ref = gh.get_default_branch(repo)
        except GitHubError:
            ref = "main"

    text = ""
    for path in (REGISTRY_PATH, "marketplace.json"):
        try:
            text, _ = gh.get_file(repo, path, ref=ref)
            break
        except GitHubError:
            continue
    if not text:
        return []
    return parse_marketplace_json(text, marketplace_name=marketplace_name)


def merge_local_remote(local_plugins: list[Plugin], remote_plugins: list[Plugin]) -> list[Plugin]:
    """Merge by plugin name. Remote provides latest_version + source; local provides install state."""
    by_name: dict[str, Plugin] = {p.name: p for p in local_plugins}
    seen: set[str] = set()
    merged: list[Plugin] = []
    for r in remote_plugins:
        seen.add(r.name)
        if r.name in by_name:
            l = by_name[r.name]
            l.latest_version = r.latest_version
            l.remote_present = True
            l.description = l.description or r.description
            l.source = r.source or l.source
            l.install_state = _compute_state(l)
            merged.append(l)
        else:
            r.install_state = InstallState.NOT_INSTALLED
            merged.append(r)
    for l in local_plugins:
        if l.name not in seen:
            l.install_state = InstallState.LOCAL_ONLY if l.installed_version else InstallState.UNKNOWN
            merged.append(l)
    return merged


def _compute_state(p: Plugin) -> InstallState:
    if not p.installed_version:
        return InstallState.NOT_INSTALLED
    if not p.latest_version:
        return InstallState.LOCAL_ONLY
    return InstallState.INSTALLED if _semver_eq(p.installed_version, p.latest_version) else InstallState.OUTDATED


def _semver_eq(a: str, b: str) -> bool:
    return _norm(a) == _norm(b)


def _norm(v: str) -> tuple:
    v = (v or "").lstrip("vV").strip()
    parts = v.split("-", 1)
    nums = parts[0].split(".")
    out: list[int] = []
    for n in nums:
        try:
            out.append(int(n))
        except ValueError:
            return (v,)
    return tuple(out)


def fetch_plugin_skills(gh: GitHubClient, source: PluginSource, plugin_name: str = "",
                        marketplace_name: str = "") -> list[Skill]:
    """List the skills declared in a plugin's GitHub source.

    Looks for `skills/<name>/SKILL.md` (or skill.md) at the configured ref. Returns
    Skill records with `remote_present=True` and no local folder. Returns an empty
    list if the plugin has no GitHub source or the skills folder is missing.
    """
    if not source or not source.repo:
        return []
    ref = source.ref or ""
    try:
        entries = gh.list_dir(source.repo, "skills", ref=ref)
    except GitHubError:
        return []
    out: list[Skill] = []
    for entry in entries:
        if entry.type != "dir":
            continue
        name = entry.path.rsplit("/", 1)[-1]
        out.append(Skill(
            name=name,
            description="",
            folder=None,
            skill_md_path=None,
            relative_path=entry.path,
            plugin_name=plugin_name,
            marketplace_name=marketplace_name,
            remote_present=True,
        ))
    return out


def merge_skills(local_skills: list[Skill], remote_skills: list[Skill]) -> list[Skill]:
    """Merge by skill name. Mark local entries as remote_present when the same name
    exists remotely; append remote-only skills to the list.
    """
    by_name = {s.name: s for s in local_skills}
    merged: list[Skill] = list(local_skills)
    for r in remote_skills:
        if r.name in by_name:
            by_name[r.name].remote_present = True
        else:
            merged.append(r)
    return merged

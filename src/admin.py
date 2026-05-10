"""Admin: upload skills, register/remove/bump plugins by editing the
marketplace registry and plugin source repos via GitHub branch + PR.

All edits go through `submit_changes`: create a branch → PUT each file
via the Contents API → open a PR. No git CLI involved.

Two distinct repos can be edited:
 - the marketplace repo (contains `.claude-plugin/marketplace.json`)
 - the plugin source repo (contains `manifest.json` + `skills/...`)

For monorepo marketplaces (plugin lives inside the marketplace repo) both
"repos" are the same; helpers below handle that transparently.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

from .github_client import GitHubClient, GitHubError


REGISTRY_PATH = ".claude-plugin/marketplace.json"


@dataclass
class FileChange:
    path: str               # repo-relative path
    content: bytes          # raw file bytes


@dataclass
class UploadResult:
    branch: str
    pr_url: str
    pr_number: int


def _safe_slug(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "-" for c in s).strip("-").lower()


def submit_changes(gh: GitHubClient, repo: str, base_branch: str,
                   changes: list[FileChange], pr_title: str, pr_body: str = "",
                   branch_prefix: str = "skillmanager",
                   deletions: Optional[list[str]] = None) -> UploadResult:
    if not changes and not deletions:
        raise ValueError("No file changes provided")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    new_branch = f"{branch_prefix}/{_safe_slug(pr_title)[:40]}-{timestamp}"
    gh.create_branch(repo, new_branch, from_branch=base_branch)

    for change in changes:
        existing_sha = gh.get_file_sha_or_none(repo, change.path, ref=new_branch)
        gh.put_file(
            repo=repo,
            branch=new_branch,
            path=change.path,
            content=change.content,
            message=f"{pr_title}: update {change.path}",
            existing_sha=existing_sha,
        )

    for path in deletions or []:
        sha = gh.get_file_sha_or_none(repo, path, ref=new_branch)
        if not sha:
            continue
        gh.delete_file(
            repo=repo, branch=new_branch, path=path,
            message=f"{pr_title}: delete {path}", sha=sha,
        )

    pr = gh.open_pull_request(repo, head=new_branch, base=base_branch,
                              title=pr_title, body=pr_body)
    return UploadResult(branch=new_branch, pr_url=pr.get("html_url", ""),
                        pr_number=int(pr.get("number", 0)))


def build_skill_md(name: str, description: str, body: str) -> bytes:
    """Build a SKILL.md file with name+description frontmatter."""
    desc = description.replace("\n", " ").strip()
    text = (
        "---\n"
        f"name: {name}\n"
        f"description: {desc}\n"
        "---\n\n"
        f"{body.rstrip()}\n"
    )
    return text.encode("utf-8")


def build_manifest_bump(existing_manifest: dict, new_version: str) -> bytes:
    out = dict(existing_manifest)
    out["version"] = new_version
    return (json.dumps(out, indent=2) + "\n").encode("utf-8")


# ---------- skill folder uploads ----------

def collect_skill_folder_changes(local_folder: Path, target_subpath: str,
                                 max_file_bytes: int = 5_000_000,
                                 skip_names: Iterable[str] = (".git", "__pycache__", ".DS_Store")
                                 ) -> list[FileChange]:
    """Walk `local_folder` and produce FileChange entries with their
    repo-relative paths anchored at `target_subpath` (e.g. "skills/foo").

    - Files larger than `max_file_bytes` are skipped (returned-as-warning is
      out of scope here; the caller can scan the folder beforehand).
    - Hidden directories matching `skip_names` are ignored entirely.
    """
    if not local_folder.is_dir():
        raise FileNotFoundError(f"Skill folder not found: {local_folder}")
    skip = set(skip_names)
    target_subpath = target_subpath.strip("/")
    out: list[FileChange] = []
    for path in sorted(local_folder.rglob("*")):
        if path.is_dir():
            continue
        rel_parts = path.relative_to(local_folder).parts
        if any(p in skip for p in rel_parts[:-1]):
            continue
        if rel_parts[-1] in skip:
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if len(data) > max_file_bytes:
            continue
        rel_posix = "/".join(rel_parts)
        out.append(FileChange(
            path=f"{target_subpath}/{rel_posix}".lstrip("/"),
            content=data,
        ))
    return out


# ---------- marketplace.json edits ----------

def fetch_marketplace_registry(gh: GitHubClient, repo: str, ref: str = ""
                               ) -> tuple[dict, str, str]:
    """Read `.claude-plugin/marketplace.json` from a marketplace repo.

    Returns (parsed_dict, registry_path, blob_sha). Raises GitHubError if
    neither `.claude-plugin/marketplace.json` nor root `marketplace.json` exists.
    The blob_sha is informational — `submit_changes` re-resolves it on the
    branch before each PUT.
    """
    last_err: Optional[Exception] = None
    for path in (REGISTRY_PATH, "marketplace.json"):
        try:
            text, sha = gh.get_file(repo, path, ref=ref)
            try:
                data = json.loads(text)
            except json.JSONDecodeError as e:
                raise GitHubError(f"{path} is not valid JSON: {e}")
            if not isinstance(data, dict):
                raise GitHubError(f"{path} root must be an object")
            return data, path, sha
        except GitHubError as e:
            last_err = e
            continue
    raise GitHubError(f"No marketplace.json found in {repo}: {last_err}")


def serialize_registry(data: dict) -> bytes:
    return (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def add_plugin_to_registry(registry: dict, *, name: str, version: str,
                           description: str, source: dict) -> dict:
    """Return a new registry dict with the new plugin entry appended.

    Raises ValueError if a plugin with that name already exists.
    """
    new_reg = dict(registry)
    plugins = list(new_reg.get("plugins") or [])
    for entry in plugins:
        if isinstance(entry, dict) and (entry.get("name") or "") == name:
            raise ValueError(f"Plugin '{name}' already exists in this marketplace.")
    plugins.append({
        "name": name,
        "version": version,
        "description": description,
        "source": source,
    })
    new_reg["plugins"] = plugins
    return new_reg


def remove_plugin_from_registry(registry: dict, name: str) -> dict:
    new_reg = dict(registry)
    plugins = [p for p in (new_reg.get("plugins") or [])
               if not (isinstance(p, dict) and (p.get("name") or "") == name)]
    new_reg["plugins"] = plugins
    return new_reg


def update_plugin_in_registry(registry: dict, name: str, *,
                              version: Optional[str] = None,
                              description: Optional[str] = None,
                              source: Optional[dict] = None) -> dict:
    new_reg = dict(registry)
    plugins = list(new_reg.get("plugins") or [])
    found = False
    for i, entry in enumerate(plugins):
        if not isinstance(entry, dict) or (entry.get("name") or "") != name:
            continue
        updated = dict(entry)
        if version is not None:
            updated["version"] = version
        if description is not None:
            updated["description"] = description
        if source is not None:
            updated["source"] = source
        plugins[i] = updated
        found = True
        break
    if not found:
        raise ValueError(f"Plugin '{name}' not found in this marketplace.")
    new_reg["plugins"] = plugins
    return new_reg

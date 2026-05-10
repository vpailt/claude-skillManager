"""Minimal GitHub REST API client.

Covers:
 - reading repo trees and file contents (browse a marketplace)
 - downloading a tarball/zipball at a ref (install/update)
 - branch + commit-via-Contents-API + open PR (admin upload)

No git CLI dependency.
"""
from __future__ import annotations

import base64
import io
import json
import zipfile
from dataclasses import dataclass
from typing import Optional

import requests


GITHUB_API = "https://api.github.com"


class GitHubError(RuntimeError):
    pass


@dataclass
class RemoteFile:
    path: str
    type: str          # "file" | "dir"
    sha: str = ""
    size: int = 0
    download_url: str = ""


class GitHubClient:
    def __init__(self, token: str = "") -> None:
        self.token = token.strip()
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "SkillManager/1.0",
        })
        if self.token:
            self.session.headers["Authorization"] = f"Bearer {self.token}"

    # ---------- low level ----------
    def _request(self, method: str, url: str, **kw) -> requests.Response:
        if not url.startswith("http"):
            url = GITHUB_API + url
        r = self.session.request(method, url, timeout=30, **kw)
        if r.status_code >= 400:
            try:
                msg = r.json().get("message", r.text)
            except Exception:
                msg = r.text
            raise GitHubError(f"{method} {url} -> {r.status_code}: {msg}")
        return r

    # ---------- read ----------
    def get_repo(self, repo: str) -> dict:
        return self._request("GET", f"/repos/{repo}").json()

    def get_default_branch(self, repo: str) -> str:
        return self.get_repo(repo).get("default_branch", "main")

    def list_dir(self, repo: str, path: str = "", ref: str = "") -> list[RemoteFile]:
        params = {"ref": ref} if ref else {}
        r = self._request("GET", f"/repos/{repo}/contents/{path}", params=params)
        items = r.json()
        if isinstance(items, dict):
            items = [items]
        out: list[RemoteFile] = []
        for it in items:
            out.append(RemoteFile(
                path=it.get("path", ""),
                type=it.get("type", ""),
                sha=it.get("sha", ""),
                size=int(it.get("size", 0) or 0),
                download_url=it.get("download_url") or "",
            ))
        return out

    def list_dir_recursive(self, repo: str, path: str, ref: str = "") -> list[RemoteFile]:
        """List all files (no directories) under `path` recursively.

        Returns an empty list if `path` is missing. Used by the admin panel to
        enumerate every file under a remote skill folder so a deletion PR can
        target each one explicitly via the Contents API.
        """
        out: list[RemoteFile] = []
        try:
            entries = self.list_dir(repo, path, ref=ref)
        except GitHubError:
            return out
        for entry in entries:
            if entry.type == "dir":
                out.extend(self.list_dir_recursive(repo, entry.path, ref=ref))
            elif entry.type == "file":
                out.append(entry)
        return out

    def get_file(self, repo: str, path: str, ref: str = "") -> tuple[str, str]:
        """Return (content_text, blob_sha). Decoded from base64."""
        params = {"ref": ref} if ref else {}
        r = self._request("GET", f"/repos/{repo}/contents/{path}", params=params)
        data = r.json()
        if isinstance(data, list):
            raise GitHubError(f"{path} is a directory")
        content = data.get("content", "")
        encoding = data.get("encoding", "base64")
        if encoding == "base64":
            text = base64.b64decode(content).decode("utf-8", errors="replace")
        else:
            text = content
        return text, data.get("sha", "")

    def get_latest_commit(self, repo: str, branch: str = "") -> dict:
        if not branch:
            branch = self.get_default_branch(repo)
        return self._request("GET", f"/repos/{repo}/commits/{branch}").json()

    # ---------- download (install/update) ----------
    def download_zipball(self, repo: str, ref: str = "") -> bytes:
        """Return raw bytes of the repo zipball at ref."""
        if not ref:
            ref = self.get_default_branch(repo)
        url = f"https://api.github.com/repos/{repo}/zipball/{ref}"
        # follow redirect to codeload
        r = self.session.get(url, timeout=120, allow_redirects=True)
        if r.status_code >= 400:
            raise GitHubError(self._zipball_error_message(repo, ref, r.status_code))
        return r.content

    def _zipball_error_message(self, repo: str, ref: str, status: int) -> str:
        """Produce a diagnostic message for a failed zipball download.

        On 404, probes the repo to tell apart "repo unreachable" from
        "repo OK but ref missing" — the two cases need very different fixes.
        """
        if status != 404:
            return f"zipball {repo}@{ref} -> {status}"
        try:
            self.get_repo(repo)
            repo_ok = True
        except GitHubError:
            repo_ok = False
        if not repo_ok:
            hint = ("Check the owner/repo spelling, or — if it's private — make "
                    "sure your GitHub token has access to it.")
            return (f"Repository {repo} is not accessible (404).\n\n{hint}")
        hint = (f"The repository {repo} exists, but it has no tag, branch, or "
                f"commit named '{ref}'.\n\n"
                f"Either create a git tag matching that ref (e.g. "
                f"`git tag {ref} && git push origin {ref}`), "
                f"or update the marketplace.json entry to point `ref` at an "
                f"existing branch/tag/SHA.")
        return f"zipball {repo}@{ref} -> 404\n\n{hint}"

    @staticmethod
    def extract_zipball(zip_bytes: bytes, dest_dir, subpath: str = "") -> None:
        """Extract a github zipball into dest_dir, stripping the top-level commit folder.

        If `subpath` is given (e.g. "skills/foo"), only files under that path are extracted
        and the path prefix is stripped. Bypasses the Windows 260-char path limit using
        the `\\\\?\\` prefix on absolute paths.
        """
        import os
        from pathlib import Path
        dest = Path(dest_dir).resolve()
        dest.mkdir(parents=True, exist_ok=True)

        def long_path(p: Path) -> str:
            s = str(p)
            if os.name == "nt" and not s.startswith("\\\\?\\"):
                s = "\\\\?\\" + s
            return s

        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            names = zf.namelist()
            if not names:
                return
            top = names[0].split("/", 1)[0] + "/"
            for name in names:
                if not name.startswith(top) or name.endswith("/"):
                    continue
                rel = name[len(top):]
                if subpath:
                    if not rel.startswith(subpath.rstrip("/") + "/"):
                        continue
                    rel = rel[len(subpath.rstrip("/")) + 1:]
                target = dest / rel
                os.makedirs(long_path(target.parent), exist_ok=True)
                with zf.open(name) as src, open(long_path(target), "wb") as dst:
                    dst.write(src.read())

    def ref_exists(self, repo: str, ref: str) -> bool:
        """True if `ref` (tag, branch, or commit SHA) is reachable in `repo`."""
        if not ref:
            return False
        try:
            self._request("GET", f"/repos/{repo}/commits/{ref}")
            return True
        except GitHubError:
            return False

    # ---------- write (admin PR) ----------
    def get_branch_sha(self, repo: str, branch: str) -> str:
        r = self._request("GET", f"/repos/{repo}/git/ref/heads/{branch}")
        return r.json()["object"]["sha"]

    def create_tag(self, repo: str, tag: str, sha: str) -> dict:
        """Create a lightweight tag pointing at `sha`. Requires push access to `repo`."""
        body = {"ref": f"refs/tags/{tag}", "sha": sha}
        return self._request("POST", f"/repos/{repo}/git/refs", json=body).json()

    def create_branch(self, repo: str, new_branch: str, from_branch: str = "") -> str:
        if not from_branch:
            from_branch = self.get_default_branch(repo)
        sha = self.get_branch_sha(repo, from_branch)
        body = {"ref": f"refs/heads/{new_branch}", "sha": sha}
        try:
            self._request("POST", f"/repos/{repo}/git/refs", json=body)
        except GitHubError as e:
            if "Reference already exists" not in str(e):
                raise
        return sha

    def put_file(self, repo: str, branch: str, path: str, content: bytes,
                 message: str, existing_sha: Optional[str] = None) -> dict:
        """Create or update a file via Contents API. Returns API response."""
        body = {
            "message": message,
            "branch": branch,
            "content": base64.b64encode(content).decode("ascii"),
        }
        if existing_sha:
            body["sha"] = existing_sha
        r = self._request("PUT", f"/repos/{repo}/contents/{path}", json=body)
        return r.json()

    def get_file_sha_or_none(self, repo: str, path: str, ref: str) -> Optional[str]:
        try:
            _, sha = self.get_file(repo, path, ref=ref)
            return sha
        except GitHubError:
            return None

    def delete_file(self, repo: str, branch: str, path: str, message: str,
                    sha: str) -> dict:
        body = {"message": message, "branch": branch, "sha": sha}
        r = self._request("DELETE", f"/repos/{repo}/contents/{path}", json=body)
        return r.json()

    def open_pull_request(self, repo: str, head: str, base: str, title: str, body: str = "") -> dict:
        payload = {"title": title, "head": head, "base": base, "body": body}
        r = self._request("POST", f"/repos/{repo}/pulls", json=payload)
        return r.json()

    # ---------- helpers ----------
    def auth_check(self) -> tuple[bool, str]:
        """Return (ok, identity_or_error)."""
        if not self.token:
            return False, "No token configured"
        try:
            r = self._request("GET", "/user")
            return True, r.json().get("login", "?")
        except GitHubError as e:
            return False, str(e)

    def get_permissions(self, repo: str) -> dict:
        """Return the authenticated user's permissions on `repo`.

        Result keys: admin, maintain, push, triage, pull (booleans). Empty dict
        when unauthenticated, on a 404 (private repo with no access), or any
        other error — callers must treat absence as "no rights".
        """
        if not self.token:
            return {}
        try:
            return self.get_repo(repo).get("permissions") or {}
        except GitHubError:
            return {}

    def can_push(self, repo: str) -> bool:
        """True when the current token can push to `repo` (write access)."""
        p = self.get_permissions(repo)
        return bool(p.get("push") or p.get("maintain") or p.get("admin"))

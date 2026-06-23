//! Minimal Git-forge REST API client — originally a port of
//! `src/github_client.py`, now provider-aware.
//!
//! Despite the type name (`GitHubClient`, kept to avoid churning every caller),
//! this speaks both the **GitHub** REST API and the **Gitea** REST API
//! (`/api/v1`). The two are close but not identical; the handful of divergent
//! endpoints (archive download, branch/tag creation, single-commit lookup,
//! auth header, contents create-vs-update) branch on [`Provider`]. Everything
//! else (contents read, pulls, releases, `/user`, repo permissions) is shared.
//!
//! Synchronous wrapper around `reqwest::blocking`. Network host comes from
//! `api_base`: `https://api.github.com` for GitHub, or
//! `https://<host>/api/v1` for a self-hosted Gitea instance.

use crate::error::{Error, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{create_dir_all, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const GITHUB_API: &str = "https://api.github.com";

/// Which Git forge a client talks to. GitHub is the default so existing
/// marketplaces (and `MarketplaceConfig` deserialization) keep working with no
/// `provider` field present.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Gitea,
}

impl Default for Provider {
    fn default() -> Self {
        Provider::Github
    }
}

/// Normalize a user-entered Gitea base URL into its API root.
///
/// Accepts `https://git.example.com`, `https://git.example.com/`, or an URL
/// that already ends with `/api/v1`, and always returns `…/api/v1` with no
/// trailing slash.
fn gitea_api_base(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with("/api/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/api/v1")
    }
}

/// Extract the bare host (`git.example.com`) from a URL or `host[:port]`
/// string. Used as the credential-vault key and to stamp PR records so a
/// status refresh later targets the right instance.
pub fn host_of(url: &str) -> String {
    let s = url.trim();
    let s = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    s.split('/').next().unwrap_or(s).to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    #[serde(default)]
    pub path: String,
    /// "file" | "dir"
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub sha: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub download_url: String,
}

#[derive(Clone)]
pub struct GitHubClient {
    provider: Provider,
    /// API root with no trailing slash: `https://api.github.com` or
    /// `https://<host>/api/v1`.
    api_base: String,
    token: String,
    client: Client,
}

impl GitHubClient {
    /// GitHub client (back-compat constructor — every existing call site uses
    /// this). Talks to `https://api.github.com` with a `Bearer` token.
    pub fn new(token: &str) -> Result<Self> {
        Self::for_provider(Provider::Github, "", token, false)
    }

    /// Build a client for an arbitrary provider/host.
    ///
    /// * `base_url` is ignored for GitHub and required for Gitea (the instance
    ///   root, e.g. `https://git.almaviacx.local`).
    /// * `insecure_tls` disables certificate verification — only meaningful for
    ///   self-hosted Gitea behind an internal/self-signed CA. Off by default.
    pub fn for_provider(
        provider: Provider,
        base_url: &str,
        token: &str,
        insecure_tls: bool,
    ) -> Result<Self> {
        let api_base = match provider {
            Provider::Github => GITHUB_API.to_string(),
            Provider::Gitea => {
                let b = gitea_api_base(base_url);
                if b.is_empty() {
                    return Err(Error::Invalid(
                        "Gitea instance URL is required (e.g. https://git.example.com).".into(),
                    ));
                }
                b
            }
        };

        let mut headers = HeaderMap::new();
        let token = token.trim().to_string();
        match provider {
            Provider::Github => {
                headers.insert("Accept", HeaderValue::from_static("application/vnd.github+json"));
                headers.insert("X-GitHub-Api-Version", HeaderValue::from_static("2022-11-28"));
                if !token.is_empty() {
                    let val = HeaderValue::from_str(&format!("Bearer {token}"))
                        .map_err(|e| Error::Other(e.to_string()))?;
                    headers.insert(AUTHORIZATION, val);
                }
            }
            Provider::Gitea => {
                headers.insert("Accept", HeaderValue::from_static("application/json"));
                if !token.is_empty() {
                    // Gitea personal access tokens use the `token` scheme.
                    let val = HeaderValue::from_str(&format!("token {token}"))
                        .map_err(|e| Error::Other(e.to_string()))?;
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }
        headers.insert("User-Agent", HeaderValue::from_static("SkillManager/1.0"));

        let mut builder = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(30));
        if insecure_tls {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let client = builder.build()?;
        Ok(Self {
            provider,
            api_base,
            token,
            client,
        })
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn provider(&self) -> Provider {
        self.provider
    }

    /// Bare host of this client's API root (`api.github.com` or the Gitea
    /// host). Used to key tokens and stamp PR records.
    pub fn host(&self) -> String {
        host_of(&self.api_base)
    }

    /// Instance root suitable for rebuilding this client later: empty for
    /// GitHub (its base is implicit), or `https://<host>` for Gitea (the
    /// `/api/v1` suffix stripped back off). Stored on PR records.
    pub fn base_url(&self) -> String {
        match self.provider {
            Provider::Github => String::new(),
            Provider::Gitea => self.api_base.trim_end_matches("/api/v1").to_string(),
        }
    }

    fn request(&self, method: reqwest::Method, url: &str) -> reqwest::blocking::RequestBuilder {
        let url = if url.starts_with("http") {
            url.to_string()
        } else {
            format!("{}{url}", self.api_base)
        };
        self.client.request(method, url)
    }

    fn check(resp: Response, method: &str, url: &str) -> Result<Response> {
        let status = resp.status();
        if status.is_client_error() || status.is_server_error() {
            let text = resp.text().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
                .unwrap_or(text);
            return Err(Error::GitHub(format!("{method} {url} -> {status}: {msg}")));
        }
        Ok(resp)
    }

    // ---------- read ----------
    pub fn get_repo(&self, repo: &str) -> Result<Value> {
        let url = format!("/repos/{repo}");
        let resp = self.request(reqwest::Method::GET, &url).send()?;
        let resp = Self::check(resp, "GET", &url)?;
        Ok(resp.json()?)
    }

    pub fn get_default_branch(&self, repo: &str) -> Result<String> {
        Ok(self
            .get_repo(repo)?
            .get("default_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("main")
            .to_string())
    }

    pub fn list_dir(&self, repo: &str, path: &str, r#ref: &str) -> Result<Vec<RemoteFile>> {
        let url = format!("/repos/{repo}/contents/{path}");
        let mut req = self.request(reqwest::Method::GET, &url);
        if !r#ref.is_empty() {
            req = req.query(&[("ref", r#ref)]);
        }
        let resp = Self::check(req.send()?, "GET", &url)?;
        let value: Value = resp.json()?;
        let items = if value.is_array() {
            value.as_array().cloned().unwrap_or_default()
        } else {
            vec![value]
        };
        let mut out = Vec::new();
        for it in items {
            out.push(RemoteFile {
                path: it
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                r#type: it
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                sha: it
                    .get("sha")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                size: it.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                download_url: it
                    .get("download_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            });
        }
        Ok(out)
    }

    pub fn list_dir_recursive(
        &self,
        repo: &str,
        path: &str,
        r#ref: &str,
    ) -> Result<Vec<RemoteFile>> {
        let mut out = Vec::new();
        let entries = match self.list_dir(repo, path, r#ref) {
            Ok(v) => v,
            Err(_) => return Ok(out),
        };
        for entry in entries {
            if entry.r#type == "dir" {
                if let Ok(sub) = self.list_dir_recursive(repo, &entry.path, r#ref) {
                    out.extend(sub);
                }
            } else if entry.r#type == "file" {
                out.push(entry);
            }
        }
        Ok(out)
    }

    pub fn get_file(&self, repo: &str, path: &str, r#ref: &str) -> Result<(String, String)> {
        let url = format!("/repos/{repo}/contents/{path}");
        let mut req = self.request(reqwest::Method::GET, &url);
        if !r#ref.is_empty() {
            req = req.query(&[("ref", r#ref)]);
        }
        let resp = Self::check(req.send()?, "GET", &url)?;
        let data: Value = resp.json()?;
        if data.is_array() {
            return Err(Error::GitHub(format!("{path} is a directory")));
        }
        let content = data
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let encoding = data
            .get("encoding")
            .and_then(|v| v.as_str())
            .unwrap_or("base64");
        let text = if encoding == "base64" {
            let cleaned: String = content.chars().filter(|c| !c.is_whitespace()).collect();
            let raw = B64.decode(cleaned).unwrap_or_default();
            String::from_utf8_lossy(&raw).into_owned()
        } else {
            content.to_string()
        };
        let sha = data
            .get("sha")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        Ok((text, sha))
    }

    pub fn get_latest_commit(&self, repo: &str, branch: &str) -> Result<Value> {
        let branch = if branch.is_empty() {
            self.get_default_branch(repo)?
        } else {
            branch.to_string()
        };
        match self.provider {
            Provider::Github => {
                let url = format!("/repos/{repo}/commits/{branch}");
                let resp = Self::check(
                    self.request(reqwest::Method::GET, &url).send()?,
                    "GET",
                    &url,
                )?;
                Ok(resp.json()?)
            }
            Provider::Gitea => {
                // Gitea has no single-commit-by-ref endpoint; list with sha=ref
                // and take the head. Each element carries a top-level `sha`.
                let url = format!("/repos/{repo}/commits");
                let resp = Self::check(
                    self.request(reqwest::Method::GET, &url)
                        .query(&[("sha", branch.as_str()), ("limit", "1"), ("stat", "false")])
                        .send()?,
                    "GET",
                    &url,
                )?;
                let v: Value = resp.json()?;
                v.as_array()
                    .and_then(|a| a.first())
                    .cloned()
                    .ok_or_else(|| Error::GitHub(format!("no commits for {repo}@{branch}")))
            }
        }
    }

    // ---------- download (install/update) ----------
    pub fn download_zipball(&self, repo: &str, r#ref: &str) -> Result<Vec<u8>> {
        let r#ref = if r#ref.is_empty() {
            self.get_default_branch(repo)?
        } else {
            r#ref.to_string()
        };
        let url = match self.provider {
            Provider::Github => format!("{}/repos/{repo}/zipball/{}", self.api_base, r#ref),
            // Gitea serves archives at /archive/<ref>.<ext>; the extension
            // picks the format. The top-level folder differs from GitHub's
            // `<repo>-<sha>/`, but `extract_zipball` strips the first path
            // segment generically, so extraction is unaffected.
            Provider::Gitea => format!("{}/repos/{repo}/archive/{}.zip", self.api_base, r#ref),
        };
        let resp = self
            .client
            .get(&url)
            .timeout(Duration::from_secs(120))
            .send()?;
        let status = resp.status();
        if status.is_client_error() || status.is_server_error() {
            return Err(Error::GitHub(self.zipball_error_message(
                repo,
                &r#ref,
                status.as_u16(),
            )));
        }
        Ok(resp.bytes()?.to_vec())
    }

    fn zipball_error_message(&self, repo: &str, r#ref: &str, status: u16) -> String {
        if status != 404 {
            return format!("zipball {repo}@{} -> {status}", r#ref);
        }
        let repo_ok = self.get_repo(repo).is_ok();
        if !repo_ok {
            return format!(
                "Repository {repo} is not accessible (404).\n\nCheck the owner/repo spelling, \
                 or — if it's private — make sure your GitHub token has access to it."
            );
        }
        format!(
            "zipball {repo}@{r} -> 404\n\nThe repository {repo} exists, but it has no tag, \
             branch, or commit named '{r}'.\n\nEither create a git tag matching that ref \
             (e.g. `git tag {r} && git push origin {r}`), or update the marketplace.json entry.",
            r = r#ref
        )
    }

    /// Extract a github zipball into `dest_dir`, stripping the top-level `<repo>-<sha>/` folder.
    /// `subpath` lets the caller restrict to e.g. "skills/foo" and strips that prefix too.
    pub fn extract_zipball(zip_bytes: &[u8], dest_dir: &Path, subpath: &str) -> Result<()> {
        let dest = std::fs::canonicalize(dest_dir).unwrap_or_else(|_| dest_dir.to_path_buf());
        create_dir_all(&dest)?;

        let cursor = Cursor::new(zip_bytes);
        let mut zip = zip::ZipArchive::new(cursor)?;
        if zip.is_empty() {
            return Ok(());
        }
        // Top-level prefix to strip: first entry's first segment + '/'.
        let top = {
            let first = zip.by_index(0)?;
            let name = first.name().to_string();
            name.split('/').next().unwrap_or_default().to_string() + "/"
        };
        let sub_clean = subpath.trim_end_matches('/');
        let sub_prefix = if sub_clean.is_empty() {
            String::new()
        } else {
            format!("{sub_clean}/")
        };

        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let name = entry.name().to_string();
            if !name.starts_with(&top) || name.ends_with('/') {
                continue;
            }
            let rel = &name[top.len()..];
            let rel = if !sub_prefix.is_empty() {
                if !rel.starts_with(&sub_prefix) {
                    continue;
                }
                &rel[sub_prefix.len()..]
            } else {
                rel
            };
            let target = dest.join(rel);
            if let Some(parent) = target.parent() {
                create_dir_all(long_path(parent))?;
            }
            let mut f = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(long_path(&target))?;
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf)?;
            f.write_all(&buf)?;
        }
        Ok(())
    }

    pub fn ref_exists(&self, repo: &str, r#ref: &str) -> bool {
        if r#ref.is_empty() {
            return false;
        }
        match self.provider {
            Provider::Github => {
                let url = format!("/repos/{repo}/commits/{}", r#ref);
                match self.request(reqwest::Method::GET, &url).send() {
                    Ok(r) => Self::check(r, "GET", &url).is_ok(),
                    Err(_) => false,
                }
            }
            Provider::Gitea => {
                let url = format!("/repos/{repo}/commits");
                let resp = self
                    .request(reqwest::Method::GET, &url)
                    .query(&[("sha", r#ref), ("limit", "1"), ("stat", "false")])
                    .send();
                match resp {
                    Ok(r) => match Self::check(r, "GET", &url) {
                        Ok(r) => r
                            .json::<Value>()
                            .ok()
                            .and_then(|v| v.as_array().map(|a| !a.is_empty()))
                            .unwrap_or(false),
                        Err(_) => false,
                    },
                    Err(_) => false,
                }
            }
        }
    }

    // ---------- write (admin PR) ----------
    pub fn get_branch_sha(&self, repo: &str, branch: &str) -> Result<String> {
        match self.provider {
            Provider::Github => {
                let url = format!("/repos/{repo}/git/ref/heads/{branch}");
                let resp = Self::check(
                    self.request(reqwest::Method::GET, &url).send()?,
                    "GET",
                    &url,
                )?;
                let v: Value = resp.json()?;
                Ok(v["object"]["sha"].as_str().unwrap_or_default().to_string())
            }
            Provider::Gitea => {
                let url = format!("/repos/{repo}/branches/{branch}");
                let resp = Self::check(
                    self.request(reqwest::Method::GET, &url).send()?,
                    "GET",
                    &url,
                )?;
                let v: Value = resp.json()?;
                Ok(v["commit"]["id"].as_str().unwrap_or_default().to_string())
            }
        }
    }

    pub fn create_tag(&self, repo: &str, tag: &str, sha: &str) -> Result<Value> {
        let (url, body) = match self.provider {
            Provider::Github => (
                format!("/repos/{repo}/git/refs"),
                json!({"ref": format!("refs/tags/{tag}"), "sha": sha}),
            ),
            // Gitea has no generic git/refs POST; use the dedicated tags API.
            // `target` accepts a SHA or a ref name.
            Provider::Gitea => (
                format!("/repos/{repo}/tags"),
                json!({"tag_name": tag, "target": sha}),
            ),
        };
        let resp = Self::check(
            self.request(reqwest::Method::POST, &url)
                .json(&body)
                .send()?,
            "POST",
            &url,
        )?;
        Ok(resp.json()?)
    }

    /// Create a GitHub release on an existing tag. Returns Ok with the
    /// existing release JSON when the release for that tag already exists
    /// (so the caller doesn't have to special-case re-runs).
    pub fn create_release(
        &self,
        repo: &str,
        tag: &str,
        name: &str,
        body: &str,
    ) -> Result<Value> {
        let url = format!("/repos/{repo}/releases");
        let payload = json!({
            "tag_name": tag,
            "name": name,
            "body": body,
            "draft": false,
            "prerelease": false,
        });
        let resp = self
            .request(reqwest::Method::POST, &url)
            .json(&payload)
            .send()?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp.json()?);
        }
        // 422 "already_exists" — fetch the existing release for the tag.
        if status.as_u16() == 422 {
            let existing_url = format!("/repos/{repo}/releases/tags/{tag}");
            if let Ok(r) = Self::check(
                self.request(reqwest::Method::GET, &existing_url).send()?,
                "GET",
                &existing_url,
            ) {
                return Ok(r.json()?);
            }
        }
        let text = resp.text().unwrap_or_default();
        Err(Error::GitHub(format!("POST {url} -> {status}: {text}")))
    }

    pub fn create_branch(
        &self,
        repo: &str,
        new_branch: &str,
        from_branch: &str,
    ) -> Result<String> {
        let from = if from_branch.is_empty() {
            self.get_default_branch(repo)?
        } else {
            from_branch.to_string()
        };
        match self.provider {
            Provider::Github => {
                let sha = self.get_branch_sha(repo, &from)?;
                let url = format!("/repos/{repo}/git/refs");
                let body = json!({"ref": format!("refs/heads/{new_branch}"), "sha": sha});
                let resp = self.request(reqwest::Method::POST, &url).json(&body).send()?;
                let status = resp.status();
                if status.is_client_error() {
                    let text = resp.text().unwrap_or_default();
                    if !text.contains("Reference already exists") {
                        return Err(Error::GitHub(format!("POST {url} -> {status}: {text}")));
                    }
                }
                Ok(sha)
            }
            Provider::Gitea => {
                // Dedicated branch API: no need to resolve the source SHA first.
                let url = format!("/repos/{repo}/branches");
                let body = json!({"new_branch_name": new_branch, "old_ref_name": from});
                let resp = self.request(reqwest::Method::POST, &url).json(&body).send()?;
                let status = resp.status();
                if status.is_client_error() {
                    // 409 Conflict = branch already exists; treat as success so
                    // re-running an admin flow is idempotent (mirrors GitHub).
                    let text = resp.text().unwrap_or_default();
                    let already = status.as_u16() == 409
                        || text.contains("already exists")
                        || text.contains("branch already exists");
                    if !already {
                        return Err(Error::GitHub(format!("POST {url} -> {status}: {text}")));
                    }
                }
                // The caller (submit_changes) discards this; resolve lazily only
                // when needed elsewhere. Returning the new branch's SHA keeps the
                // signature meaningful.
                self.get_branch_sha(repo, new_branch).or_else(|_| Ok(String::new()))
            }
        }
    }

    pub fn put_file(
        &self,
        repo: &str,
        branch: &str,
        path: &str,
        content: &[u8],
        message: &str,
        existing_sha: Option<&str>,
    ) -> Result<Value> {
        let url = format!("/repos/{repo}/contents/{path}");
        let mut body = json!({
            "message": message,
            "branch": branch,
            "content": B64.encode(content),
        });
        if let Some(sha) = existing_sha {
            body["sha"] = json!(sha);
        }
        // GitHub: PUT handles both create and update (sha optional).
        // Gitea: POST creates, PUT updates (and PUT requires the existing sha).
        let method = match (self.provider, existing_sha) {
            (Provider::Gitea, None) => reqwest::Method::POST,
            _ => reqwest::Method::PUT,
        };
        let resp = Self::check(
            self.request(method.clone(), &url).json(&body).send()?,
            method.as_str(),
            &url,
        )?;
        Ok(resp.json()?)
    }

    pub fn get_file_sha_or_none(&self, repo: &str, path: &str, r#ref: &str) -> Option<String> {
        self.get_file(repo, path, r#ref).ok().map(|(_, sha)| sha)
    }

    pub fn delete_file(
        &self,
        repo: &str,
        branch: &str,
        path: &str,
        message: &str,
        sha: &str,
    ) -> Result<Value> {
        let url = format!("/repos/{repo}/contents/{path}");
        let body = json!({"message": message, "branch": branch, "sha": sha});
        let resp = Self::check(
            self.request(reqwest::Method::DELETE, &url)
                .json(&body)
                .send()?,
            "DELETE",
            &url,
        )?;
        Ok(resp.json()?)
    }

    pub fn open_pull_request(
        &self,
        repo: &str,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
    ) -> Result<Value> {
        let url = format!("/repos/{repo}/pulls");
        let payload = json!({"title": title, "head": head, "base": base, "body": body});
        let resp = Self::check(
            self.request(reqwest::Method::POST, &url)
                .json(&payload)
                .send()?,
            "POST",
            &url,
        )?;
        Ok(resp.json()?)
    }

    pub fn auth_check(&self) -> (bool, String) {
        if self.token.is_empty() {
            return (false, "No token configured".to_string());
        }
        let url = "/user";
        match self.request(reqwest::Method::GET, url).send() {
            Ok(r) => match Self::check(r, "GET", url) {
                Ok(r) => match r.json::<Value>() {
                    Ok(v) => (
                        true,
                        v.get("login")
                            .and_then(|x| x.as_str())
                            .unwrap_or("?")
                            .to_string(),
                    ),
                    Err(e) => (false, e.to_string()),
                },
                Err(e) => (false, e.to_string()),
            },
            Err(e) => (false, e.to_string()),
        }
    }

    pub fn get_permissions(&self, repo: &str) -> Value {
        if self.token.is_empty() {
            return json!({});
        }
        match self.get_repo(repo) {
            Ok(v) => v
                .get("permissions")
                .cloned()
                .unwrap_or_else(|| json!({})),
            Err(_) => json!({}),
        }
    }

    /// Returns true if the current token has push (or stronger) rights on
    /// `repo`. Used to decide which marketplaces show up as editable in the
    /// admin UI.
    pub fn can_push(&self, repo: &str) -> bool {
        let p = self.get_permissions(repo);
        ["push", "maintain", "admin"]
            .iter()
            .any(|k| p.get(*k).and_then(|v| v.as_bool()).unwrap_or(false))
    }

    pub fn get_token_scopes(&self) -> Vec<String> {
        if self.token.is_empty() {
            return Vec::new();
        }
        let url = "/user";
        let resp = match self.request(reqwest::Method::GET, url).send() {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        let raw = resp
            .headers()
            .get("X-OAuth-Scopes")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        raw.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    pub fn get_rate_limit(&self) -> (i64, i64) {
        let url = "/rate_limit";
        let resp = match self.request(reqwest::Method::GET, url).send() {
            Ok(r) => r,
            Err(_) => return (-1, -1),
        };
        let v: Value = match resp.json() {
            Ok(v) => v,
            Err(_) => return (-1, -1),
        };
        let core = v
            .get("resources")
            .and_then(|r| r.get("core"))
            .or_else(|| v.get("rate"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        (
            core.get("remaining").and_then(|x| x.as_i64()).unwrap_or(-1),
            core.get("limit").and_then(|x| x.as_i64()).unwrap_or(-1),
        )
    }

    pub fn branch_exists(&self, repo: &str, branch: &str) -> bool {
        if branch.is_empty() {
            return false;
        }
        let url = match self.provider {
            Provider::Github => format!("/repos/{repo}/git/ref/heads/{branch}"),
            Provider::Gitea => format!("/repos/{repo}/branches/{branch}"),
        };
        match self.request(reqwest::Method::GET, &url).send() {
            Ok(r) => Self::check(r, "GET", &url).is_ok(),
            Err(_) => false,
        }
    }

    pub fn list_open_prs_touching(
        &self,
        repo: &str,
        paths: &[String],
        base: &str,
    ) -> Vec<Value> {
        if paths.is_empty() {
            return Vec::new();
        }
        let url = format!("/repos/{repo}/pulls");
        // `per_page` is GitHub's page-size key; `limit` is Gitea's. Sending both
        // is harmless — each side ignores the other's key.
        let mut req = self
            .request(reqwest::Method::GET, &url)
            .query(&[("state", "open"), ("per_page", "30"), ("limit", "30")]);
        if !base.is_empty() {
            req = req.query(&[("base", base)]);
        }
        let prs: Value = match req.send().and_then(|r| r.json()) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let prs = match prs.as_array() {
            Some(a) => a.clone(),
            None => return Vec::new(),
        };
        let target: std::collections::HashSet<&str> = paths.iter().map(|s| s.as_str()).collect();
        let mut out = Vec::new();
        for pr in prs {
            let Some(number) = pr.get("number").and_then(|v| v.as_i64()) else {
                continue;
            };
            let files_url = format!("/repos/{repo}/pulls/{number}/files");
            let files: Value = match self
                .request(reqwest::Method::GET, &files_url)
                .query(&[("per_page", "100"), ("limit", "100")])
                .send()
                .and_then(|r| r.json())
            {
                Ok(v) => v,
                Err(_) => continue,
            };
            let Some(arr) = files.as_array() else {
                continue;
            };
            if arr
                .iter()
                .any(|f| f.get("filename").and_then(|n| n.as_str()).is_some_and(|n| target.contains(n)))
            {
                out.push(pr);
            }
        }
        out
    }

    pub fn get_pull_request(&self, repo: &str, number: i64) -> Result<Value> {
        let url = format!("/repos/{repo}/pulls/{number}");
        let resp = Self::check(
            self.request(reqwest::Method::GET, &url).send()?,
            "GET",
            &url,
        )?;
        Ok(resp.json()?)
    }
}

/// Wrap an absolute path with the `\\?\` long-path prefix on Windows so it
/// bypasses the historical 260-char `MAX_PATH` limit. No-op elsewhere.
pub fn long_path(p: &Path) -> PathBuf {
    if !cfg!(windows) {
        return p.to_path_buf();
    }
    let s = p.to_string_lossy();
    if s.starts_with("\\\\?\\") {
        return p.to_path_buf();
    }
    // Long-path prefix only works with absolute paths.
    let abs = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let abs_s = abs.to_string_lossy();
    if abs_s.starts_with("\\\\?\\") {
        return abs.into();
    }
    PathBuf::from(format!("\\\\?\\{abs_s}"))
}

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
use parking_lot::Mutex;
use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, ETAG, IF_NONE_MATCH};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{create_dir_all, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const GITHUB_API: &str = "https://api.github.com";

/// Whole-request budget, body included. Kept generous because the same client
/// downloads plugin zipballs.
const REQUEST_TIMEOUT_SECS: u64 = 30;
/// Budget for establishing the TCP+TLS connection alone. Short on purpose: a
/// VPN-gated Gitea host that black-holes packets otherwise parks a thread for
/// the full request timeout on *every* call of a refresh.
const CONNECT_TIMEOUT_SECS: u64 = 6;

/// Reuse one `reqwest::blocking::Client` per (provider, host, TLS mode, token).
///
/// Building a blocking client is not cheap: each one **spawns its own OS thread
/// running a private tokio runtime**, and starts with an empty connection pool
/// so every request re-does the TLS handshake. `refresh_all` built one per
/// marketplace (twice over) and `reconcile_open_prs` one per open PR, turning a
/// refresh into a burst of thread spawns and full handshakes. `Client` is
/// `Arc`-based internally, so handing out clones is free.
static CLIENT_POOL: OnceLock<Mutex<HashMap<String, Client>>> = OnceLock::new();
/// Cap on distinct pooled clients. The pool only grows when the token or the set
/// of registered hosts changes; the cap just bounds a pathological case.
const MAX_POOLED_CLIENTS: usize = 8;

/// Per-host read-path health, the circuit breaker behind [`GitHubClient::guard`].
///
/// A refresh sweep issues hundreds of reads: a registry per marketplace, a
/// manifest probe and a git tree per plugin. When the host is simply not
/// reachable — the VPN down for the Gitea instance, the laptop resumed with no
/// network for GitHub — every one of those paid the full connect (and often the
/// full request) timeout, in sequence. Measured on a shipped log: one sweep
/// spent **fifteen minutes** failing four reads and never finished. The UI's
/// refresh spinner has no other end condition than that sweep returning, so it
/// simply span.
///
/// So the first failures teach the rest of the sweep: after
/// [`FAILURES_BEFORE_TRIP`] consecutive transport errors a host is written off
/// for [`TRIP_COOLDOWN_SECS`], and reads against it fail immediately without
/// touching the network. Two properties keep this safe: it guards **reads**
/// only — a user-initiated write always goes out and reports its real error —
/// and a short-circuited read is still a *failed* read, so "a failed remote
/// read is never an empty one" holds: `remote_ok` stays false and the local
/// view is kept.
struct HostHealth {
    consecutive_failures: u32,
    /// Set when the breaker trips: no read is attempted before this instant.
    blocked_until: Option<Instant>,
    /// Why it tripped, for the message the short-circuited reads carry.
    reason: String,
}

static HOST_HEALTH: OnceLock<Mutex<HashMap<String, HostHealth>>> = OnceLock::new();
/// Consecutive transport failures before a host's reads are short-circuited.
/// Two rather than one: a single dropped connection is normal.
const FAILURES_BEFORE_TRIP: u32 = 2;
/// How long a written-off host stays short-circuited. Long enough to save a
/// whole sweep, short enough that reconnecting the VPN shows up on the next one.
const TRIP_COOLDOWN_SECS: u64 = 90;

fn host_health() -> &'static Mutex<HashMap<String, HostHealth>> {
    HOST_HEALTH.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forget every host's failure tally.
///
/// Called when the user explicitly asks for a refresh, so "reconnect the VPN,
/// press Rafraîchir" works there and then instead of waiting out the cooldown.
pub fn reset_host_health() {
    host_health().lock().clear();
}

/// One cached conditional-GET response.
#[derive(Clone)]
struct CachedGet {
    etag: String,
    body: Value,
}

/// ETag cache for read-only JSON endpoints, keyed by (host, token, path+query).
///
/// This never skips the request — it only lets the server answer `304 Not
/// Modified` with an empty body, so the response can never be stale. It saves
/// the JSON transfer and parse on the N+1 reads a refresh performs, and on
/// GitHub a 304 does not count against the rate limit.
static GET_CACHE: OnceLock<Mutex<HashMap<String, CachedGet>>> = OnceLock::new();
/// Cap on cached responses; blown wholesale rather than evicted by age, which is
/// plenty for a cache whose only job is to survive one refresh cycle.
const MAX_CACHED_GETS: usize = 512;

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

/// True when any `/`-separated segment of `path` starts with a dot
/// (`.claude-plugin/marketplace.json` → true, `marketplace.json` → false).
///
/// Some self-hosted Gitea instances sit behind a reverse proxy / WAF with an
/// anti-dotfile rule (e.g. nginx `location ~ /\. { deny all; }`) that returns a
/// 403 HTML page for any URL containing a `/.` segment — before the request
/// even reaches Gitea. We detect such paths and route their reads/writes
/// through dot-free endpoints (Trees+Blobs / ChangeFiles).
fn path_has_dot_segment(path: &str) -> bool {
    path.split('/').any(|seg| seg.starts_with('.'))
}

/// Minimal shell-style glob match supporting `*` (any run, incl. empty) and
/// `?` (one char), anchored over the whole string. Used to test a Gitea
/// branch-protection rule pattern (e.g. `release/*`) against a branch name.
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    // Backtracking position of the last `*` and where it started matching.
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
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

/// One entry of a recursive git tree listing (see [`GitHubClient::list_tree`]).
/// `sha` on a `blob` is the git object id — `sha1("blob <len>\0" + bytes)` — so
/// it can be recomputed locally and compared without fetching the file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeEntry {
    #[serde(default)]
    pub path: String,
    /// "blob" | "tree" | "commit" (submodule)
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub sha: String,
    /// Git file mode as the forge reports it: `100644`, `100755` (executable),
    /// `120000` (symlink), `040000` (tree), `160000` (submodule). Carried so a
    /// tree can be *rebuilt* elsewhere without flattening every file to 100644 —
    /// dropping it silently strips the executable bit off checked-in scripts.
    #[serde(default)]
    pub mode: String,
}

/// `#[serde(default)]` only covers an **absent** key; a key that is present and
/// explicitly `null` still fails to deserialize. Both forges return `null` for
/// an empty repository description, so every nullable field needs this rather
/// than a plain `default`.
fn null_to_default<'de, D, T>(d: D) -> std::result::Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// One repository as an org listing reports it.
///
/// Field names are the forges' own (`default_branch`, not `defaultBranch`):
/// this is deserialised *from* the API, so the usual `camelCase` rename that
/// serves the Rust → TS boundary would silently leave every renamed field at
/// its default.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgRepo {
    pub name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub description: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub default_branch: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub private: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    pub empty: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    pub archived: bool,
}

/// Authorship of a commit, as both forges spell it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CommitAuthor {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    /// ISO-8601. Passed straight back when replaying so the original date
    /// survives; an empty string means "let the forge stamp it".
    #[serde(default)]
    pub date: String,
}

/// One commit from a `/repos/{repo}/commits` listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitInfo {
    pub sha: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub author: CommitAuthor,
    #[serde(default)]
    pub committer: CommitAuthor,
}

/// One file operation in a batch — see [`GitHubClient::apply_file_ops`].
///
/// Content and path are borrowed — the caller already holds the bytes (a PR's
/// worth of skill files is megabytes) and cloning them just to base64 them a
/// moment later would double that for nothing. The sha is owned: it is 40
/// bytes, and it may come from a lookup the caller performs while building the
/// list, which borrowing would forbid.
#[derive(Debug)]
pub enum FileOp<'a> {
    /// Create when `existing_sha` is `None`, update otherwise. Gitea rejects an
    /// `update` without the current sha, and a `create` on a path that exists.
    Write {
        path: &'a str,
        content: &'a [u8],
        existing_sha: Option<String>,
    },
    Delete {
        path: &'a str,
        sha: String,
    },
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

        let pool_key = format!("{provider:?}|{api_base}|{insecure_tls}|{token}");
        let pool = CLIENT_POOL.get_or_init(|| Mutex::new(HashMap::new()));
        let client = {
            let mut map = pool.lock();
            match map.get(&pool_key) {
                Some(c) => c.clone(),
                None => {
                    let mut builder = Client::builder()
                        .default_headers(headers)
                        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
                        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS));
                    if insecure_tls {
                        builder = builder.danger_accept_invalid_certs(true);
                    }
                    let c = builder.build()?;
                    if map.len() >= MAX_POOLED_CLIENTS {
                        map.clear();
                    }
                    map.insert(pool_key, c.clone());
                    c
                }
            }
        };
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

    /// How this client names itself in a user-facing error.
    ///
    /// `GitHub`, or `Gitea (git.example.com)`. The host matters for Gitea: more
    /// than one instance can be registered, and "which one is down" is the
    /// whole content of the message.
    pub fn forge_label(&self) -> String {
        match self.provider {
            Provider::Github => "GitHub".to_string(),
            Provider::Gitea => format!("Gitea ({})", self.host()),
        }
    }

    /// Build an [`Error::Forge`] already labelled with the forge that produced
    /// it. Every failure raised from this client goes through here, so a Gitea
    /// problem can no longer reach the UI wearing GitHub's name.
    pub fn forge_err(&self, detail: impl std::fmt::Display) -> Error {
        Error::Forge(format!("{}: {detail}", self.forge_label()))
    }

    /// Refuse the call when this client's host is currently written off.
    ///
    /// Read paths only — see [`HostHealth`]. `Ok(())` when the host is healthy
    /// or its cooldown has lapsed.
    fn guard(&self) -> Result<()> {
        let host = self.host();
        let mut map = host_health().lock();
        let Some(h) = map.get_mut(&host) else {
            return Ok(());
        };
        match h.blocked_until {
            Some(t) if Instant::now() < t => Err(Error::Unreachable(format!(
                "{} injoignable — {} (nouvel essai dans {} s)",
                self.forge_label(),
                h.reason,
                (t - Instant::now()).as_secs()
            ))),
            Some(_) => {
                // Cooldown lapsed: give the host another chance, clean slate.
                h.blocked_until = None;
                h.consecutive_failures = 0;
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// Record that a read against this host succeeded, clearing its tally.
    fn note_reachable(&self) {
        let host = self.host();
        let mut map = host_health().lock();
        if let Some(h) = map.get_mut(&host) {
            h.consecutive_failures = 0;
            h.blocked_until = None;
        }
    }

    /// Record a transport failure; trip the breaker once they pile up.
    fn note_transport_failure(&self, detail: &str) {
        let host = self.host();
        let mut map = host_health().lock();
        let h = map.entry(host.clone()).or_insert(HostHealth {
            consecutive_failures: 0,
            blocked_until: None,
            reason: String::new(),
        });
        h.consecutive_failures += 1;
        if h.consecutive_failures >= FAILURES_BEFORE_TRIP && h.blocked_until.is_none() {
            h.blocked_until = Some(Instant::now() + Duration::from_secs(TRIP_COOLDOWN_SECS));
            h.reason = detail.to_string();
            tracing::warn!(
                "{host}: {} consecutive transport failures - pausing reads for {}s ({detail})",
                h.consecutive_failures,
                TRIP_COOLDOWN_SECS
            );
        }
    }

    /// Trip the breaker outright, because the forge itself said to back off
    /// (`x-ratelimit-remaining: 0`, or a `retry-after`). Hammering a spent quota
    /// only buys 403s, and each one still costs a round trip.
    fn note_rate_limited(&self, secs: u64, detail: &str) {
        let host = self.host();
        let mut map = host_health().lock();
        let h = map.entry(host.clone()).or_insert(HostHealth {
            consecutive_failures: 0,
            blocked_until: None,
            reason: String::new(),
        });
        h.blocked_until = Some(Instant::now() + Duration::from_secs(secs));
        h.reason = detail.to_string();
        tracing::warn!("{host}: rate limited - pausing reads for {secs}s ({detail})");
    }

    /// Send a **read** request through the circuit breaker.
    ///
    /// Checks the host is not written off, then turns a transport failure into a
    /// tally entry on the way out. Writes deliberately do not come through here:
    /// a PR the user just asked for must always be attempted, and must report
    /// the forge's own error.
    fn send_read(
        &self,
        req: reqwest::blocking::RequestBuilder,
        what: &str,
    ) -> Result<Response> {
        self.guard()?;
        match req.send() {
            Ok(r) => {
                self.note_reachable();
                if let Some(secs) = Self::rate_limit_backoff(&r) {
                    self.note_rate_limited(secs, "quota d'API épuisé");
                }
                Ok(r)
            }
            Err(e) => {
                let detail = crate::error::chain(&e);
                self.note_transport_failure(&detail);
                // No status to report — `check` never sees this one, so the
                // call log would otherwise show only the requests that worked.
                self.trace_call("GET", what, 0, &detail);
                tracing::debug!("{what}: {detail}");
                Err(Error::Http(e))
            }
        }
    }

    /// How long to back off when a response says the quota is spent, else
    /// `None`. Reads GitHub's `x-ratelimit-remaining` / `x-ratelimit-reset` and
    /// the `retry-after` either forge may send.
    fn rate_limit_backoff(resp: &Response) -> Option<u64> {
        let status = resp.status().as_u16();
        if status != 403 && status != 429 {
            return None;
        }
        let h = resp.headers();
        if let Some(retry) = h
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
        {
            return Some(retry.clamp(30, 3600));
        }
        let remaining = h
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<i64>().ok());
        if remaining == Some(0) {
            // `x-ratelimit-reset` is an epoch second; fall back to a flat pause
            // when it is missing or already in the past.
            let secs = h
                .get("x-ratelimit-reset")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<i64>().ok())
                .and_then(|reset| {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .ok()?
                        .as_secs() as i64;
                    if reset > now {
                        Some((reset - now) as u64)
                    } else {
                        None
                    }
                })
                .unwrap_or(300);
            return Some(secs.clamp(30, 3600));
        }
        None
    }

    fn request(&self, method: reqwest::Method, url: &str) -> reqwest::blocking::RequestBuilder {
        self.client.request(method, self.absolute(url))
    }

    /// A path against this client's API base, or an already-absolute URL left
    /// alone. Shared by `request` and the call log, so both name the same thing.
    fn absolute(&self, url: &str) -> String {
        if url.starts_with("http") {
            url.to_string()
        } else {
            format!("{}{url}", self.api_base)
        }
    }

    /// One line per forge round trip, under the `api` target.
    ///
    /// A dedicated target rather than a message prefix: the Logs page's "Appels
    /// API" tab selects on it, and a message convention would be one careless
    /// edit away from being wrong. `logger::level_filter` names `api`
    /// explicitly — without that, none of this would reach the file.
    ///
    /// `status` is the HTTP status, or `0` when the request never got an answer
    /// (transport failure, or a host the circuit breaker has written off).
    fn trace_call(&self, method: &str, url: &str, status: u16, note: &str) {
        let outcome = if status == 0 {
            "failed".to_string()
        } else {
            status.to_string()
        };
        if note.is_empty() {
            tracing::info!(target: "api", "{method} {} -> {outcome}", self.absolute(url));
        } else {
            tracing::info!(target: "api", "{method} {} -> {outcome} ({note})", self.absolute(url));
        }
    }

    /// `GET` a JSON endpoint through the ETag cache.
    ///
    /// Sends `If-None-Match` when a previous response for the same
    /// (host, token, path, query) carried an `ETag`; on `304` the cached body is
    /// returned without transferring or re-parsing it. A forge that emits no
    /// `ETag` simply never populates the cache, so this degrades to a plain GET.
    ///
    /// Read-only endpoints only — the response is served from cache exclusively
    /// when the server itself confirmed nothing changed, so writes elsewhere in
    /// the app can never make it stale.
    fn get_json_cached(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        let mut key = String::with_capacity(path.len() + 96);
        key.push_str(&self.api_base);
        key.push('|');
        key.push_str(&self.token);
        key.push('|');
        key.push_str(path);
        for (k, v) in query {
            key.push('|');
            key.push_str(k);
            key.push('=');
            key.push_str(v);
        }

        let cache = GET_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let cached = cache.lock().get(&key).cloned();

        let mut req = self.request(reqwest::Method::GET, path);
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(c) = &cached {
            if let Ok(hv) = HeaderValue::from_str(&c.etag) {
                req = req.header(IF_NONE_MATCH, hv);
            }
        }
        let resp = self.send_read(req, path)?;

        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            // Only reachable when we sent `If-None-Match`, i.e. `cached` is Some.
            if let Some(c) = cached {
                // Logged like any other call: a 304 is a round trip that spent
                // quota and time, and a tab counting API calls that silently
                // dropped them would under-report exactly the ones the ETag
                // cache exists to make cheap.
                self.trace_call("GET", path, 304, "ETag cache");
                return Ok(c.body);
            }
        }

        let resp = self.check(resp, "GET", path)?;
        let etag = resp
            .headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let body: Value = resp.json()?;
        if let Some(etag) = etag {
            let mut m = cache.lock();
            if m.len() >= MAX_CACHED_GETS {
                m.clear();
            }
            m.insert(
                key,
                CachedGet {
                    etag,
                    body: body.clone(),
                },
            );
        }
        Ok(body)
    }

    /// Turn a non-2xx response into an `Err`, extracting the forge's `message`
    /// field when there is one.
    ///
    /// `404` gets [`Error::NotFound`] rather than [`Error::GitHub`], so callers
    /// can tell "this resource does not exist" from "the call failed". That
    /// distinction is load-bearing in `pr_poller`, which writes a tracked PR off
    /// only on a definite 404 and never on a transport error. It also stops the
    /// message reading `github: …` for a Gitea response — the variant name is
    /// shared by both providers and made 404s look like they had been sent to
    /// GitHub.
    fn check(&self, resp: Response, method: &str, url: &str) -> Result<Response> {
        let status = resp.status();
        // Every answered request funnels through here, reads and writes alike,
        // which makes it the one place that knows the method, the URL and the
        // status together. Hence the call log lives here rather than at each of
        // the twenty-odd `.send()` sites.
        self.trace_call(method, url, status.as_u16(), "");
        if status.is_client_error() || status.is_server_error() {
            let text = resp.text().unwrap_or_default();
            let parsed = serde_json::from_str::<Value>(&text).ok();
            let mut msg = parsed
                .as_ref()
                .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
                .unwrap_or_else(|| text.clone());
            // GitHub keeps `message` generic ("Repository creation failed.") and
            // puts the actionable part in `errors[]`. Without it a 422 says
            // nothing a user or a log reader can act on.
            let details: Vec<String> = parsed
                .as_ref()
                .and_then(|v| v.get("errors").and_then(|e| e.as_array()))
                .map(|arr| {
                    arr.iter()
                        .filter_map(|e| {
                            e.get("message")
                                .and_then(|m| m.as_str())
                                .or_else(|| e.get("code").and_then(|c| c.as_str()))
                                .or_else(|| e.as_str())
                                .map(String::from)
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !details.is_empty() {
                msg = format!("{msg} [{}]", details.join(" ; "));
            }
            // The label comes from the client that made the call, never from a
            // hard-coded prefix: the same `GitHubClient` type serves GitHub and
            // every registered Gitea instance, so a fixed "github:" turned every
            // Gitea 401/403/5xx into a GitHub error — shown to the user under a
            // Gitea heading, telling them to fix the wrong token.
            let detail = format!("{}: {method} {url} -> {status}: {msg}", self.forge_label());
            return Err(if status == reqwest::StatusCode::NOT_FOUND {
                Error::NotFound(detail)
            } else {
                Error::Forge(detail)
            });
        }
        Ok(resp)
    }

    // ---------- read ----------
    pub fn get_repo(&self, repo: &str) -> Result<Value> {
        self.get_json_cached(&format!("/repos/{repo}"), &[])
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
        let query: Vec<(&str, &str)> = if r#ref.is_empty() {
            Vec::new()
        } else {
            vec![("ref", r#ref)]
        };
        let value: Value = self.get_json_cached(&url, &query)?;
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

    /// The repo's **entire** file list at `r#ref`, in one request, with each
    /// blob's git SHA — `/repos/{repo}/git/trees/{commit}?recursive=true`.
    ///
    /// This is what makes an exact local-vs-remote comparison affordable: a git
    /// blob SHA is `sha1("blob <len>\0" + bytes)`, computable locally, so a whole
    /// skill folder can be diffed against the remote without downloading a single
    /// file. Walking the Contents API instead costs one request per directory.
    ///
    /// Routed through [`get_json_cached`], so repeated calls on an unchanged repo
    /// come back as `304`s.
    ///
    /// Returns the resolved commit SHA alongside the entries. Callers that also
    /// need to know where the ref points — "did this repo move since we
    /// installed it?" — take it from here instead of resolving the ref a second
    /// time, which saves a request per plugin and guarantees both answers
    /// describe the same commit.
    ///
    /// Errors with [`Error::GitHub`] when the forge reports the tree `truncated`:
    /// a partial listing would read as "these files do not exist remotely", which
    /// is exactly the wrong answer. Callers fall back to the Contents API.
    pub fn list_tree(&self, repo: &str, r#ref: &str) -> Result<(String, Vec<TreeEntry>)> {
        let commit = self.get_latest_commit(repo, r#ref)?;
        let commit_sha = commit
            .get("sha")
            .and_then(|v| v.as_str())
            .ok_or_else(|| self.forge_err(format!("no commit sha for {repo}@{r}", r = r#ref)))?;
        Ok((commit_sha.to_string(), self.list_tree_at_commit(repo, commit_sha)?))
    }

    /// The tree of a commit whose SHA is already known.
    ///
    /// [`list_tree`](Self::list_tree) resolves a ref first; when the caller
    /// already holds a commit sha that resolution is a wasted round trip, and
    /// replaying a history pays it once per commit. Cached on the commit sha,
    /// which is immutable, so a re-read is a `304`.
    pub fn list_tree_at_commit(&self, repo: &str, commit_sha: &str) -> Result<Vec<TreeEntry>> {
        let url = format!("/repos/{repo}/git/trees/{commit_sha}");
        let tree: Value = self.get_json_cached(&url, &[("recursive", "true")])?;
        if tree
            .get("truncated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            return Err(self.forge_err(format!(
                "git tree for {repo}@{commit_sha} is truncated — repo too large"
            )));
        }
        let mut out = Vec::new();
        for e in tree.get("tree").and_then(|v| v.as_array()).into_iter().flatten() {
            let Some(o) = e.as_object() else { continue };
            out.push(TreeEntry {
                path: o
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                kind: o
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                sha: o
                    .get("sha")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                mode: o
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            });
        }
        Ok(out)
    }

    /// Every repository of an organisation, following pagination to the end.
    ///
    /// `per_page` (GitHub) and `limit` (Gitea) are both sent — the forge that
    /// does not know one ignores it, which keeps a single call site for the two
    /// providers, exactly as [`list_tags`](Self::list_tags) does.
    pub fn list_org_repos(&self, org: &str) -> Result<Vec<OrgRepo>> {
        const PAGE: usize = 50;
        let url = format!("/orgs/{org}/repos");
        let mut out: Vec<OrgRepo> = Vec::new();
        for page in 1..=40 {
            let page_s = page.to_string();
            let per = PAGE.to_string();
            let data = self.get_json_cached(
                &url,
                &[
                    ("per_page", per.as_str()),
                    ("limit", per.as_str()),
                    ("page", page_s.as_str()),
                ],
            )?;
            let Some(arr) = data.as_array() else { break };
            if arr.is_empty() {
                break;
            }
            let got = arr.len();
            for v in arr {
                // Never drop an entry we failed to read. A short listing reads
                // as "these repositories do not exist", and the remedy for a
                // missing repository is to create one — so a parse bug would
                // surface as an attempt to recreate repositories that are
                // already there. Same invariant as the truncated-tree guard in
                // `list_tree`: a failed read is not an empty one.
                let r = serde_json::from_value::<OrgRepo>(v.clone()).map_err(|e| {
                    self.forge_err(format!(
                        "GET {url}: entrée de listing illisible ({e}) — \
                         listing refusé plutôt que tronqué"
                    ))
                })?;
                out.push(r);
            }
            if got < PAGE {
                break;
            }
        }
        Ok(out)
    }

    /// Commits reachable from `branch`, newest first, one page at a time.
    ///
    /// Paged rather than exhaustive on purpose: the caller walks backwards only
    /// until it recognises its sync anchor, and a repo with years of history
    /// must not be pulled in full to answer "what changed since yesterday".
    pub fn list_commits(&self, repo: &str, branch: &str, page: usize, per_page: usize) -> Result<Vec<CommitInfo>> {
        let url = format!("/repos/{repo}/commits");
        let page_s = page.to_string();
        let per_s = per_page.to_string();
        let data = self.get_json_cached(
            &url,
            &[
                ("sha", branch),
                ("per_page", per_s.as_str()),
                ("limit", per_s.as_str()),
                ("page", page_s.as_str()),
                // Gitea attaches per-commit diffstats unless told not to, which
                // on a 50-commit page is a lot of payload for data no caller
                // here reads. GitHub ignores the parameter.
                ("stat", "false"),
                ("verification", "false"),
                ("files", "false"),
            ],
        )?;
        let mut out = Vec::new();
        for v in data.as_array().into_iter().flatten() {
            let Some(sha) = v.get("sha").and_then(|s| s.as_str()) else {
                continue;
            };
            let c = v.get("commit");
            let read_actor = |key: &str| -> CommitAuthor {
                c.and_then(|c| c.get(key))
                    .and_then(|a| serde_json::from_value::<CommitAuthor>(a.clone()).ok())
                    .unwrap_or_default()
            };
            out.push(CommitInfo {
                sha: sha.to_string(),
                message: c
                    .and_then(|c| c.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or_default()
                    .to_string(),
                author: read_actor("author"),
                committer: read_actor("committer"),
            });
        }
        Ok(out)
    }

    /// A blob's **raw bytes**, by git object id.
    ///
    /// Distinct from [`get_file`](Self::get_file), which returns a lossily
    /// decoded `String`: anything that is not valid UTF-8 comes back mangled
    /// there. Byte-exact copying needs the bytes themselves, so this is what the
    /// org sync reads with. Not routed through the ETag cache — blobs are
    /// content-addressed (a given sha can never change) and they are the bulk of
    /// the traffic, so caching them would only grow the process's memory.
    pub fn get_blob_bytes(&self, repo: &str, blob_sha: &str) -> Result<Vec<u8>> {
        let url = format!("/repos/{repo}/git/blobs/{blob_sha}");
        let resp = self.check(
            self.send_read(self.request(reqwest::Method::GET, &url), &url)?,
            "GET",
            &url,
        )?;
        let data: Value = resp.json()?;
        let content = data.get("content").and_then(|v| v.as_str()).unwrap_or_default();
        match data.get("encoding").and_then(|v| v.as_str()).unwrap_or("base64") {
            "base64" => {
                let cleaned: String = content.chars().filter(|c| !c.is_whitespace()).collect();
                B64.decode(cleaned)
                    .map_err(|e| self.forge_err(format!("blob {blob_sha} in {repo}: {e}")))
            }
            _ => Ok(content.as_bytes().to_vec()),
        }
    }

    pub fn get_file(&self, repo: &str, path: &str, r#ref: &str) -> Result<(String, String)> {
        // Proxy-blocked dot-paths on Gitea: read via Trees+Blobs (dot-free URL).
        // See [`path_has_dot_segment`].
        if self.provider == Provider::Gitea && path_has_dot_segment(path) {
            return self.gitea_blob_get(repo, path, r#ref);
        }
        let url = format!("/repos/{repo}/contents/{path}");
        let query: Vec<(&str, &str)> = if r#ref.is_empty() {
            Vec::new()
        } else {
            vec![("ref", r#ref)]
        };
        let data: Value = self.get_json_cached(&url, &query)?;
        if data.is_array() {
            return Err(self.forge_err(format!("{path} is a directory")));
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

    /// Gitea: read a file via the Git Trees + Blobs API so the file path never
    /// appears in the request URL — only commit/blob SHAs do. This bypasses a
    /// reverse-proxy rule that blocks `/.`-segment URLs (see
    /// [`path_has_dot_segment`]). Returns `(text, blob_sha)` like [`get_file`],
    /// so the blob sha can be reused as the `existing_sha` for a later update.
    fn gitea_blob_get(&self, repo: &str, path: &str, r#ref: &str) -> Result<(String, String)> {
        // A truncated tree surfaces as `Error::GitHub` from `list_tree`, which is
        // right here too: we cannot claim the file is absent from a listing we
        // know is incomplete.
        let blob_sha = self
            .list_tree(repo, r#ref)?
            .1
            .into_iter()
            .find(|e| e.kind == "blob" && e.path == path)
            .map(|e| e.sha)
            .ok_or_else(|| Error::NotFound(format!("{path} not found in {repo}@{r}", r = r#ref)))?;
        let blob_url = format!("/repos/{repo}/git/blobs/{blob_sha}");
        let resp = self.check(
            self.send_read(self.request(reqwest::Method::GET, &blob_url), &blob_url)?,
            "GET",
            &blob_url,
        )?;
        let data: Value = resp.json()?;
        let content = data.get("content").and_then(|v| v.as_str()).unwrap_or_default();
        let encoding = data.get("encoding").and_then(|v| v.as_str()).unwrap_or("base64");
        let text = if encoding == "base64" {
            let cleaned: String = content.chars().filter(|c| !c.is_whitespace()).collect();
            let raw = B64.decode(cleaned).unwrap_or_default();
            String::from_utf8_lossy(&raw).into_owned()
        } else {
            content.to_string()
        };
        Ok((text, blob_sha))
    }

    /// Gitea: create/update/delete files via `POST /repos/{repo}/contents`
    /// (the "ChangeFiles" batch endpoint). File paths travel in the JSON body,
    /// so the URL stays dot-free and a proxy blocking `/.`-paths lets it
    /// through — unlike the per-file `PUT/DELETE /contents/<path>`.
    fn gitea_change_files(
        &self,
        repo: &str,
        branch: &str,
        message: &str,
        files: Vec<Value>,
    ) -> Result<Value> {
        let url = format!("/repos/{repo}/contents");
        let body = json!({
            "branch": branch,
            "message": message,
            "files": files,
        });
        let resp = self.check(
            self.request(reqwest::Method::POST, &url).json(&body).send()?,
            "POST",
            &url,
        )?;
        Ok(resp.json()?)
    }

    /// Conservative ceiling on one ChangeFiles body.
    ///
    /// Gitea itself accepts far more, but these instances sit behind a reverse
    /// proxy and nginx's `client_max_body_size` defaults to **1 MB**, answering
    /// 413 above it. We cannot read the proxy's config, so we stay well under
    /// the common default and let [`gitea_apply_chunk`] split further if a 413
    /// comes back anyway.
    const BATCH_BODY_BUDGET: usize = 384 * 1024;

    /// Cap on operations per batch, independent of size — a guard against a
    /// forge that limits the array length rather than the body.
    const BATCH_MAX_OPS: usize = 40;

    /// Rough encoded cost of one operation: base64 inflates by 4/3, plus the
    /// JSON scaffolding (keys, quotes, the path, the sha).
    fn op_cost(op: &FileOp<'_>) -> usize {
        match op {
            FileOp::Write { path, content, .. } => (content.len() * 4) / 3 + path.len() + 160,
            FileOp::Delete { path, .. } => path.len() + 160,
        }
    }

    fn op_json(op: &FileOp<'_>) -> Value {
        match op {
            FileOp::Write {
                path,
                content,
                existing_sha,
            } => {
                let mut f = json!({
                    "operation": if existing_sha.is_some() { "update" } else { "create" },
                    "path": path,
                    "content": B64.encode(content),
                });
                if let Some(sha) = existing_sha {
                    f["sha"] = json!(sha);
                }
                f
            }
            FileOp::Delete { path, sha } => json!({
                "operation": "delete",
                "path": path,
                "sha": sha,
            }),
        }
    }

    /// Pull `(path, new sha)` out of whichever response shape came back —
    /// ChangeFiles answers with a `files` array, the single-file Contents API
    /// with one `content` object.
    fn collect_written_shas(resp: &Value, out: &mut Vec<(String, String)>) {
        let take = |v: &Value, out: &mut Vec<(String, String)>| {
            if let (Some(p), Some(s)) = (
                v.get("path").and_then(|x| x.as_str()),
                v.get("sha").and_then(|x| x.as_str()),
            ) {
                out.push((p.to_string(), s.to_string()));
            }
        };
        if let Some(files) = resp.get("files").and_then(|f| f.as_array()) {
            for f in files {
                take(f, out);
            }
        } else if let Some(c) = resp.get("content") {
            take(c, out);
        }
    }

    /// Send one ChangeFiles batch, splitting on 413 rather than giving up.
    ///
    /// A 413 is refused by the proxy before Gitea ever sees the body, so
    /// nothing was applied and re-sending the halves is safe. A batch that
    /// reaches Gitea is one commit: it applies whole or not at all.
    fn gitea_apply_chunk(
        &self,
        repo: &str,
        branch: &str,
        message: &str,
        ops: &[FileOp<'_>],
        out: &mut Vec<(String, String)>,
    ) -> Result<()> {
        if ops.is_empty() {
            return Ok(());
        }
        let url = format!("/repos/{repo}/contents");
        let body = json!({
            "branch": branch,
            "message": message,
            "files": ops.iter().map(Self::op_json).collect::<Vec<_>>(),
        });
        let resp = self
            .request(reqwest::Method::POST, &url)
            .json(&body)
            .send()?;

        if resp.status() == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
            if ops.len() == 1 {
                // One operation is already over the ceiling. The per-file
                // endpoint has a body this batch does not (no array scaffolding)
                // and is the path that worked before batching existed.
                tracing::warn!(
                    "gitea batch: 413 on a single op ({}), falling back to per-file write",
                    match &ops[0] {
                        FileOp::Write { path, .. } | FileOp::Delete { path, .. } => path,
                    }
                );
                let single = match &ops[0] {
                    FileOp::Write {
                        path,
                        content,
                        existing_sha,
                    } => self.put_file(
                        repo,
                        branch,
                        path,
                        content,
                        message,
                        existing_sha.as_deref(),
                    )?,
                    FileOp::Delete { path, sha } => {
                        self.delete_file(repo, branch, path, message, sha)?
                    }
                };
                Self::collect_written_shas(&single, out);
                return Ok(());
            }
            let mid = ops.len() / 2;
            tracing::warn!(
                "gitea batch: 413 for {} ops, splitting into {} + {}",
                ops.len(),
                mid,
                ops.len() - mid
            );
            self.gitea_apply_chunk(repo, branch, message, &ops[..mid], out)?;
            self.gitea_apply_chunk(repo, branch, message, &ops[mid..], out)?;
            return Ok(());
        }

        let resp = self.check(resp, "POST", &url)?;
        let v: Value = resp.json()?;
        Self::collect_written_shas(&v, out);
        Ok(())
    }

    /// Apply many file operations in as few requests as the forge allows.
    ///
    /// **Gitea** batches through ChangeFiles (`POST /repos/{repo}/contents`),
    /// which takes an array of operations and produces one commit per call — so
    /// a 91-file PR costs a handful of requests instead of 91. The path travels
    /// in the body, which also means this subsumes the `path_has_dot_segment`
    /// workaround for free.
    ///
    /// **GitHub** has no equivalent endpoint (the Git Data API would be a
    /// different write model entirely), so it keeps the per-file loop.
    ///
    /// Returns `(path, new blob sha)` for every operation the forge reported
    /// back, so the caller can keep its sha map current.
    pub fn apply_file_ops(
        &self,
        repo: &str,
        branch: &str,
        ops: &[FileOp<'_>],
        message: &str,
    ) -> Result<Vec<(String, String)>> {
        let mut out = Vec::with_capacity(ops.len());
        if ops.is_empty() {
            return Ok(out);
        }
        if self.provider != Provider::Gitea {
            for op in ops {
                let resp = match op {
                    FileOp::Write {
                        path,
                        content,
                        existing_sha,
                    } => self.put_file(
                        repo,
                        branch,
                        path,
                        content,
                        message,
                        existing_sha.as_deref(),
                    )?,
                    FileOp::Delete { path, sha } => {
                        self.delete_file(repo, branch, path, message, sha)?
                    }
                };
                Self::collect_written_shas(&resp, &mut out);
            }
            return Ok(out);
        }

        let mut start = 0;
        let mut batches = 0;
        while start < ops.len() {
            let mut end = start;
            let mut size = 0;
            while end < ops.len() {
                let cost = Self::op_cost(&ops[end]);
                // Always take at least one, however big it is — the 413 split in
                // `gitea_apply_chunk` is what handles an oversized single op.
                if end > start
                    && (size + cost > Self::BATCH_BODY_BUDGET
                        || end - start >= Self::BATCH_MAX_OPS)
                {
                    break;
                }
                size += cost;
                end += 1;
            }
            self.gitea_apply_chunk(repo, branch, message, &ops[start..end], &mut out)?;
            batches += 1;
            start = end;
        }
        tracing::info!(
            "gitea batch: {} file op(s) applied to {repo}@{branch} in {} request(s)",
            ops.len(),
            batches
        );
        Ok(out)
    }

    /// List a repo's git tag names (newest API page first). GitHub and Gitea
    /// share `GET /repos/{repo}/tags`, each element carrying a top-level
    /// `name`. `per_page`/`limit` cover both page-size keys; one page (100) is
    /// plenty for picking the latest release tag.
    pub fn list_tags(&self, repo: &str) -> Result<Vec<String>> {
        let url = format!("/repos/{repo}/tags");
        let resp = self.check(
            self.send_read(
                self.request(reqwest::Method::GET, &url)
                    .query(&[("per_page", "100"), ("limit", "100")]),
                &url,
            )?,
            "GET",
            &url,
        )?;
        let v: Value = resp.json()?;
        Ok(v.as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default())
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
                self.get_json_cached(&url, &[])
            }
            Provider::Gitea => {
                // Gitea has no single-commit-by-ref endpoint; list with sha=ref
                // and take the head. Each element carries a top-level `sha`.
                let url = format!("/repos/{repo}/commits");
                let v: Value = self.get_json_cached(
                    &url,
                    &[("sha", branch.as_str()), ("limit", "1"), ("stat", "false")],
                )?;
                v.as_array()
                    .and_then(|a| a.first())
                    .cloned()
                    .ok_or_else(|| self.forge_err(format!("no commits for {repo}@{branch}")))
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
        let resp = self.send_read(
            self.client.get(&url).timeout(Duration::from_secs(120)),
            &url,
        )?;
        let status = resp.status();
        if status.is_client_error() || status.is_server_error() {
            return Err(Error::Forge(self.zipball_error_message(
                repo,
                &r#ref,
                status.as_u16(),
            )));
        }
        Ok(resp.bytes()?.to_vec())
    }

    fn zipball_error_message(&self, repo: &str, r#ref: &str, status: u16) -> String {
        let forge = self.forge_label();
        if status != 404 {
            return format!("{forge}: zipball {repo}@{} -> {status}", r#ref);
        }
        // Which credential to check depends on the forge, and saying the wrong
        // one sends the user to the wrong settings page. A Gitea 404 on a repo
        // that exists is almost always a missing token or a dropped VPN.
        let token_hint = match self.provider {
            Provider::Github => {
                "vérifiez que votre token GitHub y a accès (Paramètres → Connexions)".to_string()
            }
            Provider::Gitea => format!(
                "vérifiez votre token Gitea pour {} et que le VPN est actif (Paramètres → Connexions → Gitea)",
                self.host()
            ),
        };
        let repo_ok = self.get_repo(repo).is_ok();
        if !repo_ok {
            return format!(
                "{forge}: dépôt {repo} inaccessible (404).\n\nVérifiez l'orthographe owner/repo, \
                 ou — s'il est privé — {token_hint}."
            );
        }
        format!(
            "{forge}: zipball {repo}@{r} -> 404\n\nLe dépôt {repo} existe, mais il n'a ni tag, \
             ni branche, ni commit nommé '{r}'.\n\nCréez un tag git correspondant \
             (par ex. `git tag {r} && git push origin {r}`), ou corrigez l'entrée marketplace.json.",
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
                    Ok(r) => self.check(r, "GET", &url).is_ok(),
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
                    Ok(r) => match self.check(r, "GET", &url) {
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
                let resp = self.check(
                    self.request(reqwest::Method::GET, &url).send()?,
                    "GET",
                    &url,
                )?;
                let v: Value = resp.json()?;
                Ok(v["object"]["sha"].as_str().unwrap_or_default().to_string())
            }
            Provider::Gitea => {
                let url = format!("/repos/{repo}/branches/{branch}");
                let resp = self.check(
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
        let resp = self.check(
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
            if let Ok(r) = self.check(
                self.request(reqwest::Method::GET, &existing_url).send()?,
                "GET",
                &existing_url,
            ) {
                return Ok(r.json()?);
            }
        }
        let text = resp.text().unwrap_or_default();
        Err(self.forge_err(format!("POST {url} -> {status}: {text}")))
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
                        return Err(self.forge_err(format!("POST {url} -> {status}: {text}")));
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
                        return Err(self.forge_err(format!("POST {url} -> {status}: {text}")));
                    }
                }
                // The caller (submit_changes) discards this; resolve lazily only
                // when needed elsewhere. Returning the new branch's SHA keeps the
                // signature meaningful.
                self.get_branch_sha(repo, new_branch).or_else(|_| Ok(String::new()))
            }
        }
    }

    /// Create a repository inside an organisation.
    ///
    /// `auto_init` is deliberately false: the caller pushes a history of its
    /// own, and an auto-created README would be an unrelated root commit that
    /// every later push would have to reconcile with.
    pub fn create_org_repo(
        &self,
        org: &str,
        name: &str,
        description: &str,
        private: bool,
    ) -> Result<Value> {
        let url = format!("/orgs/{org}/repos");
        let body = json!({
            "name": name,
            "description": description,
            "private": private,
            "auto_init": false,
        });
        let resp = self.check(
            self.request(reqwest::Method::POST, &url).json(&body).send()?,
            "POST",
            &url,
        )?;
        Ok(resp.json()?)
    }

    /// Guard for the Git Data write endpoints below: Gitea exposes them for
    /// reading but not for creating objects, so a mistaken call should say so
    /// rather than fail as an opaque 404.
    fn require_github(&self, what: &str) -> Result<()> {
        if self.provider != Provider::Github {
            return Err(Error::Invalid(format!(
                "{what} is a GitHub Git Data API operation; this client targets {:?}",
                self.provider
            )));
        }
        Ok(())
    }

    /// Upload raw bytes as a git blob, returning its object id. GitHub only.
    pub fn create_blob(&self, repo: &str, content: &[u8]) -> Result<String> {
        self.require_github("create_blob")?;
        let url = format!("/repos/{repo}/git/blobs");
        let body = json!({ "content": B64.encode(content), "encoding": "base64" });
        let resp = self.check(
            self.request(reqwest::Method::POST, &url).json(&body).send()?,
            "POST",
            &url,
        )?;
        let data: Value = resp.json()?;
        data.get("sha")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| self.forge_err(format!("no sha returned by POST {url}")))
    }

    /// Build a git tree from a **complete** entry list, returning its object id.
    ///
    /// No `base_tree` is sent: the entries given are the whole tree. That is
    /// what makes deletions and renames fall out for free — a path simply absent
    /// from the list is absent from the result, with no delete marker to emit.
    /// GitHub only.
    pub fn create_tree(&self, repo: &str, entries: &[TreeEntry]) -> Result<String> {
        self.require_github("create_tree")?;
        let url = format!("/repos/{repo}/git/trees");
        let tree: Vec<Value> = entries
            .iter()
            .map(|e| {
                json!({
                    "path": e.path,
                    "mode": if e.mode.is_empty() { "100644" } else { e.mode.as_str() },
                    "type": if e.kind.is_empty() { "blob" } else { e.kind.as_str() },
                    "sha": e.sha,
                })
            })
            .collect();
        let resp = self.check(
            self.request(reqwest::Method::POST, &url)
                .json(&json!({ "tree": tree }))
                .send()?,
            "POST",
            &url,
        )?;
        let data: Value = resp.json()?;
        data.get("sha")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| self.forge_err(format!("no sha returned by POST {url}")))
    }

    /// Create a commit object, returning its sha. GitHub only.
    ///
    /// `author` and `committer` are passed verbatim, which is the whole point:
    /// a replayed commit keeps the name, address and timestamp it had upstream.
    /// An actor with an empty `date` is sent without one, letting GitHub stamp
    /// it. Creating the object does not move any branch — see
    /// [`set_branch_ref`](Self::set_branch_ref).
    pub fn create_commit(
        &self,
        repo: &str,
        message: &str,
        tree_sha: &str,
        parents: &[String],
        author: &CommitAuthor,
        committer: &CommitAuthor,
    ) -> Result<String> {
        self.require_github("create_commit")?;
        let actor = |a: &CommitAuthor| {
            let mut o = serde_json::Map::new();
            o.insert("name".into(), json!(a.name));
            o.insert("email".into(), json!(a.email));
            if !a.date.is_empty() {
                o.insert("date".into(), json!(a.date));
            }
            Value::Object(o)
        };
        let url = format!("/repos/{repo}/git/commits");
        let body = json!({
            "message": message,
            "tree": tree_sha,
            "parents": parents,
            "author": actor(author),
            "committer": actor(committer),
        });
        let resp = self.check(
            self.request(reqwest::Method::POST, &url).json(&body).send()?,
            "POST",
            &url,
        )?;
        let data: Value = resp.json()?;
        data.get("sha")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| self.forge_err(format!("no sha returned by POST {url}")))
    }

    /// Point `refs/heads/{branch}` at `sha`, creating the ref if it is absent.
    ///
    /// A freshly created repo has no refs at all, so the update has to be able
    /// to fall through to a create; distinguishing the two up front would cost a
    /// request and still race. GitHub only.
    pub fn set_branch_ref(&self, repo: &str, branch: &str, sha: &str, force: bool) -> Result<()> {
        self.require_github("set_branch_ref")?;
        let patch_url = format!("/repos/{repo}/git/refs/heads/{branch}");
        let resp = self
            .request(reqwest::Method::PATCH, &patch_url)
            .json(&json!({ "sha": sha, "force": force }))
            .send()?;
        match self.check(resp, "PATCH", &patch_url) {
            Ok(_) => Ok(()),
            Err(Error::NotFound(_)) => {
                let url = format!("/repos/{repo}/git/refs");
                let body = json!({ "ref": format!("refs/heads/{branch}"), "sha": sha });
                self.check(
                    self.request(reqwest::Method::POST, &url).json(&body).send()?,
                    "POST",
                    &url,
                )?;
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// Set a repository's default branch. Needed when the source's default is
    /// not the `main` GitHub assumes for a new repo.
    pub fn set_default_branch(&self, repo: &str, branch: &str) -> Result<()> {
        let url = format!("/repos/{repo}");
        self.check(
            self.request(reqwest::Method::PATCH, &url)
                .json(&json!({ "default_branch": branch }))
                .send()?,
            "PATCH",
            &url,
        )?;
        Ok(())
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
        // Proxy-blocked dot-paths on Gitea: write via the ChangeFiles batch
        // endpoint (path in the body, dot-free URL). See [`path_has_dot_segment`].
        if self.provider == Provider::Gitea && path_has_dot_segment(path) {
            let mut file = json!({
                "operation": if existing_sha.is_some() { "update" } else { "create" },
                "path": path,
                "content": B64.encode(content),
            });
            if let Some(sha) = existing_sha {
                file["sha"] = json!(sha);
            }
            return self.gitea_change_files(repo, branch, message, vec![file]);
        }
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
        let resp = self.check(
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
        // Proxy-blocked dot-paths on Gitea: delete via ChangeFiles (dot-free URL).
        if self.provider == Provider::Gitea && path_has_dot_segment(path) {
            let file = json!({
                "operation": "delete",
                "path": path,
                "sha": sha,
            });
            return self.gitea_change_files(repo, branch, message, vec![file]);
        }
        let url = format!("/repos/{repo}/contents/{path}");
        let body = json!({"message": message, "branch": branch, "sha": sha});
        let resp = self.check(
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
        let resp = self.check(
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
        match self.send_read(self.request(reqwest::Method::GET, url), url) {
            Ok(r) => match self.check(r, "GET", url) {
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

    /// Login of the token's authenticated user, or `None` when the token is
    /// missing/invalid. Forge-specific (each instance has its own user). Thin
    /// wrapper over [`auth_check`].
    pub fn current_login(&self) -> Option<String> {
        let (ok, who) = self.auth_check();
        (ok && !who.is_empty()).then_some(who)
    }

    /// Whether `login` may *approve* PRs targeting `base_branch` on `repo`.
    ///
    /// Hybrid policy (drives the "Demandes à valider" list): when a
    /// branch-protection rule covering `base_branch` enables an approvals
    /// whitelist, the user must be on it — directly, or via a whitelisted team.
    /// When there is no such rule (or the rule has no approvals whitelist), we
    /// fall back to push rights. Any forge error degrades to the push-rights
    /// fallback so the list never goes dark on a transient failure. GitHub has
    /// no per-user approvals whitelist, so it always uses the fallback.
    pub fn can_approve(&self, repo: &str, base_branch: &str, login: &str) -> bool {
        if self.provider == Provider::Github {
            return self.can_push(repo);
        }
        let rule = match self.gitea_branch_protection(repo, base_branch) {
            Some(r) => r,
            None => return self.can_push(repo),
        };
        let whitelist_on = rule
            .get("enable_approvals_whitelist")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !whitelist_on {
            return self.can_push(repo);
        }
        if login.is_empty() {
            return false;
        }
        let on_user_list = rule
            .get("approvals_whitelist_username")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|u| u.as_str())
                    .any(|u| u.eq_ignore_ascii_case(login))
            })
            .unwrap_or(false);
        if on_user_list {
            return true;
        }
        let owner = repo.split('/').next().unwrap_or("");
        rule.get("approvals_whitelist_teams")
            .and_then(|v| v.as_array())
            .map(|teams| {
                teams
                    .iter()
                    .filter_map(|t| t.as_str())
                    .any(|t| self.gitea_team_has_member(owner, t, login))
            })
            .unwrap_or(false)
    }

    /// First branch-protection rule on `repo` whose pattern covers `branch`
    /// (exact name preferred, else a `*`/`?` glob), or `None` if the repo has
    /// none / the call fails. Gitea-only.
    fn gitea_branch_protection(&self, repo: &str, branch: &str) -> Option<Value> {
        if self.provider != Provider::Gitea || branch.is_empty() {
            return None;
        }
        let url = format!("/repos/{repo}/branch_protections");
        let resp = self
            .send_read(self.request(reqwest::Method::GET, &url), &url)
            .ok()?;
        let rules: Value = self.check(resp, "GET", &url).ok()?.json().ok()?;
        let arr = rules.as_array()?;
        let pattern_of = |r: &Value| -> String {
            r.get("rule_name")
                .or_else(|| r.get("branch_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        if let Some(exact) = arr.iter().find(|r| pattern_of(r) == branch) {
            return Some(exact.clone());
        }
        arr.iter()
            .find(|r| glob_match(&pattern_of(r), branch))
            .cloned()
    }

    /// Best-effort: is `login` a member of org `org`'s team named `team`?
    /// Returns false on any lookup failure (fail-closed for the whitelist path).
    fn gitea_team_has_member(&self, org: &str, team: &str, login: &str) -> bool {
        if org.is_empty() || team.is_empty() || login.is_empty() {
            return false;
        }
        let list_url = format!("/orgs/{org}/teams");
        let teams: Option<Value> = self
            .request(reqwest::Method::GET, &list_url)
            .query(&[("limit", "50")])
            .send()
            .ok()
            .and_then(|r| self.check(r, "GET", &list_url).ok())
            .and_then(|r| r.json().ok());
        let team_id = teams.as_ref().and_then(|v| v.as_array()).and_then(|arr| {
            arr.iter()
                .find(|t| {
                    t.get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| n.eq_ignore_ascii_case(team))
                        .unwrap_or(false)
                })
                .and_then(|t| t.get("id").and_then(|i| i.as_i64()))
        });
        let Some(id) = team_id else { return false };
        let m_url = format!("/teams/{id}/members/{login}");
        self.request(reqwest::Method::GET, &m_url)
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    pub fn get_token_scopes(&self) -> Vec<String> {
        if self.token.is_empty() {
            return Vec::new();
        }
        let url = "/user";
        let resp = match self.send_read(self.request(reqwest::Method::GET, url), url) {
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
        let resp = match self.send_read(self.request(reqwest::Method::GET, url), url) {
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
            Ok(r) => self.check(r, "GET", &url).is_ok(),
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
        let prs: Value = match self.send_read(req, &url).and_then(|r| Ok(r.json()?)) {
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
                .send_read(
                    self.request(reqwest::Method::GET, &files_url)
                        .query(&[("per_page", "100"), ("limit", "100")]),
                    &files_url,
                )
                .and_then(|r| Ok(r.json()?))
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
        let resp = self.check(
            self.send_read(self.request(reqwest::Method::GET, &url), &url)?,
            "GET",
            &url,
        )?;
        Ok(resp.json()?)
    }

    /// List every open PR on `repo` (no file filtering — unlike
    /// [`list_open_prs_touching`]). Used by the "Suivi Marketplace" tracker to
    /// surface in-flight PRs on a marketplace repo and its plugins' repos.
    /// GitHub and Gitea share the `/pulls` endpoint; `per_page`/`limit` cover
    /// both page-size keys.
    pub fn list_open_prs(&self, repo: &str) -> Result<Vec<Value>> {
        let url = format!("/repos/{repo}/pulls");
        let resp = self.check(
            self.send_read(
                self.request(reqwest::Method::GET, &url)
                    .query(&[("state", "open"), ("per_page", "50"), ("limit", "50")]),
                &url,
            )?,
            "GET",
            &url,
        )?;
        let v: Value = resp.json()?;
        Ok(v.as_array().cloned().unwrap_or_default())
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

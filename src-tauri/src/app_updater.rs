//! Self-update: query GitHub Releases for SkillManager itself, then update
//! **in place** — no installer, no uninstall/reinstall dance.
//!
//! No auth needed — the repo is public and `/releases/latest` is rate-limited
//! per-IP (60/h unauth, plenty for a background check). We deliberately do NOT
//! reuse `GitHubClient` here so a missing/invalid user token can't break the
//! self-update path.
//!
//! # How the in-place swap works
//!
//! Nothing here starts on its own: the background poller only *detects* a new
//! release, and the swap runs when the user presses "Installer". Each step
//! reports through the `on_progress` callback so the top banner can show a real
//! download bar — the module stays free of any `tauri` dependency.
//!
//! The shipped artifact is a single standalone `skillmanager.exe` next to a
//! portable `config/` + `logs/` — nothing else to install. So an update is just
//! "put the new binary where the old one is", which Windows allows even while
//! the app runs: a running image cannot be *deleted* or *overwritten*, but it
//! can be **renamed**. Hence:
//!
//! 1. download the release's portable asset (raw `.exe`, or a `.zip` holding
//!    one) into `<exe_dir>/update/`;
//! 2. check it (asset size, `MZ` header, plausible length) and, decisively,
//!    verify its Authenticode signature against our own publisher — see
//!    `authenticode`;
//! 3. rename the running `skillmanager.exe` into `update/…old.exe`;
//! 4. rename the downloaded binary onto `skillmanager.exe` (rolling back the
//!    previous rename if that fails);
//! 5. leave the running process alone. The new build is what starts next time —
//!    either at the user's next launch, or right away if they take the
//!    "restart now" offer, which relaunches through [`relaunch`].
//!
//! Both moves are same-volume renames: atomic, microseconds, and there is never
//! a window in which the install directory holds no executable. The parked old
//! binary stays locked until the process using it exits, so [`cleanup_stale`]
//! sweeps it at the *next* startup.
//!
//! When the install directory is not writable (a per-machine install under
//! Program Files, run without elevation) or the release ships no portable
//! asset, we fall back to the NSIS installer — spawned silently (`/S`) so it
//! still doesn't put a wizard in the user's face.

use crate::authenticode;
use crate::config;
use crate::error::{Error, Result};
use parking_lot::Mutex;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// Where to look for SkillManager releases. Hardcoded on purpose: this is the
/// app's own update channel, not user-configurable like a marketplace.
const UPDATE_REPO: &str = "vpailt/claude-skillManager";

/// Floor for "this download looks like our binary". The real thing is >10 MB;
/// anything under a megabyte is an error page or a truncated transfer.
const MIN_EXE_BYTES: u64 = 1_000_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub release_url: Option<String>,
    /// Portable binary (raw `.exe`, or a `.zip` containing one) — the asset the
    /// in-place update uses. `None` when the release only ships an installer.
    pub portable_asset_name: Option<String>,
    pub portable_asset_url: Option<String>,
    pub portable_asset_size: u64,
    /// NSIS/MSI installer — only used as a fallback.
    pub installer_asset_name: Option<String>,
    pub installer_asset_url: Option<String>,
    pub installer_asset_size: u64,
    /// True when the release carries a portable asset *and* the install
    /// directory is writable, i.e. the seamless path is available.
    pub can_self_update: bool,
    /// Empty when no release exists yet; otherwise the release body (markdown).
    pub release_notes: String,
    /// "no_release" when the repo has no published release; "ok" otherwise.
    pub status: String,
}

/// Where an in-progress update currently is. Reported to the caller through
/// [`ProgressFn`] so the UI can label the bar instead of showing a bare
/// percentage that sits at 100 % during the (short) verify and swap steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    Downloading,
    /// Zip extraction, shape checks, Authenticode verification.
    Verifying,
    /// The two renames that put the new binary in place.
    Installing,
}

/// Progress sink: `(phase, downloaded, total)`. `total` is 0 while unknown.
///
/// A plain callback rather than an `AppHandle`: this module never depends on
/// `tauri`, and the command layer is the only place that knows about events.
pub type ProgressFn<'a> = &'a mut dyn FnMut(UpdatePhase, u64, u64);

/// Convenience for callers that don't care (tests, one-off paths).
pub fn no_progress(_: UpdatePhase, _: u64, _: u64) {}

/// A published release, as shown in the in-app "Notes de mise à jour" panel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    /// Tag, e.g. `v3.2.0`.
    pub version: String,
    /// Release title; falls back to the tag when GitHub has none.
    pub name: String,
    /// ISO-8601, as GitHub returns it. Formatting is the frontend's business.
    pub published_at: String,
    /// Release body, markdown.
    pub body: String,
    pub url: Option<String>,
    pub prerelease: bool,
    /// True when the release ships a portable binary, i.e. when it can be
    /// installed in place from here — an older one included. A release with an
    /// installer only is listed but offers no button.
    pub installable: bool,
}

/// An update already written to disk. The running process is still the old
/// build — the new one takes over on the next launch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdate {
    /// Version now sitting in `skillmanager.exe`.
    pub version: String,
    /// Version this process is running.
    pub running_version: String,
    pub release_notes: String,
    pub release_url: Option<String>,
}

fn staged_slot() -> &'static Mutex<Option<StagedUpdate>> {
    static SLOT: OnceLock<Mutex<Option<StagedUpdate>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Serialises [`apply_update`]. It writes to a fixed scratch path and renames
/// the running image aside; two overlapping runs would delete each other's
/// verified binary — or, worse, one could rename a still-being-written file
/// onto the install slot (Windows opens with `FILE_SHARE_DELETE`, so the rename
/// succeeds) and leave a truncated `skillmanager.exe` behind.
///
/// This has to live here, not in the UI: the frontend's own "already
/// installing" flag dies with the webview, which tray mode destroys on close —
/// reopening the window is enough to get a second "Installer" button on a store
/// that knows nothing about the download still running. Same reasoning as the
/// process-wide mutex around `sweep_remote`.
fn applying() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// The update applied during this session, if any. Drives the "restart to
/// finish" affordances in the UI.
pub fn staged() -> Option<StagedUpdate> {
    staged_slot().lock().clone()
}

fn set_staged(s: StagedUpdate) {
    *staged_slot().lock() = Some(s);
}

fn http() -> Result<Client> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "Accept",
        HeaderValue::from_static("application/vnd.github+json"),
    );
    headers.insert(
        "X-GitHub-Api-Version",
        HeaderValue::from_static("2022-11-28"),
    );
    headers.insert("User-Agent", HeaderValue::from_static("SkillManager/1.0"));
    Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| Error::Other(e.to_string()))
}

/// Tag-style version comparison: strip leading `v`, split on `.`, compare each
/// segment numerically when possible (falls back to lexical for non-numeric
/// suffixes like `1.0.0-rc1`). Returns true when `latest` is strictly newer.
fn is_newer(latest: &str, current: &str) -> bool {
    let l = latest.trim_start_matches('v').trim();
    let c = current.trim_start_matches('v').trim();
    if l == c {
        return false;
    }
    let parse = |s: &str| -> Vec<(u64, String)> {
        s.split('.')
            .map(|part| {
                // Split numeric prefix from any suffix (e.g. "0-rc1" -> (0, "-rc1")).
                let end = part
                    .char_indices()
                    .find(|(_, ch)| !ch.is_ascii_digit())
                    .map(|(i, _)| i)
                    .unwrap_or(part.len());
                let (num, rest) = part.split_at(end);
                (num.parse::<u64>().unwrap_or(0), rest.to_string())
            })
            .collect()
    };
    let lp = parse(l);
    let cp = parse(c);
    for i in 0..lp.len().max(cp.len()) {
        let (ln, ls) = lp.get(i).cloned().unwrap_or((0, String::new()));
        let (cn, cs) = cp.get(i).cloned().unwrap_or((0, String::new()));
        if ln != cn {
            return ln > cn;
        }
        if ls != cs {
            // A release ("") beats any pre-release suffix like "-rc1".
            if ls.is_empty() && !cs.is_empty() {
                return true;
            }
            if !ls.is_empty() && cs.is_empty() {
                return false;
            }
            return ls > cs;
        }
    }
    false
}

/// Is this asset the standalone binary (`Some(true)`), the installer
/// (`Some(false)`), or neither (`None`)?
///
/// Naming is a convention, not a contract, so the test is deliberately loose:
/// anything whose name says "setup"/"install" is the wizard, `.msi` too; every
/// other `.exe` — and any `.zip`, which is how the binary ships compressed — is
/// treated as the portable build.
fn classify(name: &str) -> Option<bool> {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".msi") {
        return Some(false);
    }
    if n.ends_with(".exe") {
        let installer = n.contains("setup") || n.contains("install");
        return Some(!installer);
    }
    if n.ends_with(".zip") {
        return Some(true);
    }
    None
}

/// Can we replace the binary ourselves? True for the portable and per-user
/// installs this app ships as; false under `C:\Program Files` without
/// elevation, where the NSIS fallback (which can prompt for UAC) takes over.
pub fn install_dir_writable() -> bool {
    let probe = config::exe_dir().join(".write-probe.tmp");
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(e) => {
            tracing::debug!("app_updater: install dir not writable: {}", e);
            false
        }
    }
}

pub fn check_for_update() -> Result<AppUpdateInfo> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let url = format!("https://api.github.com/repos/{UPDATE_REPO}/releases/latest");
    let resp = http()?.get(&url).send().map_err(|e| {
        tracing::warn!("app_updater: GET {} failed: {}", url, e);
        Error::Other(format!("Network error: {e}"))
    })?;
    let status = resp.status();
    if status.as_u16() == 404 {
        tracing::info!("app_updater: no release published yet at {}", UPDATE_REPO);
        return Ok(AppUpdateInfo {
            current_version,
            latest_version: None,
            has_update: false,
            release_url: Some(format!("https://github.com/{UPDATE_REPO}/releases")),
            portable_asset_name: None,
            portable_asset_url: None,
            portable_asset_size: 0,
            installer_asset_name: None,
            installer_asset_url: None,
            installer_asset_size: 0,
            can_self_update: false,
            release_notes: String::new(),
            status: "no_release".to_string(),
        });
    }
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        return Err(Error::Other(format!(
            "GitHub returned {status} for {url}: {text}"
        )));
    }
    let v: Value = resp.json().map_err(|e| Error::Other(e.to_string()))?;
    Ok(parse_release(&v))
}

/// Everything [`AppUpdateInfo`] needs, read out of one GitHub release payload.
///
/// Split out of [`check_for_update`] so [`release_by_tag`] can hand the very
/// same shape to `apply_update` for *any* published release, not only the
/// latest — which is all "reinstall an older version" amounts to. `has_update`
/// is computed the same way in both cases and is simply false when the release
/// is older than what is running; nothing downstream reads it, the asset URLs
/// do the work.
fn parse_release(v: &Value) -> AppUpdateInfo {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let tag = v
        .get("tag_name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let release_url = v
        .get("html_url")
        .and_then(|x| x.as_str())
        .map(String::from);
    let release_notes = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let assets = v
        .get("assets")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    // Sort each asset into "portable binary" / "installer", preferring a `.zip`
    // for the portable slot: same bytes, a third of the download.
    let mut portable: Option<(String, String, u64)> = None;
    let mut installer: Option<(String, String, u64)> = None;
    for a in &assets {
        let (Some(name), Some(url)) = (
            a.get("name").and_then(|n| n.as_str()),
            a.get("browser_download_url").and_then(|n| n.as_str()),
        ) else {
            continue;
        };
        let size = a.get("size").and_then(|n| n.as_u64()).unwrap_or(0);
        match classify(name) {
            Some(true) => {
                let better = match &portable {
                    None => true,
                    Some((have, _, _)) => {
                        !have.to_ascii_lowercase().ends_with(".zip")
                            && name.to_ascii_lowercase().ends_with(".zip")
                    }
                };
                if better {
                    portable = Some((name.to_string(), url.to_string(), size));
                }
            }
            Some(false) => {
                if installer.is_none() {
                    installer = Some((name.to_string(), url.to_string(), size));
                }
            }
            None => {}
        }
    }

    // Normalise here, once. Tags carry a leading `v`, `CARGO_PKG_VERSION` does
    // not, and the two are printed side by side ("3.4.0 est disponible — vous
    // êtes en 3.3.0"). Nothing downstream needs the raw tag: the asset URLs come
    // from the release payload, not from the tag.
    let latest_version = if tag.is_empty() {
        None
    } else {
        Some(tag.trim_start_matches('v').trim().to_string())
    };
    let has_update = latest_version
        .as_deref()
        .map(|t| is_newer(t, &current_version))
        .unwrap_or(false);

    let (portable_asset_name, portable_asset_url, portable_asset_size) = match portable {
        Some((n, u, s)) => (Some(n), Some(u), s),
        None => (None, None, 0),
    };
    let (installer_asset_name, installer_asset_url, installer_asset_size) = match installer {
        Some((n, u, s)) => (Some(n), Some(u), s),
        None => (None, None, 0),
    };
    let can_self_update = portable_asset_url.is_some() && install_dir_writable();

    tracing::info!(
        "app_updater: current={} latest={} has_update={} portable={} installer={} self_update={}",
        current_version,
        tag,
        has_update,
        portable_asset_name.as_deref().unwrap_or("<none>"),
        installer_asset_name.as_deref().unwrap_or("<none>"),
        can_self_update
    );

    AppUpdateInfo {
        current_version,
        latest_version,
        has_update,
        release_url,
        portable_asset_name,
        portable_asset_url,
        portable_asset_size,
        installer_asset_name,
        installer_asset_url,
        installer_asset_size,
        can_self_update,
        release_notes,
        status: "ok".to_string(),
    }
}

/// One published release, by tag — the door to installing a version other than
/// the latest, an older one included.
///
/// Deliberately the same [`AppUpdateInfo`] `check_for_update` returns, so the
/// install path is literally the same code: download the portable asset, verify
/// its signature, swap it in. A downgrade is not a special mode, it is this
/// function plus the existing swap.
pub fn release_by_tag(tag: &str) -> Result<AppUpdateInfo> {
    let tag = tag.trim();
    if tag.is_empty() {
        return Err(Error::Invalid("no release tag given".into()));
    }
    let url = format!("https://api.github.com/repos/{UPDATE_REPO}/releases/tags/{tag}");
    let resp = http()?.get(&url).send().map_err(|e| {
        tracing::warn!("app_updater: GET {} failed: {}", url, e);
        Error::Other(format!("Network error: {e}"))
    })?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Err(Error::NotFound(format!(
            "aucune release publiée pour le tag {tag}"
        )));
    }
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        return Err(Error::Other(format!(
            "GitHub returned {status} for {url}: {text}"
        )));
    }
    let v: Value = resp.json().map_err(|e| Error::Other(e.to_string()))?;
    let info = parse_release(&v);
    tracing::info!(
        "app_updater: release {} resolved (portable={}, self_update={})",
        tag,
        info.portable_asset_name.as_deref().unwrap_or("<none>"),
        info.can_self_update
    );
    Ok(info)
}

/// The published releases, newest first — what the in-app "Notes de mise à
/// jour" panel shows.
///
/// Separate from [`check_for_update`] on purpose: that one answers "is there
/// something newer" and only ever sees `/releases/latest`, so the notes of the
/// version you are *running* were unreachable. Drafts are skipped (they are
/// invisible to unauthenticated calls anyway, but a token-bearing future caller
/// would see them).
pub fn fetch_releases(limit: u32) -> Result<Vec<ReleaseNote>> {
    let per_page = limit.clamp(1, 50);
    let url =
        format!("https://api.github.com/repos/{UPDATE_REPO}/releases?per_page={per_page}");
    let resp = http()?.get(&url).send().map_err(|e| {
        tracing::warn!("app_updater: GET {} failed: {}", url, e);
        Error::Other(format!("Network error: {e}"))
    })?;
    let status = resp.status();
    if status.as_u16() == 404 {
        // No release ever published — an empty history, not a failure.
        return Ok(Vec::new());
    }
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        return Err(Error::Other(format!(
            "GitHub returned {status} for {url}: {text}"
        )));
    }
    let items: Vec<Value> = resp.json().map_err(|e| Error::Other(e.to_string()))?;
    let notes: Vec<ReleaseNote> = items
        .iter()
        .filter(|r| !r.get("draft").and_then(|d| d.as_bool()).unwrap_or(false))
        .map(|r| {
            let str_of = |k: &str| r.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let version = str_of("tag_name");
            let name = {
                let n = str_of("name");
                if n.is_empty() {
                    version.clone()
                } else {
                    n
                }
            };
            // Whether this release could be installed from here at all: the
            // in-place swap needs a portable asset, and a release that ships
            // only an installer must not offer a button that would fail.
            let installable = r
                .get("assets")
                .and_then(|x| x.as_array())
                .map(|assets| {
                    assets.iter().any(|a| {
                        a.get("name")
                            .and_then(|n| n.as_str())
                            .and_then(classify)
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
            ReleaseNote {
                version,
                name,
                published_at: str_of("published_at"),
                body: str_of("body"),
                url: r.get("html_url").and_then(|x| x.as_str()).map(String::from),
                prerelease: r
                    .get("prerelease")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false),
                installable,
            }
        })
        .collect();
    tracing::info!("app_updater: fetched {} release note(s)", notes.len());
    Ok(notes)
}

// ============================================================
// In-place update
// ============================================================

/// Cap on the buffer we pre-allocate from a server-declared length. The real
/// asset is ~10 MB; refusing to trust `Content-Length` past this keeps a bogus
/// header from asking for a gigabyte of RAM up front.
const MAX_PREALLOC_BYTES: u64 = 256 * 1024 * 1024;
const DOWNLOAD_CHUNK: usize = 64 * 1024;

/// Stream the asset into memory, reporting progress as it goes.
///
/// Read in chunks rather than through `Response::bytes()`: the point is not
/// memory (the asset is ~10 MB either way) but that a single blocking call
/// gives the UI nothing to show for the whole transfer.
fn download(url: &str, expected_size: u64, on_progress: ProgressFn) -> Result<Vec<u8>> {
    tracing::info!("app_updater: downloading {}", url);
    let mut resp = http()?
        .get(url)
        .timeout(Duration::from_secs(600))
        .send()
        .map_err(|e| Error::Other(format!("download failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(Error::Other(format!("download failed: {status} for {url}")));
    }
    // Prefer what the release told us: `Content-Length` is absent on a chunked
    // response, and GitHub's asset URLs redirect to a CDN that may not set it.
    let total = if expected_size > 0 {
        expected_size
    } else {
        resp.content_length().unwrap_or(0)
    };

    let mut bytes: Vec<u8> = Vec::with_capacity(total.min(MAX_PREALLOC_BYTES) as usize);
    let mut buf = vec![0u8; DOWNLOAD_CHUNK];
    on_progress(UpdatePhase::Downloading, 0, total);
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| Error::Other(format!("download body read failed: {e}")))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        on_progress(UpdatePhase::Downloading, bytes.len() as u64, total);
    }
    // The release tells us the byte count; a mismatch means a truncated or
    // mangled transfer, and we are about to overwrite our own binary with it.
    // Refuse rather than assume it's fine.
    if expected_size > 0 && bytes.len() as u64 != expected_size {
        return Err(Error::Other(format!(
            "download size mismatch: expected {expected_size} bytes, got {}",
            bytes.len()
        )));
    }
    tracing::info!("app_updater: downloaded {} bytes", bytes.len());
    Ok(bytes)
}

/// Pull the app binary out of a release zip. Prefers an entry literally named
/// `skillmanager.exe`, else the first `.exe` it finds.
fn write_exe_from_zip(bytes: &[u8], dest: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    let mut pick: Option<usize> = None;
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_ascii_lowercase();
        if !name.ends_with(".exe") {
            continue;
        }
        if name.rsplit('/').next().unwrap_or(&name) == "skillmanager.exe" {
            pick = Some(i);
            break;
        }
        if pick.is_none() {
            pick = Some(i);
        }
    }
    let idx = pick.ok_or_else(|| Error::Invalid("no .exe inside the release archive".into()))?;
    let mut entry = zip.by_index(idx)?;
    let mut out = fs::File::create(dest)?;
    std::io::copy(&mut entry, &mut out)?;
    Ok(())
}

/// Cheap sanity check on the freshly written binary: a Windows executable
/// starts with `MZ`, and ours is never small.
fn verify_exe(path: &Path) -> Result<()> {
    let meta = fs::metadata(path)?;
    if meta.len() < MIN_EXE_BYTES {
        return Err(Error::Invalid(format!(
            "downloaded binary is only {} bytes — not a SkillManager build",
            meta.len()
        )));
    }
    let mut head = [0u8; 2];
    fs::File::open(path)?.read_exact(&mut head)?;
    if &head != b"MZ" {
        return Err(Error::Invalid(
            "downloaded file is not a Windows executable".into(),
        ));
    }
    Ok(())
}

/// Delete whatever a previous update left behind in `<exe_dir>/update`.
///
/// Called at startup and before each staging. Failures are expected and
/// ignored: right after an in-place update the parked binary *is* the running
/// image and stays locked until this process exits — the next launch gets it.
pub fn cleanup_stale() {
    let dir = config::exe_dir().join("update");
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut removed = 0;
    let mut left = 0;
    for e in entries.flatten() {
        if fs::remove_file(e.path()).is_ok() {
            removed += 1;
        } else {
            left += 1;
        }
    }
    if removed > 0 || left > 0 {
        tracing::info!(
            "app_updater: cleanup removed {} stale file(s), {} still locked",
            removed,
            left
        );
    }
    if left == 0 {
        let _ = fs::remove_dir(&dir);
    }
}

/// Download `info`'s portable asset and swap it onto the running executable.
///
/// Returns once the new binary is on disk — this process keeps running the old
/// code until someone restarts it (see [`relaunch`]).
///
/// `on_progress` is called throughout; pass [`no_progress`] when there is
/// nothing to report to.
pub fn apply_update(info: &AppUpdateInfo, on_progress: ProgressFn) -> Result<StagedUpdate> {
    // Refuse rather than queue: a second caller is a duplicate click or a
    // rebuilt window, and making it wait would only download the same asset
    // twice and then fight over the same scratch file.
    // `Other`, not `Invalid`: these two land verbatim in a toast the user sees
    // by double-clicking "Installer", and `Invalid` renders as
    // "invalid input: …" (see `error.rs`).
    let Some(_guard) = applying().try_lock() else {
        return Err(Error::Other(
            "Une mise à jour est déjà en cours d'installation.".into(),
        ));
    };
    if let Some(done) = staged() {
        return Err(Error::Other(format!(
            "La version {} est déjà installée — redémarrez SkillManager pour l'utiliser.",
            done.version
        )));
    }
    let (Some(url), Some(name)) = (
        info.portable_asset_url.as_deref(),
        info.portable_asset_name.as_deref(),
    ) else {
        return Err(Error::Invalid(
            "this release ships no portable binary — nothing to swap in place".into(),
        ));
    };
    let version = info
        .latest_version
        .clone()
        .unwrap_or_else(|| "unknown".into());

    // The install slot, captured at startup — see `config::exe_path`. Resolving
    // it here instead would risk naming a binary a previous swap parked away.
    let exe = config::exe_path();
    cleanup_stale();
    let dir = config::update_dir();

    let bytes = download(url, info.portable_asset_size, on_progress)?;
    let downloaded = bytes.len() as u64;
    on_progress(UpdatePhase::Verifying, downloaded, downloaded);
    let fresh = dir.join("skillmanager-new.exe");
    let _ = fs::remove_file(&fresh);
    if name.to_ascii_lowercase().ends_with(".zip") {
        write_exe_from_zip(&bytes, &fresh)?;
    } else {
        fs::write(&fresh, &bytes)?;
    }
    verify_exe(&fresh)?;
    // The real gate. Everything above only proves we downloaded *something* of
    // the right shape; this proves Windows trusts its signature and that the
    // signer is us. It runs before the swap, so a binary that fails it is
    // simply deleted and the install is never touched.
    let signer = authenticode::verify_signed_by(&fresh, authenticode::EXPECTED_SIGNER)
        .inspect_err(|_| {
            let _ = fs::remove_file(&fresh);
        })?;
    tracing::info!("app_updater: downloaded binary signed by \"{}\"", signer);

    // Park the running image. Windows refuses to delete or overwrite it, but a
    // rename is fine — the loader opened it with FILE_SHARE_DELETE. The stamp
    // keeps a second update in the same session from colliding with the first.
    on_progress(UpdatePhase::Installing, downloaded, downloaded);
    let stamp = chrono::Utc::now().timestamp_millis();
    let parked = dir.join(format!(
        "skillmanager-{}-{}.old.exe",
        info.current_version, stamp
    ));
    fs::rename(&exe, &parked).map_err(|e| {
        let _ = fs::remove_file(&fresh);
        Error::Other(format!(
            "could not move the running executable aside ({e}). \
             Is {} read-only, or is another SkillManager running?",
            exe.display()
        ))
    })?;
    if let Err(e) = fs::rename(&fresh, &exe) {
        // Put the old binary back so the install is never left without one.
        let rolled_back = fs::rename(&parked, &exe).is_ok();
        tracing::error!(
            "app_updater: swap failed ({}), rollback {}",
            e,
            if rolled_back { "ok" } else { "FAILED" }
        );
        return Err(Error::Other(format!(
            "could not put the new binary in place ({e}){}",
            if rolled_back {
                " — the previous version was restored"
            } else {
                " — and the previous version could not be restored, reinstall from GitHub"
            }
        )));
    }

    tracing::info!(
        "app_updater: {} -> {} applied in place ({})",
        info.current_version,
        version,
        exe.display()
    );
    sync_registry_version(&version);

    let staged = StagedUpdate {
        version,
        running_version: info.current_version.clone(),
        release_notes: info.release_notes.clone(),
        release_url: info.release_url.clone(),
    };
    set_staged(staged.clone());
    Ok(staged)
}

/// Keep "Apps & features" honest after an in-place update: NSIS wrote a
/// `DisplayVersion` at install time and nothing else refreshes it. Best-effort
/// — a portable install has no entry at all.
#[cfg(windows)]
fn sync_registry_version(version: &str) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let exe_dir = config::exe_dir();
    let target = fs::canonicalize(&exe_dir).unwrap_or(exe_dir);
    let target_norm = target.to_string_lossy().to_lowercase();
    let clean = version.trim_start_matches('v').to_string();

    for hive in [
        RegKey::predef(HKEY_CURRENT_USER),
        RegKey::predef(HKEY_LOCAL_MACHINE),
    ] {
        for sub in [
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
            "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ] {
            let Ok(root) = hive.open_subkey(sub) else {
                continue;
            };
            for name in root.enum_keys().flatten() {
                let Ok(entry) = root.open_subkey_with_flags(&name, KEY_READ | KEY_WRITE) else {
                    continue;
                };
                let loc: String = entry.get_value("InstallLocation").unwrap_or_default();
                if loc.is_empty() {
                    continue;
                }
                let canon = fs::canonicalize(&loc)
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| loc.clone())
                    .to_lowercase();
                if canon != target_norm && !canon.starts_with(&target_norm) {
                    continue;
                }
                if entry.set_value("DisplayVersion", &clean).is_ok() {
                    tracing::info!("app_updater: registry DisplayVersion -> {}", clean);
                }
                return;
            }
        }
    }
}

#[cfg(not(windows))]
fn sync_registry_version(_version: &str) {}

// ============================================================
// Restart
// ============================================================

/// Command-line flag the relaunched process gets so it waits for the outgoing
/// one to die before arming the single-instance guard.
pub const WAIT_PID_FLAG: &str = "--wait-pid";

/// Start the (now updated) binary and hand it the current PID to wait on.
/// The caller exits right after — see `commands::app_restart`.
pub fn relaunch() -> Result<()> {
    let exe = config::exe_path();
    let pid = std::process::id();
    std::process::Command::new(&exe)
        .arg(WAIT_PID_FLAG)
        .arg(pid.to_string())
        .spawn()
        .map_err(|e| Error::Other(format!("could not relaunch {}: {e}", exe.display())))?;
    tracing::info!(
        "app_updater: relaunched {} (waiting on pid {})",
        exe.display(),
        pid
    );
    Ok(())
}

/// `--wait-pid <pid>` from our own argv, if present.
pub fn wait_pid_from_args() -> Option<u32> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == WAIT_PID_FLAG {
            return args.next().and_then(|v| v.parse::<u32>().ok());
        }
        if let Some(v) = a.strip_prefix("--wait-pid=") {
            return v.parse::<u32>().ok();
        }
    }
    None
}

/// Block until process `pid` is gone (or the timeout lapses).
///
/// Must run **before** the single-instance plugin arms: the outgoing process is
/// still alive for a few hundred milliseconds after it spawns us, and if the
/// guard sees it, it hands the session back to the build we just replaced and
/// we exit immediately.
#[cfg(windows)]
pub fn wait_for_pid(pid: u32, timeout_ms: u32) {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(
            dw_desired_access: u32,
            b_inherit_handle: i32,
            dw_process_id: u32,
        ) -> *mut core::ffi::c_void;
        fn WaitForSingleObject(h: *mut core::ffi::c_void, ms: u32) -> u32;
        fn CloseHandle(h: *mut core::ffi::c_void) -> i32;
    }
    const SYNCHRONIZE: u32 = 0x0010_0000;
    unsafe {
        let h = OpenProcess(SYNCHRONIZE, 0, pid);
        if h.is_null() {
            return; // already exited (or not ours to wait on)
        }
        WaitForSingleObject(h, timeout_ms);
        CloseHandle(h);
    }
    // The tray icon and the single-instance mutex are torn down slightly after
    // the process object signals; a short grace period avoids racing both.
    std::thread::sleep(Duration::from_millis(300));
}

#[cfg(not(windows))]
pub fn wait_for_pid(_pid: u32, _timeout_ms: u32) {}

// ============================================================
// Installer fallback (read-only install dir, or no portable asset)
// ============================================================

/// Download the installer asset to `%TEMP%`. Returns the absolute path so the
/// caller can hand it off to ShellExecuteW.
pub fn download_installer(
    asset_url: &str,
    asset_name: &str,
    on_progress: ProgressFn,
) -> Result<PathBuf> {
    if asset_url.is_empty() || asset_name.is_empty() {
        return Err(Error::Invalid("empty asset url or name".into()));
    }
    // Defensive: keep only the file name part of `asset_name` to avoid
    // path-traversal if the upstream label ever contains separators.
    let safe_name = Path::new(asset_name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "skillmanager-update.exe".to_string());

    let dir = std::env::temp_dir().join("SkillManager-update");
    fs::create_dir_all(&dir)?;
    let target = dir.join(safe_name);

    let bytes = download(asset_url, 0, on_progress)?;
    let downloaded = bytes.len() as u64;
    on_progress(UpdatePhase::Verifying, downloaded, downloaded);
    fs::write(&target, &bytes)?;
    // Same gate as the in-place path: this installer is about to be run, with
    // elevation if the install location needs it.
    let signer = authenticode::verify_signed_by(&target, authenticode::EXPECTED_SIGNER)
        .inspect_err(|_| {
            let _ = fs::remove_file(&target);
        })?;
    tracing::info!(
        "app_updater: installer saved to {} ({} bytes), signed by \"{}\"",
        target.display(),
        bytes.len(),
        signer
    );
    Ok(target)
}

/// Spawn the installer via ShellExecuteW. We deliberately do not wait — the
/// caller exits the app immediately so NSIS can replace files.
///
/// `/S` runs it silently and `/UPDATE` tells the Tauri NSIS template this is an
/// upgrade of an existing install, so the user sees no wizard — just the UAC
/// prompt, when the install location needs one. NSIS ignores switches its
/// script doesn't read, so this stays safe across template changes.
#[cfg(windows)]
pub fn launch_installer(path: &Path) -> Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let target_wide: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb_wide: Vec<u16> = OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let params_wide: Vec<u16> = OsStr::new("/S /UPDATE /R")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut core::ffi::c_void,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> isize;
    }
    const SW_SHOWNORMAL: i32 = 1;
    let rc = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb_wide.as_ptr(),
            target_wide.as_ptr(),
            params_wide.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if rc > 32 {
        tracing::info!("app_updater: installer spawned ({})", path.display());
        Ok(())
    } else {
        Err(Error::Other(format!(
            "ShellExecuteW failed (code {rc}) for {}",
            path.display()
        )))
    }
}

#[cfg(not(windows))]
pub fn launch_installer(_path: &Path) -> Result<()> {
    Err(Error::Invalid(
        "auto-install only supported on Windows".into(),
    ))
}

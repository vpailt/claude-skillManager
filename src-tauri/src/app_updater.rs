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
//! The shipped artifact is a single standalone `skillmanager.exe` next to a
//! portable `config/` + `logs/` — nothing else to install. So an update is just
//! "put the new binary where the old one is", which Windows allows even while
//! the app runs: a running image cannot be *deleted* or *overwritten*, but it
//! can be **renamed**. Hence:
//!
//! 1. download the release's portable asset (raw `.exe`, or a `.zip` holding
//!    one) into `<exe_dir>/update/`;
//! 2. sanity-check it (asset size, `MZ` header, plausible length);
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

    let latest_version = if tag.is_empty() {
        None
    } else {
        Some(tag.clone())
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

    Ok(AppUpdateInfo {
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
    })
}

// ============================================================
// In-place update
// ============================================================

fn download(url: &str, expected_size: u64) -> Result<Vec<u8>> {
    tracing::info!("app_updater: downloading {}", url);
    let resp = http()?
        .get(url)
        .timeout(Duration::from_secs(600))
        .send()
        .map_err(|e| Error::Other(format!("download failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(Error::Other(format!("download failed: {status} for {url}")));
    }
    let bytes = resp
        .bytes()
        .map_err(|e| Error::Other(format!("download body read failed: {e}")))?
        .to_vec();
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
pub fn apply_update(info: &AppUpdateInfo) -> Result<StagedUpdate> {
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

    let bytes = download(url, info.portable_asset_size)?;
    let fresh = dir.join("skillmanager-new.exe");
    let _ = fs::remove_file(&fresh);
    if name.to_ascii_lowercase().ends_with(".zip") {
        write_exe_from_zip(&bytes, &fresh)?;
    } else {
        fs::write(&fresh, &bytes)?;
    }
    verify_exe(&fresh)?;

    // Park the running image. Windows refuses to delete or overwrite it, but a
    // rename is fine — the loader opened it with FILE_SHARE_DELETE. The stamp
    // keeps a second update in the same session from colliding with the first.
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
pub fn download_installer(asset_url: &str, asset_name: &str) -> Result<PathBuf> {
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

    let bytes = download(asset_url, 0)?;
    fs::write(&target, &bytes)?;
    tracing::info!(
        "app_updater: installer saved to {} ({} bytes)",
        target.display(),
        bytes.len()
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

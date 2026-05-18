//! Self-update: query GitHub Releases for SkillManager itself and (optionally)
//! download + launch the NSIS installer.
//!
//! No auth needed — the repo is public and `/releases/latest` is rate-limited
//! per-IP (60/h unauth, plenty for a manual button). We deliberately do NOT
//! reuse `GitHubClient` here so a missing/invalid user token can't break the
//! self-update path.

use crate::error::{Error, Result};
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

/// Where to look for SkillManager releases. Hardcoded on purpose: this is the
/// app's own update channel, not user-configurable like a marketplace.
const UPDATE_REPO: &str = "vpailt/claude-skillManager";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub release_url: Option<String>,
    pub installer_asset_name: Option<String>,
    pub installer_asset_url: Option<String>,
    pub installer_asset_size: u64,
    /// Empty when no release exists yet; otherwise the release body (markdown).
    pub release_notes: String,
    /// "no_release" when the repo has no published release; "ok" otherwise.
    pub status: String,
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
            installer_asset_name: None,
            installer_asset_url: None,
            installer_asset_size: 0,
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

    // Find an installer asset. Prefer one ending in `-setup.exe` (Tauri/NSIS
    // default), fall back to any `.exe`, then `.msi`.
    let assets = v
        .get("assets")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let pick = |needle: &str| -> Option<(String, String, u64)> {
        assets.iter().find_map(|a| {
            let name = a.get("name").and_then(|n| n.as_str())?;
            if name.to_ascii_lowercase().ends_with(needle) {
                let url = a
                    .get("browser_download_url")
                    .and_then(|n| n.as_str())?
                    .to_string();
                let size = a.get("size").and_then(|n| n.as_u64()).unwrap_or(0);
                Some((name.to_string(), url, size))
            } else {
                None
            }
        })
    };
    let asset = pick("-setup.exe").or_else(|| pick(".exe")).or_else(|| pick(".msi"));

    let latest_version = if tag.is_empty() { None } else { Some(tag.clone()) };
    let has_update = latest_version
        .as_deref()
        .map(|t| is_newer(t, &current_version))
        .unwrap_or(false);

    let (installer_asset_name, installer_asset_url, installer_asset_size) = match asset {
        Some((n, u, s)) => (Some(n), Some(u), s),
        None => (None, None, 0),
    };

    tracing::info!(
        "app_updater: current={} latest={} has_update={} installer={}",
        current_version,
        tag,
        has_update,
        installer_asset_name.as_deref().unwrap_or("<none>")
    );

    Ok(AppUpdateInfo {
        current_version,
        latest_version,
        has_update,
        release_url,
        installer_asset_name,
        installer_asset_url,
        installer_asset_size,
        release_notes,
        status: "ok".to_string(),
    })
}

/// Download the installer asset to `%TEMP%`. Returns the absolute path so the
/// caller can hand it off to ShellExecuteW.
pub fn download_installer(asset_url: &str, asset_name: &str) -> Result<PathBuf> {
    if asset_url.is_empty() || asset_name.is_empty() {
        return Err(Error::Invalid("empty asset url or name".into()));
    }
    // Defensive: keep only the file name part of `asset_name` to avoid
    // path-traversal if the upstream label ever contains separators.
    let safe_name = std::path::Path::new(asset_name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "skillmanager-update.exe".to_string());

    let dir = std::env::temp_dir().join("SkillManager-update");
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(safe_name);

    tracing::info!("app_updater: downloading {} -> {}", asset_url, target.display());
    let resp = http()?
        .get(asset_url)
        .timeout(Duration::from_secs(300))
        .send()
        .map_err(|e| Error::Other(format!("download failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(Error::Other(format!(
            "installer download failed: {status} for {asset_url}"
        )));
    }
    let bytes = resp
        .bytes()
        .map_err(|e| Error::Other(format!("download body read failed: {e}")))?;
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&target)?;
    f.write_all(&bytes)?;
    tracing::info!(
        "app_updater: downloaded {} bytes to {}",
        bytes.len(),
        target.display()
    );
    Ok(target)
}

/// Spawn the installer via ShellExecuteW. We deliberately do not wait — the
/// caller will exit the app immediately so the installer can replace files.
#[cfg(windows)]
pub fn launch_installer(path: &std::path::Path) -> Result<()> {
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
            std::ptr::null(),
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
pub fn launch_installer(_path: &std::path::Path) -> Result<()> {
    Err(Error::Invalid(
        "auto-install only supported on Windows".into(),
    ))
}

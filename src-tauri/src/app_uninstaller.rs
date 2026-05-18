//! Locate and launch the NSIS uninstaller for SkillManager.
//!
//! The Tauri NSIS bundler drops `uninstall.exe` next to `skillmanager.exe` at
//! install time, so the primary lookup is just `<exe_dir>/uninstall.exe`. As a
//! fallback we walk the Windows Uninstall registry hive looking for an entry
//! whose `InstallLocation` matches our exe dir — this catches edge cases like
//! a renamed binary or weird per-machine vs per-user install layouts.
//!
//! For portable/zip installs (no uninstall.exe, no registry entry) we return
//! an error so the front-end can tell the user "delete the folder manually".

use crate::config;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallInfo {
    /// "nsis" when uninstall.exe was found; "registry" when only the registry
    /// entry was found; "none" for a portable install.
    pub kind: String,
    pub uninstaller_path: Option<String>,
    pub install_location: Option<String>,
    pub display_name: Option<String>,
    pub display_version: Option<String>,
}

pub fn detect() -> UninstallInfo {
    let exe_dir = config::exe_dir();
    let local = exe_dir.join("uninstall.exe");
    if local.exists() {
        return UninstallInfo {
            kind: "nsis".to_string(),
            uninstaller_path: Some(local.to_string_lossy().into_owned()),
            install_location: Some(exe_dir.to_string_lossy().into_owned()),
            display_name: Some("SkillManager".to_string()),
            display_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        };
    }

    #[cfg(windows)]
    {
        if let Some(info) = registry_lookup() {
            return info;
        }
    }

    UninstallInfo {
        kind: "none".to_string(),
        uninstaller_path: None,
        install_location: Some(exe_dir.to_string_lossy().into_owned()),
        display_name: Some("SkillManager".to_string()),
        display_version: Some(env!("CARGO_PKG_VERSION").to_string()),
    }
}

#[cfg(windows)]
fn registry_lookup() -> Option<UninstallInfo> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let exe_dir = config::exe_dir();
    let target = std::fs::canonicalize(&exe_dir).unwrap_or(exe_dir.clone());
    let target_norm = target.to_string_lossy().to_lowercase();

    let roots = [
        RegKey::predef(HKEY_CURRENT_USER),
        RegKey::predef(HKEY_LOCAL_MACHINE),
    ];
    let subpaths: &[&str] = &[
        "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ];

    for hive in &roots {
        for sub in subpaths {
            let Ok(uninstall_key) = hive.open_subkey(sub) else {
                continue;
            };
            for sub_name in uninstall_key.enum_keys().flatten() {
                let Ok(entry) = uninstall_key.open_subkey(&sub_name) else {
                    continue;
                };
                let install_location: String = entry
                    .get_value("InstallLocation")
                    .unwrap_or_default();
                if install_location.is_empty() {
                    continue;
                }
                let canon = std::fs::canonicalize(&install_location)
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| install_location.clone());
                if canon.to_lowercase() != target_norm
                    && !canon.to_lowercase().starts_with(&target_norm)
                {
                    continue;
                }
                let display_name: String =
                    entry.get_value("DisplayName").unwrap_or_default();
                let display_version: String =
                    entry.get_value("DisplayVersion").unwrap_or_default();
                let uninstall_string: String =
                    entry.get_value("UninstallString").unwrap_or_default();
                let quiet_string: String = entry
                    .get_value("QuietUninstallString")
                    .unwrap_or_default();
                let chosen = if !uninstall_string.is_empty() {
                    uninstall_string
                } else {
                    quiet_string
                };
                if chosen.is_empty() {
                    continue;
                }
                tracing::info!(
                    "app_uninstaller: matched registry entry {} ({})",
                    sub_name,
                    display_name
                );
                return Some(UninstallInfo {
                    kind: "registry".to_string(),
                    uninstaller_path: Some(chosen),
                    install_location: Some(install_location),
                    display_name: Some(display_name),
                    display_version: Some(display_version),
                });
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn registry_lookup() -> Option<UninstallInfo> {
    None
}

/// Spawn the uninstaller and return. The caller is expected to exit the app
/// immediately after so NSIS can replace/remove files.
#[cfg(windows)]
pub fn launch(info: &UninstallInfo) -> Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let raw = info
        .uninstaller_path
        .as_deref()
        .ok_or_else(|| Error::Invalid("no uninstaller path".into()))?;

    // The registry's `UninstallString` is often quoted and may contain extra
    // args ("C:\\path\\uninstall.exe" /KEEP). Parse the executable separately
    // from the parameters so ShellExecuteW receives the right pieces.
    let (exe, args) = split_uninstall_string(raw);

    if !std::path::Path::new(&exe).exists() {
        return Err(Error::Other(format!(
            "Uninstaller not found on disk: {exe}"
        )));
    }

    let exe_wide: Vec<u16> = OsStr::new(&exe)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb_wide: Vec<u16> = OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let params_wide: Vec<u16> = OsStr::new(&args)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let params_ptr = if args.is_empty() {
        std::ptr::null()
    } else {
        params_wide.as_ptr()
    };

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
            exe_wide.as_ptr(),
            params_ptr,
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if rc > 32 {
        tracing::info!("app_uninstaller: spawned {} (args=\"{}\")", exe, args);
        Ok(())
    } else {
        Err(Error::Other(format!(
            "ShellExecuteW failed (code {rc}) for {exe}"
        )))
    }
}

#[cfg(not(windows))]
pub fn launch(_info: &UninstallInfo) -> Result<()> {
    Err(Error::Invalid(
        "uninstall only supported on Windows".into(),
    ))
}

/// Split an `UninstallString` registry value into (executable, args). Handles
/// the common `"<quoted path>" <args>` and bare `<unquoted path>` shapes.
fn split_uninstall_string(raw: &str) -> (String, String) {
    let s = raw.trim();
    if let Some(stripped) = s.strip_prefix('"') {
        if let Some(end) = stripped.find('"') {
            let exe = stripped[..end].to_string();
            let args = stripped[end + 1..].trim().to_string();
            return (exe, args);
        }
    }
    // No quotes — assume the whole thing is the path (NSIS's default
    // UninstallString is just `<install>\uninstall.exe` without args).
    (s.to_string(), String::new())
}

//! Windows toast notifications need a registered AppUserModelID to actually
//! show up. For an unbundled / not-installed binary, Windows accepts the toast
//! call silently and drops it on the floor — the user sees nothing.
//!
//! We work around this on startup by:
//!   1. Writing a minimal HKCU entry for the AUMID (`DisplayName` + `IconUri`),
//!      which is enough for Windows 10+ to treat it as a valid Toast app.
//!   2. Calling `SetCurrentProcessExplicitAppUserModelID` so any toast emitted
//!      by this process is routed under that AUMID.
//!
//! The registry entry lives under HKCU so no admin rights are needed; it's
//! tiny and easy to remove by hand if the user wants to unwind.

#[cfg(windows)]
pub fn register_aumid(aumid: &str, display_name: &str) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    if aumid.is_empty() {
        tracing::warn!("register_aumid: empty AUMID, skipping");
        return;
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!("Software\\Classes\\AppUserModelId\\{}", aumid);
    match hkcu.create_subkey(&path) {
        Ok((key, _disp)) => {
            if let Err(e) = key.set_value("DisplayName", &display_name.to_string()) {
                tracing::warn!("AUMID DisplayName write failed: {}", e);
            }
            if let Ok(exe) = std::env::current_exe() {
                // Windows accepts a path to an .exe or .ico for IconUri and
                // will extract the embedded icon from the .exe.
                let s = exe.to_string_lossy().to_string();
                if let Err(e) = key.set_value("IconUri", &s) {
                    tracing::warn!("AUMID IconUri write failed: {}", e);
                }
                // Newer Windows versions also look at IconBackgroundColor for
                // Action Center theming; we leave it unset (defaults to the
                // accent color).
            }
            tracing::info!("registered AUMID '{}' under HKCU", aumid);
        }
        Err(e) => {
            tracing::warn!("AUMID registration failed for '{}': {}", aumid, e);
            return;
        }
    }

    set_process_aumid(aumid);
}

#[cfg(windows)]
fn set_process_aumid(aumid: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = OsStr::new(aumid)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // `SetCurrentProcessExplicitAppUserModelID` is a shell32 export. Declared
    // inline so we don't have to pull in the `windows` crate just for one call.
    #[link(name = "shell32")]
    extern "system" {
        fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
    }

    let hr = unsafe { SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
    if hr < 0 {
        tracing::warn!(
            "SetCurrentProcessExplicitAppUserModelID failed: HRESULT={:#x}",
            hr
        );
    } else {
        tracing::debug!("process AUMID bound to '{}'", aumid);
    }
}

#[cfg(not(windows))]
pub fn register_aumid(_aumid: &str, _display_name: &str) {}

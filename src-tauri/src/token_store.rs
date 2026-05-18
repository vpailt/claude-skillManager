//! Secure storage for the GitHub Personal Access Token.
//!
//! On Windows the token lives in the OS credential vault (Credential Manager,
//! DPAPI-encrypted) under service `SkillManager` / account `github.token`.
//! Outside Windows (dev only) we keep an in-memory shim that returns whatever
//! was last `save()`d in this process — the production target is Windows.
//!
//! Empty strings are treated as "no token": `save("")` deletes the entry.

use crate::error::{Error, Result};

const SERVICE: &str = "SkillManager";
const ACCOUNT: &str = "github.token";

#[cfg(windows)]
fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| Error::Other(format!("keyring open failed: {e}")))
}

/// Read the stored token. Returns `Ok(None)` when no token has ever been
/// saved, `Ok(Some(_))` otherwise. Hard errors (e.g. vault locked) bubble up.
#[cfg(windows)]
pub fn load() -> Result<Option<String>> {
    let e = entry()?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(Error::Other(format!("keyring read failed: {err}"))),
    }
}

/// Store the token. An empty token deletes the entry so we never persist an
/// empty placeholder.
#[cfg(windows)]
pub fn save(token: &str) -> Result<()> {
    let e = entry()?;
    if token.is_empty() {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(Error::Other(format!("keyring delete failed: {err}"))),
        }
    } else {
        e.set_password(token)
            .map_err(|err| Error::Other(format!("keyring write failed: {err}")))
    }
}

// ---------------- non-Windows fallback (dev only) ----------------

#[cfg(not(windows))]
use std::sync::Mutex;
#[cfg(not(windows))]
static MEM: Mutex<Option<String>> = Mutex::new(None);

#[cfg(not(windows))]
pub fn load() -> Result<Option<String>> {
    Ok(MEM.lock().unwrap().clone())
}

#[cfg(not(windows))]
pub fn save(token: &str) -> Result<()> {
    let mut g = MEM.lock().unwrap();
    *g = if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    };
    Ok(())
}

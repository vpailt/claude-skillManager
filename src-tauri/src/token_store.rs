//! Secure storage for forge access tokens.
//!
//! On Windows tokens live in the OS credential vault (Credential Manager,
//! DPAPI-encrypted) under service `SkillManager`. Two account shapes are used:
//!
//! * `github.token` — the single GitHub Personal Access Token (unchanged from
//!   the original single-provider design).
//! * `gitea:<host>` — one token per self-hosted Gitea instance, keyed by bare
//!   host (e.g. `gitea:git.almaviacx.local`). Supporting both providers at once
//!   means GitHub and each Gitea host hold independent credentials.
//!
//! Outside Windows (dev only) an in-memory map stands in for the vault.
//!
//! Empty strings mean "no token": saving `""` deletes the entry.

use crate::error::{Error, Result};

const SERVICE: &str = "SkillManager";
const GITHUB_ACCOUNT: &str = "github.token";

/// Credential-vault account name for a Gitea instance's token.
fn gitea_account(host: &str) -> String {
    format!("gitea:{}", host.trim())
}

// ---------------- Windows: real credential vault ----------------

#[cfg(windows)]
fn entry(account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, account)
        .map_err(|e| Error::Other(format!("keyring open failed: {e}")))
}

#[cfg(windows)]
fn load_account(account: &str) -> Result<Option<String>> {
    let e = entry(account)?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(Error::Other(format!("keyring read failed: {err}"))),
    }
}

#[cfg(windows)]
fn save_account(account: &str, token: &str) -> Result<()> {
    let e = entry(account)?;
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
use std::collections::HashMap;
#[cfg(not(windows))]
use std::sync::Mutex;
#[cfg(not(windows))]
static MEM: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

#[cfg(not(windows))]
fn load_account(account: &str) -> Result<Option<String>> {
    let g = MEM.lock().unwrap();
    Ok(g.as_ref().and_then(|m| m.get(account).cloned()))
}

#[cfg(not(windows))]
fn save_account(account: &str, token: &str) -> Result<()> {
    let mut g = MEM.lock().unwrap();
    let map = g.get_or_insert_with(HashMap::new);
    if token.is_empty() {
        map.remove(account);
    } else {
        map.insert(account.to_string(), token.to_string());
    }
    Ok(())
}

// ---------------- public API ----------------

/// Read the GitHub token. `Ok(None)` when none was ever saved.
pub fn load() -> Result<Option<String>> {
    load_account(GITHUB_ACCOUNT)
}

/// Store the GitHub token. An empty token deletes the entry.
pub fn save(token: &str) -> Result<()> {
    save_account(GITHUB_ACCOUNT, token)
}

/// Read the token for a Gitea instance, keyed by bare host.
pub fn load_host(host: &str) -> Result<Option<String>> {
    if host.trim().is_empty() {
        return Ok(None);
    }
    load_account(&gitea_account(host))
}

/// Store the token for a Gitea instance. An empty token deletes the entry.
pub fn save_host(host: &str, token: &str) -> Result<()> {
    if host.trim().is_empty() {
        return Err(Error::Invalid("Gitea host is required to store a token.".into()));
    }
    save_account(&gitea_account(host), token)
}

//! Install / uninstall marketplaces — port of src/marketplace_installer.py.

use crate::config;
use crate::error::{Error, Result};
use crate::github_client::GitHubClient;
use crate::installer::{atomic_write_json, now_iso, rmtree_robust};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

pub fn known_marketplaces_dir() -> PathBuf {
    config::claude_plugins_dir().join("marketplaces")
}

fn load_known() -> Map<String, Value> {
    let f = config::known_marketplaces_file();
    if !f.exists() {
        return Map::new();
    }
    fs::read_to_string(&f)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn save_known(data: &Map<String, Value>) -> Result<()> {
    atomic_write_json(&config::known_marketplaces_file(), &Value::Object(data.clone()))
}

pub fn is_marketplace_installed(name: &str) -> bool {
    load_known().contains_key(name)
}

pub fn get_install_info(name: &str) -> Value {
    load_known().get(name).cloned().unwrap_or(Value::Null)
}

pub fn install_marketplace(
    gh: &GitHubClient,
    name: &str,
    repo: &str,
    r#ref: &str,
    auto_update: Option<bool>,
) -> Result<PathBuf> {
    if name.is_empty() {
        return Err(Error::Invalid("Marketplace name is required.".into()));
    }
    if repo.is_empty() {
        return Err(Error::Invalid(format!(
            "Marketplace '{name}' has no GitHub repo configured."
        )));
    }
    let r#ref = if r#ref.is_empty() {
        gh.get_default_branch(repo)?
    } else {
        r#ref.to_string()
    };
    let install_path = known_marketplaces_dir().join(name);
    let zip_bytes = gh.download_zipball(repo, &r#ref)?;
    rmtree_robust(&install_path)?;
    fs::create_dir_all(&install_path)?;
    GitHubClient::extract_zipball(&zip_bytes, &install_path, "")?;

    let sha = gh
        .get_latest_commit(repo, &r#ref)
        .ok()
        .and_then(|v| v.get("sha").and_then(|s| s.as_str()).map(String::from))
        .unwrap_or_default();

    let mut data = load_known();
    let existing = data
        .get(name)
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut record = json!({
        "source": {"source": "github", "repo": repo},
        "installLocation": install_path.to_string_lossy(),
        "lastUpdated": now_iso(),
    });
    if !sha.is_empty() {
        record["gitCommitSha"] = json!(sha);
    }
    let auto = match auto_update {
        Some(v) => v,
        None => existing
            .get("autoUpdate")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    };
    record["autoUpdate"] = json!(auto);
    data.insert(name.to_string(), record);
    save_known(&data)?;
    Ok(install_path)
}

pub fn set_auto_update(name: &str, value: bool) -> Result<bool> {
    let mut data = load_known();
    let Some(Value::Object(mut info)) = data.remove(name) else {
        return Ok(false);
    };
    info.insert("autoUpdate".into(), json!(value));
    data.insert(name.to_string(), Value::Object(info));
    save_known(&data)?;
    Ok(true)
}

pub fn auto_update_if_changed(
    gh: &GitHubClient,
    name: &str,
    repo: &str,
    r#ref: &str,
) -> (bool, String) {
    if repo.is_empty() {
        return (false, "no repo".into());
    }
    let r#ref = if r#ref.is_empty() {
        gh.get_default_branch(repo).unwrap_or_else(|_| "main".into())
    } else {
        r#ref.to_string()
    };
    let info = get_install_info(name);
    let stored = info
        .get("gitCommitSha")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let latest = match gh.get_latest_commit(repo, &r#ref) {
        Ok(v) => v
            .get("sha")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
        Err(e) => return (false, format!("check failed: {e}")),
    };
    if !stored.is_empty() && !latest.is_empty() && stored == latest {
        return (false, "up to date".into());
    }
    match install_marketplace(gh, name, repo, &r#ref, None) {
        Ok(_) => (true, if latest.is_empty() { "updated".into() } else { latest }),
        Err(e) => (false, format!("install failed: {e}")),
    }
}

pub fn uninstall_marketplace(name: &str) -> Result<()> {
    let mut data = load_known();
    let info = data.remove(name);
    if info.is_some() {
        save_known(&data)?;
    }
    let install_path = info
        .as_ref()
        .and_then(|v| v.get("installLocation"))
        .and_then(|v| v.as_str())
        .map(PathBuf::from);
    match install_path {
        Some(p) => {
            let _ = rmtree_robust(&p);
        }
        None => {
            let _ = rmtree_robust(&known_marketplaces_dir().join(name));
        }
    }
    Ok(())
}

//! Install / update / uninstall plugins — port of src/installer.py.

use crate::config;
use crate::error::{Error, Result};
use crate::github_client::{long_path, GitHubClient};
use crate::models::Plugin;
use crate::plugin_state;
use chrono::Utc;
use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Remove a directory tree even when paths exceed Windows MAX_PATH or files are read-only.
pub fn rmtree_robust(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let target = long_path(path);
    // Walk and chmod read-only files before letting remove_dir_all do its job.
    for entry in walkdir::WalkDir::new(&target)
        .contents_first(true)
        .into_iter()
        .flatten()
    {
        let p = entry.path();
        if let Ok(meta) = p.metadata() {
            let mut perms = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(p, perms);
        }
    }
    fs::remove_dir_all(&target).map_err(Error::from)?;
    Ok(())
}

pub fn atomic_write_json(path: &Path, data: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("json")
    ));
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)?;
    f.write_all(serde_json::to_string_pretty(data)?.as_bytes())?;
    drop(f);
    fs::rename(&tmp, path)?;
    Ok(())
}

fn load_installed() -> Value {
    let f = config::installed_plugins_file();
    if !f.exists() {
        return json!({"version": 2, "plugins": {}});
    }
    fs::read_to_string(&f)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({"version": 2, "plugins": {}}))
}

fn save_installed(data: &Value) -> Result<()> {
    atomic_write_json(&config::installed_plugins_file(), data)
}

pub fn now_iso() -> String {
    let now = Utc::now();
    // Match Python: %Y-%m-%dT%H:%M:%S.<ms>Z
    now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn cache_path(marketplace: &str, plugin: &str, version: &str) -> PathBuf {
    config::plugins_cache_dir().join(marketplace).join(plugin).join(version)
}

pub fn install_plugin(gh: &GitHubClient, plugin: &Plugin) -> Result<PathBuf> {
    tracing::info!(
        "install_plugin: {} from {} (marketplace={})",
        plugin.name,
        plugin
            .source
            .as_ref()
            .map(|s| s.repo.as_str())
            .unwrap_or("?"),
        plugin.marketplace_name
    );
    let src = plugin
        .source
        .as_ref()
        .ok_or_else(|| {
            tracing::error!("plugin {} has no source", plugin.name);
            Error::Invalid(format!("Plugin {} has no source.", plugin.name))
        })?;
    let version = plugin
        .latest_version
        .clone()
        .or_else(|| Some(src.r#ref.clone()))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "0.0.0".to_string());

    if !src.repo.is_empty() {
        let r#ref = if src.r#ref.is_empty() {
            gh.get_default_branch(&src.repo)?
        } else {
            src.r#ref.clone()
        };
        return install_from_github(
            gh,
            &src.repo,
            &plugin.marketplace_name,
            &plugin.name,
            &version,
            &r#ref,
        );
    }
    if src.kind == "directory" && !src.path.is_empty() {
        return install_from_directory(
            Path::new(&src.path),
            &plugin.marketplace_name,
            &plugin.name,
            &version,
        );
    }
    Err(Error::Invalid(format!(
        "Plugin {}: unsupported source ({}: {})",
        plugin.name,
        src.kind,
        if !src.url.is_empty() { &src.url } else { &src.path }
    )))
}

fn install_from_github(
    gh: &GitHubClient,
    repo: &str,
    marketplace_name: &str,
    plugin_name: &str,
    version: &str,
    r#ref: &str,
) -> Result<PathBuf> {
    let zip_bytes = gh.download_zipball(repo, r#ref)?;
    let install_path = cache_path(marketplace_name, plugin_name, version);
    rmtree_robust(&install_path)?;
    fs::create_dir_all(&install_path)?;
    GitHubClient::extract_zipball(&zip_bytes, &install_path, "")?;

    let sha = gh
        .get_latest_commit(repo, r#ref)
        .ok()
        .and_then(|v| v.get("sha").and_then(|s| s.as_str()).map(String::from))
        .unwrap_or_else(|| {
            if r#ref.len() == 40 {
                r#ref.to_string()
            } else {
                String::new()
            }
        });

    register_install(marketplace_name, plugin_name, version, &install_path, &sha)?;
    Ok(install_path)
}

fn install_from_directory(
    source_dir: &Path,
    marketplace_name: &str,
    plugin_name: &str,
    version: &str,
) -> Result<PathBuf> {
    let install_path = cache_path(marketplace_name, plugin_name, version);
    rmtree_robust(&install_path)?;
    copy_dir_all(source_dir, &install_path)?;
    register_install(marketplace_name, plugin_name, version, &install_path, "")?;
    Ok(install_path)
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn register_install(
    marketplace_name: &str,
    plugin_name: &str,
    version: &str,
    install_path: &Path,
    git_sha: &str,
) -> Result<()> {
    let mut data = load_installed();
    let plugins = data
        .as_object_mut()
        .unwrap()
        .entry("plugins".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let plugins_obj = plugins.as_object_mut().unwrap();
    let key = format!("{plugin_name}@{marketplace_name}");
    let mut record = json!({
        "scope": "user",
        "installPath": install_path.to_string_lossy(),
        "version": version,
        "installedAt": now_iso(),
        "lastUpdated": now_iso(),
    });
    if !git_sha.is_empty() {
        record["gitCommitSha"] = json!(git_sha);
    }
    plugins_obj.insert(key, json!([record]));
    let obj = data.as_object_mut().unwrap();
    if !obj.contains_key("version") {
        obj.insert("version".to_string(), json!(2));
    }
    save_installed(&data)?;
    if plugin_state::get_enabled(plugin_name, marketplace_name).is_none() {
        plugin_state::set_enabled(plugin_name, marketplace_name, true)?;
    }
    Ok(())
}

pub fn uninstall(plugin: &Plugin) -> Result<()> {
    tracing::info!(
        "uninstall_plugin: {} (marketplace={})",
        plugin.name,
        plugin.marketplace_name
    );
    let mut data = load_installed();
    let key = format!("{}@{}", plugin.name, plugin.marketplace_name);
    let mut changed = false;
    if let Some(plugins) = data.as_object_mut().and_then(|d| d.get_mut("plugins")) {
        if let Some(obj) = plugins.as_object_mut() {
            if obj.remove(&key).is_some() {
                changed = true;
            }
        }
    }
    if changed {
        save_installed(&data)?;
    }
    if let Some(p) = &plugin.install_path {
        if p.exists() {
            rmtree_robust(p)?;
        }
    }
    plugin_state::remove_entry(&plugin.name, &plugin.marketplace_name)?;
    Ok(())
}


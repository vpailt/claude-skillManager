//! Read/write the `enabledPlugins` map in ~/.claude/settings.json.
//!
//! Port of src/plugin_state.py. Uses serde_json::Value so we never lose any
//! unknown top-level keys (hooks, theme, etc.) when patching the file.

use crate::config;
use crate::error::{Error, Result};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

fn settings_path() -> PathBuf {
    config::claude_home().join("settings.json")
}

fn read_all() -> Map<String, Value> {
    let p = settings_path();
    if !p.exists() {
        return Map::new();
    }
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Like `read_all`, but an unreadable or malformed file is an error, not an
/// empty map. Use it before any rewrite that is not a pure `enabledPlugins`
/// toggle: writing back an empty map would wipe the user's hooks, theme and
/// permissions.
pub fn read_settings_strict() -> Result<Map<String, Value>> {
    let p = settings_path();
    if !p.exists() {
        return Ok(Map::new());
    }
    let text = fs::read_to_string(&p)?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(Error::Invalid(format!(
            "{} n'est pas un objet JSON",
            p.display()
        ))),
        Err(e) => Err(Error::Invalid(format!(
            "{} illisible, rien n'a été modifié : {e}",
            p.display()
        ))),
    }
}

pub fn write_settings(data: &Map<String, Value>) -> Result<()> {
    atomic_write(data)
}

fn atomic_write(data: &Map<String, Value>) -> Result<()> {
    let p = settings_path();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(Error::from)?;
    }
    let tmp = p.with_extension(format!(
        "{}.tmp",
        p.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    fs::write(&tmp, serde_json::to_string_pretty(&Value::Object(data.clone()))?)?;
    fs::rename(&tmp, &p)?;
    Ok(())
}

fn key(plugin: &str, marketplace: &str) -> String {
    format!("{plugin}@{marketplace}")
}

pub fn load_enabled_plugins() -> BTreeMap<String, bool> {
    let data = read_all();
    let mut out = BTreeMap::new();
    if let Some(Value::Object(map)) = data.get("enabledPlugins") {
        for (k, v) in map {
            if let Some(b) = v.as_bool() {
                out.insert(k.clone(), b);
            }
        }
    }
    out
}

pub fn get_enabled(plugin: &str, marketplace: &str) -> Option<bool> {
    load_enabled_plugins().get(&key(plugin, marketplace)).copied()
}

pub fn set_enabled(plugin: &str, marketplace: &str, value: bool) -> Result<()> {
    let mut data = read_all();
    let mut enabled = match data.remove("enabledPlugins") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    enabled.insert(key(plugin, marketplace), json!(value));
    data.insert("enabledPlugins".to_string(), Value::Object(enabled));
    atomic_write(&data)
}

pub fn remove_entry(plugin: &str, marketplace: &str) -> Result<()> {
    let mut data = read_all();
    let mut enabled = match data.remove("enabledPlugins") {
        Some(Value::Object(m)) => m,
        _ => return Ok(()),
    };
    enabled.remove(&key(plugin, marketplace));
    data.insert("enabledPlugins".to_string(), Value::Object(enabled));
    atomic_write(&data)
}

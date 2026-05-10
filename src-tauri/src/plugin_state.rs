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

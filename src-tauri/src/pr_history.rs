//! Rolling list of admin-opened PRs — port of src/pr_history.py.

use crate::config;
use crate::error::{Error, Result};
use crate::github_client::Provider;
use crate::installer::{atomic_write_json, now_iso};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

const HISTORY_FILE_NAME: &str = "pr_history.json";
const MAX_ENTRIES: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PRRecord {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub branch: String,
    pub url: String,
    pub created_at: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub kind: String,
    /// Forge that hosts this PR. Absent (old records) → GitHub. Lets a later
    /// status refresh target the right instance.
    #[serde(default)]
    pub provider: Provider,
    /// Gitea instance root for Gitea PRs; empty for GitHub.
    #[serde(default)]
    pub base_url: String,
}

fn default_status() -> String {
    "open".into()
}

fn file() -> PathBuf {
    config::app_settings_dir().join(HISTORY_FILE_NAME)
}

pub fn load_all() -> Vec<PRRecord> {
    let f = file();
    if !f.exists() {
        return Vec::new();
    }
    fs::read_to_string(&f)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<PRRecord>>(&s).ok())
        .unwrap_or_default()
}

fn save_all(items: &[PRRecord]) -> Result<()> {
    let f = file();
    if let Some(parent) = f.parent() {
        fs::create_dir_all(parent).map_err(Error::from)?;
    }
    let value = serde_json::to_value(items)?;
    atomic_write_json(&f, &value)
}

pub fn add(mut record: PRRecord) -> Result<()> {
    if record.created_at.is_empty() {
        record.created_at = now_iso();
    }
    let mut items = load_all();
    items.retain(|it| !(it.repo == record.repo && it.number == record.number));
    items.push(record);
    if items.len() > MAX_ENTRIES {
        items.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        let drop = items.len() - MAX_ENTRIES;
        items.drain(0..drop);
    }
    save_all(&items)
}

pub fn update_status(repo: &str, number: i64, status: &str) -> Result<()> {
    let mut items = load_all();
    let mut changed = false;
    for it in items.iter_mut() {
        if it.repo == repo && it.number == number {
            if it.status != status {
                it.status = status.to_string();
                changed = true;
            }
            break;
        }
    }
    if changed {
        save_all(&items)?;
    }
    Ok(())
}

pub fn remove(repo: &str, number: i64) -> Result<()> {
    let items = load_all();
    let before = items.len();
    let kept: Vec<PRRecord> = items
        .into_iter()
        .filter(|it| !(it.repo == repo && it.number == number))
        .collect();
    if kept.len() != before {
        save_all(&kept)?;
    }
    Ok(())
}

pub fn clear_all() -> Result<()> {
    save_all(&[])
}

// Allow `serde_json::Value::from(record)` callers to round-trip through Value.
impl From<PRRecord> for Value {
    fn from(r: PRRecord) -> Self {
        serde_json::to_value(r).unwrap_or(Value::Null)
    }
}

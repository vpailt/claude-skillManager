//! Short-lived "pending PR" state — port of src/pending_prs.py.

use crate::config;
use crate::error::{Error, Result};
use crate::installer::{atomic_write_json, now_iso};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const PENDING_FILE_NAME: &str = "pending_prs.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingPR {
    pub marketplace_name: String,
    pub plugin_name: String,
    /// "add" | "bump" | "remove" | "add-skill" | "update-skill" | "delete-skill"
    pub action: String,
    pub pr_url: String,
    pub pr_number: i64,
    pub branch: String,
    pub target_repo: String,
    #[serde(default)]
    pub new_version: String,
    #[serde(default)]
    pub plugin_source_repo: String,
    /// Set for skill-scoped PRs (add-skill / update-skill / delete-skill). Lets
    /// the Skills UI tag the row currently under review.
    #[serde(default)]
    pub skill_name: String,
    #[serde(default)]
    pub created_at: String,
}

fn file() -> PathBuf {
    config::app_settings_dir().join(PENDING_FILE_NAME)
}

pub fn load_all() -> Vec<PendingPR> {
    let f = file();
    if !f.exists() {
        return Vec::new();
    }
    fs::read_to_string(&f)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<PendingPR>>(&s).ok())
        .unwrap_or_default()
}

pub fn save_all(items: &[PendingPR]) -> Result<()> {
    let f = file();
    if let Some(parent) = f.parent() {
        fs::create_dir_all(parent).map_err(Error::from)?;
    }
    let value = serde_json::to_value(items)?;
    atomic_write_json(&f, &value)
}

pub fn for_marketplace(name: &str) -> Vec<PendingPR> {
    load_all()
        .into_iter()
        .filter(|p| p.marketplace_name == name)
        .collect()
}

pub fn find(marketplace_name: &str, plugin_name: &str) -> Option<PendingPR> {
    load_all().into_iter().find(|p| {
        p.marketplace_name == marketplace_name && p.plugin_name == plugin_name
    })
}

pub fn upsert(mut item: PendingPR) -> Result<()> {
    if item.created_at.is_empty() {
        item.created_at = now_iso();
    }
    let mut items = load_all();
    items.retain(|p| {
        // Skill-scoped actions can coexist on the same plugin (e.g. delete on
        // skill A + update on skill B), so the de-dup key includes skill_name.
        !(p.marketplace_name == item.marketplace_name
            && p.plugin_name == item.plugin_name
            && p.action == item.action
            && p.skill_name == item.skill_name)
    });
    items.push(item);
    save_all(&items)
}

pub fn remove(marketplace_name: &str, plugin_name: &str, action: &str) -> Result<()> {
    let items = load_all();
    let before = items.len();
    let kept: Vec<PendingPR> = items
        .into_iter()
        .filter(|p| {
            if p.marketplace_name == marketplace_name && p.plugin_name == plugin_name {
                !(action.is_empty() || p.action == action)
            } else {
                true
            }
        })
        .collect();
    if kept.len() != before {
        save_all(&kept)?;
    }
    Ok(())
}

/// Removes any pending PR record matching the given (target_repo, pr_number).
/// Called from the PR status refresher so merged/closed PRs stop appearing as
/// "in review" on the Admin tab.
pub fn remove_by_pr(target_repo: &str, pr_number: i64) -> Result<()> {
    let items = load_all();
    let before = items.len();
    let kept: Vec<PendingPR> = items
        .into_iter()
        .filter(|p| !(p.target_repo == target_repo && p.pr_number == pr_number))
        .collect();
    if kept.len() != before {
        save_all(&kept)?;
    }
    Ok(())
}

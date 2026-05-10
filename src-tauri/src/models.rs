//! Domain types — port of src/models.py.
//!
//! Every struct derives Serialize/Deserialize so it crosses the Tauri IPC boundary
//! cleanly. `serde(rename_all = "camelCase")` mirrors the JS-friendly shape
//! used by the React frontend; the Python originals used snake_case fields
//! mapped to JSON via `dataclasses.asdict()`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallState {
    NotInstalled,
    Installed,
    Outdated,
    LocalOnly,
    Unknown,
}

impl Default for InstallState {
    fn default() -> Self {
        InstallState::Unknown
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub folder: Option<PathBuf>,
    #[serde(default, rename = "skillMdPath")]
    pub skill_md_path: Option<PathBuf>,
    #[serde(default)]
    pub relative_path: String,
    #[serde(default)]
    pub plugin_name: Option<String>,
    #[serde(default)]
    pub marketplace_name: Option<String>,
    #[serde(default)]
    pub remote_present: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSource {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub r#ref: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    pub name: String,
    pub marketplace_name: String,
    #[serde(default)]
    pub installed_version: Option<String>,
    #[serde(default)]
    pub latest_version: Option<String>,
    #[serde(default)]
    pub install_path: Option<PathBuf>,
    #[serde(default)]
    pub git_commit_sha: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub skills: Vec<Skill>,
    #[serde(default)]
    pub remote_present: bool,
    #[serde(default)]
    pub install_state: InstallState,
    #[serde(default)]
    pub manifest: Option<serde_json::Value>,
    #[serde(default)]
    pub source: Option<PluginSource>,
    /// None = no entry in `enabledPlugins` (Claude Code treats as disabled).
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub last_updated: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    pub name: String,
    pub source_kind: String,
    #[serde(default)]
    pub source_repo: String,
    #[serde(default)]
    pub source_path: String,
    #[serde(default)]
    pub install_location: String,
    #[serde(default)]
    pub plugins: Vec<Plugin>,
    #[serde(default)]
    pub owned: bool,
    #[serde(default)]
    pub editable: bool,
    #[serde(default)]
    pub remote_browseable: bool,
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub last_updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkill {
    pub name: String,
    pub folder: PathBuf,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    pub path: PathBuf,
    pub is_dir: bool,
    pub skill_name: String,
    #[serde(default)]
    pub plugin_name: Option<String>,
    #[serde(default)]
    pub marketplace_name: Option<String>,
}

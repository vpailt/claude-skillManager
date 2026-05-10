//! Paths and persisted user settings — port of src/config.py.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub fn claude_home() -> PathBuf {
    // %USERPROFILE%/.claude on Windows, $HOME/.claude elsewhere.
    let base = if cfg!(windows) {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    };
    base.unwrap_or_else(|| PathBuf::from(".")).join(".claude")
}

pub fn claude_plugins_dir() -> PathBuf {
    claude_home().join("plugins")
}

pub fn claude_user_skills_dir() -> PathBuf {
    claude_home().join("skills")
}

pub fn installed_plugins_file() -> PathBuf {
    claude_plugins_dir().join("installed_plugins.json")
}

pub fn known_marketplaces_file() -> PathBuf {
    claude_plugins_dir().join("known_marketplaces.json")
}

pub fn plugins_cache_dir() -> PathBuf {
    claude_plugins_dir().join("cache")
}

/// `%APPDATA%/SkillManager` on Windows, `~/Library/Application Support/SkillManager` on macOS,
/// `~/.config/SkillManager` on Linux. Always created.
pub fn app_settings_dir() -> PathBuf {
    let dir = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs_home().join("AppData").join("Roaming"))
            .join("SkillManager")
    } else if cfg!(target_os = "macos") {
        dirs_home().join("Library/Application Support/SkillManager")
    } else {
        dirs_home().join(".config/SkillManager")
    };
    let _ = fs::create_dir_all(&dir);
    dir
}

fn dirs_home() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    .unwrap_or_else(|| PathBuf::from("."))
}

pub fn settings_file() -> PathBuf {
    app_settings_dir().join("settings.json")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceConfig {
    pub name: String,
    #[serde(default)]
    pub github_repo: String,
    #[serde(default = "default_branch")]
    pub default_branch: String,
    #[serde(default)]
    pub owned: bool,
    #[serde(default)]
    pub source_path: String,
    #[serde(default)]
    pub auto_update: bool,
}

fn default_branch() -> String {
    "main".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub github_token: String,
    #[serde(default)]
    pub marketplaces: Vec<MarketplaceConfig>,
}

impl Settings {
    pub fn get_marketplace(&self, name: &str) -> Option<&MarketplaceConfig> {
        self.marketplaces.iter().find(|m| m.name == name)
    }
}

pub fn load_settings() -> Settings {
    let f = settings_file();
    if !f.exists() {
        return Settings::default();
    }
    fs::read_to_string(&f)
        .ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(s: &Settings) -> Result<()> {
    let f = settings_file();
    if let Some(parent) = f.parent() {
        fs::create_dir_all(parent).map_err(Error::from)?;
    }
    let payload = serde_json::to_string_pretty(s).map_err(Error::from)?;
    fs::write(&f, payload).map_err(Error::from)?;
    Ok(())
}

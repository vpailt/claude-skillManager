//! Paths and persisted user settings.
//!
//! Portable layout (sits next to skillmanager.exe):
//!
//! ```text
//! SkillManager/
//! ├── skillmanager.exe
//! ├── config/
//! │   ├── config.properties     ← scalar settings (token, polling, UI)
//! │   ├── logging.properties    ← logger configuration
//! │   ├── marketplaces.json     ← registered marketplaces (list)
//! │   ├── pr_history.json       ← rolling list of admin-opened PRs
//! │   └── pending_prs.json      ← drafts awaiting merge
//! └── logs/
//!     └── skillmanager.YYYY-MM-DD.log
//! ```
//!
//! On first run, if a legacy `%APPDATA%/SkillManager/settings.json` exists,
//! we migrate it into the portable layout.

use crate::error::{Error, Result};
use crate::properties::{write_atomic, Properties};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

// ============================================================
// Paths
// ============================================================

pub fn claude_home() -> PathBuf {
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

pub fn claude_skills_archive_dir() -> PathBuf {
    claude_home().join("skills_archive")
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

/// Directory containing the running `skillmanager.exe`. In dev (`cargo tauri
/// dev`) this is `target/debug/`. Falls back to the current working directory.
pub fn exe_dir() -> PathBuf {
    static CACHE: OnceLock<PathBuf> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(PathBuf::from))
                .unwrap_or_else(|| PathBuf::from("."))
        })
        .clone()
}

/// `<exe_dir>/config`. Always created on first access.
pub fn app_settings_dir() -> PathBuf {
    let dir = exe_dir().join("config");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// `<exe_dir>/logs`. Always created on first access.
pub fn logs_dir() -> PathBuf {
    let dir = exe_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn config_properties_file() -> PathBuf {
    app_settings_dir().join("config.properties")
}

pub fn logging_properties_file() -> PathBuf {
    app_settings_dir().join("logging.properties")
}

pub fn marketplaces_file() -> PathBuf {
    app_settings_dir().join("marketplaces.json")
}

/// Legacy single-blob JSON settings file under `%APPDATA%\SkillManager`.
/// Only consulted for one-shot migration to the portable layout.
fn legacy_appdata_settings_file() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))
    }?;
    Some(base.join("SkillManager").join("settings.json"))
}

// ============================================================
// Models
// ============================================================

fn default_branch() -> String {
    "main".to_string()
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

fn default_pr_polling_interval() -> u32 {
    60
}

fn default_ui_density() -> String {
    "comfortable".to_string()
}

fn default_theme() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPrefs {
    #[serde(default)]
    pub pr_polling_enabled: bool,
    #[serde(default = "default_pr_polling_interval")]
    pub pr_polling_interval_seconds: u32,
    #[serde(default = "default_ui_density")]
    pub density: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub sidebar_collapsed: bool,
    /// Start the app hidden in the tray instead of opening the window.
    #[serde(default)]
    pub start_minimized: bool,
    /// Hide to tray when the window is closed instead of quitting.
    #[serde(default = "default_close_to_tray")]
    pub close_to_tray: bool,
    /// Whether the app may raise Windows notification-area toasts (e.g. on PR
    /// status changes). When off, only the in-app toast is shown.
    #[serde(default = "default_true")]
    pub native_notifications_enabled: bool,
}

fn default_close_to_tray() -> bool {
    true
}

fn default_true() -> bool {
    true
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            pr_polling_enabled: false,
            pr_polling_interval_seconds: default_pr_polling_interval(),
            density: default_ui_density(),
            theme: default_theme(),
            sidebar_collapsed: false,
            start_minimized: false,
            close_to_tray: true,
            native_notifications_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub github_token: String,
    #[serde(default)]
    pub marketplaces: Vec<MarketplaceConfig>,
    #[serde(default)]
    pub ui: UiPrefs,
}

impl Settings {
    pub fn get_marketplace(&self, name: &str) -> Option<&MarketplaceConfig> {
        self.marketplaces.iter().find(|m| m.name == name)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggingConfig {
    /// Whether file logging is enabled. When false, only ERROR is emitted to
    /// stderr (so we never lose crash output).
    pub enabled: bool,
    /// Minimum level written to the log file. One of ERROR, WARN, INFO,
    /// DEBUG, TRACE.
    pub level: String,
    /// Maximum size of a single log file in MB before rotation. 0 = no limit.
    pub max_file_size_mb: u32,
    /// Maximum number of rotated files to keep.
    pub max_file_count: u32,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            level: "INFO".into(),
            max_file_size_mb: 10,
            max_file_count: 5,
        }
    }
}

// ============================================================
// Settings: load / save (config.properties + marketplaces.json)
// ============================================================

const PROP_TOKEN: &str = "github.token";
const PROP_POLLING_ENABLED: &str = "polling.enabled";
const PROP_POLLING_INTERVAL: &str = "polling.interval.seconds";
const PROP_UI_THEME: &str = "ui.theme";
const PROP_UI_DENSITY: &str = "ui.density";
const PROP_UI_SIDEBAR: &str = "ui.sidebar.collapsed";
const PROP_UI_START_MINIMIZED: &str = "ui.tray.start.minimized";
const PROP_UI_CLOSE_TO_TRAY: &str = "ui.tray.close.to.tray";
const PROP_UI_NATIVE_NOTIFICATIONS: &str = "ui.notifications.native.enabled";

const PROPS_SECTIONS: &[(&str, &[&str])] = &[
    ("GitHub credentials", &["github."]),
    ("PR status polling", &["polling."]),
    ("UI preferences", &["ui."]),
];

fn settings_from_properties_and_marketplaces(
    props: &Properties,
    marketplaces: Vec<MarketplaceConfig>,
) -> Settings {
    Settings {
        github_token: props.get_or(PROP_TOKEN, ""),
        marketplaces,
        ui: UiPrefs {
            pr_polling_enabled: props.get_bool(PROP_POLLING_ENABLED, false),
            pr_polling_interval_seconds: props.get_u32(PROP_POLLING_INTERVAL, 60),
            density: props.get_or(PROP_UI_DENSITY, &default_ui_density()),
            theme: props.get_or(PROP_UI_THEME, &default_theme()),
            sidebar_collapsed: props.get_bool(PROP_UI_SIDEBAR, false),
            start_minimized: props.get_bool(PROP_UI_START_MINIMIZED, false),
            close_to_tray: props.get_bool(PROP_UI_CLOSE_TO_TRAY, true),
            native_notifications_enabled: props
                .get_bool(PROP_UI_NATIVE_NOTIFICATIONS, true),
        },
    }
}

fn settings_to_properties(s: &Settings) -> Properties {
    let mut p = Properties::new();
    p.set(PROP_TOKEN, &s.github_token);
    p.set_bool(PROP_POLLING_ENABLED, s.ui.pr_polling_enabled);
    p.set_u32(PROP_POLLING_INTERVAL, s.ui.pr_polling_interval_seconds);
    p.set(PROP_UI_THEME, &s.ui.theme);
    p.set(PROP_UI_DENSITY, &s.ui.density);
    p.set_bool(PROP_UI_SIDEBAR, s.ui.sidebar_collapsed);
    p.set_bool(PROP_UI_START_MINIMIZED, s.ui.start_minimized);
    p.set_bool(PROP_UI_CLOSE_TO_TRAY, s.ui.close_to_tray);
    p.set_bool(PROP_UI_NATIVE_NOTIFICATIONS, s.ui.native_notifications_enabled);
    p
}

fn load_marketplaces() -> Vec<MarketplaceConfig> {
    let f = marketplaces_file();
    if !f.exists() {
        return Vec::new();
    }
    fs::read_to_string(&f)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<MarketplaceConfig>>(&s).ok())
        .unwrap_or_default()
}

fn save_marketplaces(items: &[MarketplaceConfig]) -> Result<()> {
    let f = marketplaces_file();
    if let Some(parent) = f.parent() {
        fs::create_dir_all(parent).map_err(Error::from)?;
    }
    let payload = serde_json::to_string_pretty(items).map_err(Error::from)?;
    let tmp = f.with_extension("tmp");
    fs::write(&tmp, payload).map_err(Error::from)?;
    fs::rename(&tmp, &f).map_err(Error::from)?;
    Ok(())
}

/// One-shot migration: if no portable config exists but a legacy
/// `%APPDATA%/SkillManager/settings.json` does, import its contents.
fn migrate_legacy_if_needed() {
    static DONE: OnceLock<()> = OnceLock::new();
    if DONE.get().is_some() {
        return;
    }
    DONE.set(()).ok();
    if config_properties_file().exists() {
        return;
    }
    let Some(legacy) = legacy_appdata_settings_file() else {
        return;
    };
    if !legacy.exists() {
        return;
    }
    let Ok(text) = fs::read_to_string(&legacy) else {
        return;
    };
    let Ok(legacy_settings) = serde_json::from_str::<Settings>(&text) else {
        return;
    };
    let _ = save_settings(&legacy_settings);
    tracing::info!(
        "Migrated legacy settings from {} into portable layout",
        legacy.display()
    );
}

pub fn load_settings() -> Settings {
    migrate_legacy_if_needed();
    let props = Properties::load(&config_properties_file()).unwrap_or_default();
    let marketplaces = load_marketplaces();
    settings_from_properties_and_marketplaces(&props, marketplaces)
}

pub fn save_settings(s: &Settings) -> Result<()> {
    let props = settings_to_properties(s);
    let rendered = format!(
        "# SkillManager configuration\n\
         # Edit by hand or via the Settings page in the app.\n\
         # Restart the app after manual changes.\n\n{}",
        props.render_with_sections(PROPS_SECTIONS)
    );
    write_atomic(&config_properties_file(), &rendered)?;
    save_marketplaces(&s.marketplaces)?;
    Ok(())
}

// ============================================================
// Logging config: load / save (logging.properties)
// ============================================================

const LOG_ENABLED: &str = "logging.enabled";
const LOG_LEVEL: &str = "logging.level";
const LOG_MAX_SIZE: &str = "logging.file.max.size.mb";
const LOG_MAX_COUNT: &str = "logging.file.max.count";

const LOG_SECTIONS: &[(&str, &[&str])] = &[("Logging", &["logging."])];

pub fn load_logging_config() -> LoggingConfig {
    let f = logging_properties_file();
    if !f.exists() {
        let cfg = LoggingConfig::default();
        let _ = save_logging_config(&cfg);
        return cfg;
    }
    let props = Properties::load(&f).unwrap_or_default();
    let default = LoggingConfig::default();
    LoggingConfig {
        enabled: props.get_bool(LOG_ENABLED, default.enabled),
        level: props
            .get(LOG_LEVEL)
            .map(|s| s.to_ascii_uppercase())
            .unwrap_or(default.level),
        max_file_size_mb: props.get_u32(LOG_MAX_SIZE, default.max_file_size_mb),
        max_file_count: props.get_u32(LOG_MAX_COUNT, default.max_file_count),
    }
}

pub fn save_logging_config(cfg: &LoggingConfig) -> Result<()> {
    let mut p = Properties::new();
    p.set_bool(LOG_ENABLED, cfg.enabled);
    p.set(LOG_LEVEL, &cfg.level);
    p.set_u32(LOG_MAX_SIZE, cfg.max_file_size_mb);
    p.set_u32(LOG_MAX_COUNT, cfg.max_file_count);
    let rendered = format!(
        "# SkillManager logging configuration\n\
         #\n\
         # logging.enabled         — write log files under ../logs/ (true/false)\n\
         # logging.level           — ERROR | WARN | INFO | DEBUG | TRACE\n\
         # logging.file.max.size.mb — single file size cap before rotation (0 = unlimited)\n\
         # logging.file.max.count   — number of rotated files to keep\n\n{}",
        p.render_with_sections(LOG_SECTIONS)
    );
    write_atomic(&logging_properties_file(), &rendered)?;
    Ok(())
}

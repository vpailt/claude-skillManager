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
use crate::github_client::{host_of, Provider};
use crate::properties::{write_atomic, Properties};
use crate::token_store;
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

pub fn gitea_instances_file() -> PathBuf {
    app_settings_dir().join("gitea.json")
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
    /// `owner/repo` on the marketplace's host. Field name kept (`githubRepo`)
    /// for back-compat with existing `marketplaces.json`; it holds the repo
    /// path for Gitea marketplaces too.
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
    /// Track open PRs on this marketplace's repo (and its plugins' repos) in
    /// the "Suivi Marketplace" admin tab and the dashboard. Absent → off.
    #[serde(default)]
    pub track_prs: bool,
    /// Which forge hosts this marketplace. Absent → GitHub (back-compat).
    #[serde(default)]
    pub provider: Provider,
    /// Gitea instance root (e.g. `https://git.almaviacx.local`). Empty for
    /// GitHub. Identifies which [`GiteaInstance`] supplies the token + TLS mode.
    #[serde(default)]
    pub base_url: String,
}

/// A registered self-hosted Gitea instance. The token lives in the OS
/// credential vault (keyed by host), never on disk; `has_token` is recomputed
/// at load and is meaningless in `gitea.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GiteaInstance {
    /// Instance root, e.g. `https://git.almaviacx.local`.
    pub base_url: String,
    /// Skip TLS certificate verification — for internal/self-signed CAs only.
    #[serde(default)]
    pub insecure_tls: bool,
    /// Computed: whether a token is stored for this host. Not trusted on disk.
    #[serde(default)]
    pub has_token: bool,
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
    /// status changes). When off, only the in-app toast is shown. Master switch
    /// AND-ed with the per-kind flags below.
    #[serde(default = "default_true")]
    pub native_notifications_enabled: bool,
    /// Per-kind gating of native toasts (success / info / warning / error).
    /// Each defaults to on and is AND-ed with `native_notifications_enabled`,
    /// so the user can silence e.g. success toasts while keeping error toasts.
    #[serde(default = "default_true")]
    pub notify_success: bool,
    #[serde(default = "default_true")]
    pub notify_info: bool,
    #[serde(default = "default_true")]
    pub notify_warning: bool,
    #[serde(default = "default_true")]
    pub notify_error: bool,
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
            notify_success: true,
            notify_info: true,
            notify_warning: true,
            notify_error: true,
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
    pub gitea_instances: Vec<GiteaInstance>,
    #[serde(default)]
    pub ui: UiPrefs,
}

impl Settings {
    pub fn get_marketplace(&self, name: &str) -> Option<&MarketplaceConfig> {
        self.marketplaces.iter().find(|m| m.name == name)
    }

    /// The Gitea instance whose host matches `base_url`, if registered.
    pub fn get_gitea_instance(&self, base_url: &str) -> Option<&GiteaInstance> {
        let host = host_of(base_url);
        self.gitea_instances
            .iter()
            .find(|i| host_of(&i.base_url) == host)
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
const PROP_UI_NOTIFY_SUCCESS: &str = "ui.notifications.native.success";
const PROP_UI_NOTIFY_INFO: &str = "ui.notifications.native.info";
const PROP_UI_NOTIFY_WARNING: &str = "ui.notifications.native.warning";
const PROP_UI_NOTIFY_ERROR: &str = "ui.notifications.native.error";

const PROPS_SECTIONS: &[(&str, &[&str])] = &[
    ("PR status polling", &["polling."]),
    ("UI preferences", &["ui."]),
];

fn settings_from_properties_and_marketplaces(
    props: &Properties,
    marketplaces: Vec<MarketplaceConfig>,
    gitea_instances: Vec<GiteaInstance>,
    github_token: String,
) -> Settings {
    Settings {
        github_token,
        marketplaces,
        gitea_instances,
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
            notify_success: props.get_bool(PROP_UI_NOTIFY_SUCCESS, true),
            notify_info: props.get_bool(PROP_UI_NOTIFY_INFO, true),
            notify_warning: props.get_bool(PROP_UI_NOTIFY_WARNING, true),
            notify_error: props.get_bool(PROP_UI_NOTIFY_ERROR, true),
        },
    }
}

fn settings_to_properties(s: &Settings) -> Properties {
    let mut p = Properties::new();
    p.set_bool(PROP_POLLING_ENABLED, s.ui.pr_polling_enabled);
    p.set_u32(PROP_POLLING_INTERVAL, s.ui.pr_polling_interval_seconds);
    p.set(PROP_UI_THEME, &s.ui.theme);
    p.set(PROP_UI_DENSITY, &s.ui.density);
    p.set_bool(PROP_UI_SIDEBAR, s.ui.sidebar_collapsed);
    p.set_bool(PROP_UI_START_MINIMIZED, s.ui.start_minimized);
    p.set_bool(PROP_UI_CLOSE_TO_TRAY, s.ui.close_to_tray);
    p.set_bool(PROP_UI_NATIVE_NOTIFICATIONS, s.ui.native_notifications_enabled);
    p.set_bool(PROP_UI_NOTIFY_SUCCESS, s.ui.notify_success);
    p.set_bool(PROP_UI_NOTIFY_INFO, s.ui.notify_info);
    p.set_bool(PROP_UI_NOTIFY_WARNING, s.ui.notify_warning);
    p.set_bool(PROP_UI_NOTIFY_ERROR, s.ui.notify_error);
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

/// Load registered Gitea instances and stamp `has_token` from the credential
/// vault (the on-disk value is ignored — see [`GiteaInstance`]).
fn load_gitea_instances() -> Vec<GiteaInstance> {
    let f = gitea_instances_file();
    if !f.exists() {
        return Vec::new();
    }
    let mut items: Vec<GiteaInstance> = fs::read_to_string(&f)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<GiteaInstance>>(&s).ok())
        .unwrap_or_default();
    for it in items.iter_mut() {
        let host = host_of(&it.base_url);
        it.has_token = token_store::load_host(&host)
            .ok()
            .flatten()
            .is_some();
    }
    items
}

fn save_gitea_instances(items: &[GiteaInstance]) -> Result<()> {
    let f = gitea_instances_file();
    if let Some(parent) = f.parent() {
        fs::create_dir_all(parent).map_err(Error::from)?;
    }
    // Never persist the computed `has_token` as truth — zero it so a human
    // reading gitea.json isn't misled; it's recomputed from the vault on load.
    let persisted: Vec<GiteaInstance> = items
        .iter()
        .map(|i| GiteaInstance {
            base_url: i.base_url.clone(),
            insecure_tls: i.insecure_tls,
            has_token: false,
        })
        .collect();
    let payload = serde_json::to_string_pretty(&persisted).map_err(Error::from)?;
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

/// One-shot migration: if `config.properties` still carries a `github.token=…`
/// line, move it into the OS credential vault and rewrite the file without it.
/// Runs at most once per process; safe to call on every `load_settings()`.
fn migrate_token_to_keyring_if_needed(props: &Properties) -> Option<String> {
    static DONE: OnceLock<()> = OnceLock::new();
    let legacy = props.get(PROP_TOKEN).map(str::to_string);
    let Some(legacy) = legacy else {
        return None;
    };
    if legacy.is_empty() {
        // Empty placeholder: just strip it on the next save, no token to lift.
        return None;
    }
    if DONE.get().is_some() {
        return Some(legacy);
    }
    DONE.set(()).ok();
    match token_store::save(&legacy) {
        Ok(()) => {
            tracing::info!(
                "Migrated github.token from config.properties into OS credential vault"
            );
            // Rewrite the file without the token. Reuse settings_to_properties
            // which already omits the token from rendered output.
            let mut sanitized = props.clone();
            sanitized.remove(PROP_TOKEN);
            let rendered = render_config_properties(&sanitized);
            if let Err(e) = write_atomic(&config_properties_file(), &rendered) {
                tracing::warn!("could not rewrite config.properties post-migration: {e}");
            }
            Some(legacy)
        }
        Err(e) => {
            tracing::warn!(
                "could not migrate github.token to credential vault, leaving in config.properties: {e}"
            );
            Some(legacy)
        }
    }
}

fn render_config_properties(props: &Properties) -> String {
    format!(
        "# SkillManager configuration\n\
         # Edit by hand or via the Settings page in the app.\n\
         # Restart the app after manual changes.\n\
         #\n\
         # The GitHub token is stored in the OS credential vault on Windows,\n\
         # not in this file. Use the Settings page to set or clear it.\n\n{}",
        props.render_with_sections(PROPS_SECTIONS)
    )
}

pub fn load_settings() -> Settings {
    migrate_legacy_if_needed();
    let props = Properties::load(&config_properties_file()).unwrap_or_default();
    let marketplaces = load_marketplaces();
    let gitea_instances = load_gitea_instances();
    let token_from_vault = token_store::load().unwrap_or_else(|e| {
        tracing::warn!("token_store::load failed: {e}");
        None
    });
    let github_token = token_from_vault
        .or_else(|| migrate_token_to_keyring_if_needed(&props))
        .unwrap_or_default();
    settings_from_properties_and_marketplaces(&props, marketplaces, gitea_instances, github_token)
}

pub fn save_settings(s: &Settings) -> Result<()> {
    // Token persistence is handled separately via `token_store` so it never
    // touches the on-disk properties file.
    let props = settings_to_properties(s);
    let rendered = render_config_properties(&props);
    write_atomic(&config_properties_file(), &rendered)?;
    save_marketplaces(&s.marketplaces)?;
    save_gitea_instances(&s.gitea_instances)?;
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

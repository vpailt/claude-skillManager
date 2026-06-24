//! All `#[tauri::command]` handlers exposed to the frontend.
//!
//! Each command is a thin wrapper around the corresponding domain module —
//! the heavy lifting stays in installer/marketplace_*/admin/etc. so it can
//! be unit-tested without spinning up Tauri.

use crate::admin::{self, FileChange, UploadResult};
use crate::admin_drafts::{
    self, AdminDraft, BumpSuggestion, LocalSkill, RemoteSkillInfo, UploadSkillArgs,
};
use crate::app_uninstaller::{self, UninstallInfo};
use crate::app_updater::{self, AppUpdateInfo};
use crate::config::{self, GiteaInstance, LoggingConfig, MarketplaceConfig, Settings, UiPrefs};
use crate::logger;
use crate::error::Result;
use crate::frontmatter::parse_frontmatter;
use crate::github_client::{host_of, GitHubClient, Provider};
use crate::installer;
use crate::local_scanner;
use crate::marketplace_installer;
use crate::marketplace_remote;
use crate::models::{Marketplace, Plugin, Skill};
use crate::pending_prs::{self, PendingPR};
use crate::plugin_state;
use crate::pr_history::{self, PRRecord};
use crate::token_store;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

fn gh() -> Result<GitHubClient> {
    let token = config::load_settings().github_token;
    GitHubClient::new(&token)
}

/// Build a client for a self-hosted Gitea instance: token from the credential
/// vault (keyed by host), TLS mode from the registered [`GiteaInstance`].
fn gitea_client(s: &Settings, base_url: &str) -> Result<GitHubClient> {
    let insecure = s
        .get_gitea_instance(base_url)
        .map(|i| i.insecure_tls)
        .unwrap_or(false);
    let host = host_of(base_url);
    let token = token_store::load_host(&host)?.unwrap_or_default();
    GitHubClient::for_provider(Provider::Gitea, base_url, &token, insecure)
}

/// Resolve the right client for a marketplace config: Gitea → its instance,
/// anything else (or absent) → GitHub with the stored PAT.
fn client_for_cfg(s: &Settings, cfg: Option<&MarketplaceConfig>) -> Result<GitHubClient> {
    match cfg {
        Some(c) if c.provider == Provider::Gitea => gitea_client(s, &c.base_url),
        _ => GitHubClient::new(&s.github_token),
    }
}

/// Resolve the client for a marketplace by name (looks up app settings).
fn client_for_marketplace(name: &str) -> Result<GitHubClient> {
    let s = config::load_settings();
    client_for_cfg(&s, s.get_marketplace(name))
}

/// Pick the client for installing a *plugin* based on the plugin's own source
/// host — not the marketplace's. A Gitea marketplace may list a GitHub-hosted
/// plugin (or vice-versa); installing it has to hit the forge the plugin's
/// `source.url` actually points at. Falls back to the marketplace's client when
/// the source carries no usable host (e.g. a classic `{source:"github",repo}`
/// entry with no url in a GitHub marketplace).
/// Pick a client for a source identified by `url` (+ optional source `kind`):
/// `github.com` → GitHub; a url whose host matches a registered Gitea instance
/// → that instance; a classic `kind == "github"` with no usable url → GitHub.
/// Returns `None` when the source gives no host hint, so the caller can fall
/// back to the marketplace's own client.
fn client_for_source_url(s: &Settings, url: &str, kind: &str) -> Option<Result<GitHubClient>> {
    if !url.is_empty() {
        let host = host_of(url);
        if !host.is_empty() {
            if matches!(
                host.to_ascii_lowercase().as_str(),
                "github.com" | "www.github.com" | "api.github.com"
            ) {
                return Some(GitHubClient::new(&s.github_token));
            }
            if let Some(inst) = s
                .gitea_instances
                .iter()
                .find(|i| host_of(&i.base_url).eq_ignore_ascii_case(&host))
            {
                return Some(gitea_client(s, &inst.base_url));
            }
        }
    }
    if kind.eq_ignore_ascii_case("github") {
        return Some(GitHubClient::new(&s.github_token));
    }
    None
}

fn client_for_source(
    s: &Settings,
    source: Option<&crate::models::PluginSource>,
    marketplace_name: &str,
) -> Result<GitHubClient> {
    if let Some(src) = source {
        if let Some(client) = client_for_source_url(s, &src.url, &src.kind) {
            return client;
        }
    }
    client_for_cfg(s, s.get_marketplace(marketplace_name))
}

/// Run an admin operation, logging the error to the rolling log file when it
/// fails. Admin `prepare_*` failures were previously invisible (the error only
/// reached the frontend toast), which made forge-side issues — auth, wrong
/// branch, missing registry — impossible to diagnose from a shipped log.
fn logged_admin<T>(op: &str, ctx: String, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let r = f();
    if let Err(e) = &r {
        tracing::warn!("{op} {ctx} failed: {e}");
    }
    r
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub marketplaces: Vec<Marketplace>,
    pub local_only: Marketplace,
}

#[tauri::command]
pub async fn load_app_settings() -> Settings {
    config::load_settings()
}

#[tauri::command]
pub async fn save_app_settings(settings: Settings) -> Result<()> {
    config::save_settings(&settings)
}

#[tauri::command]
pub async fn refresh_all(app: AppHandle) -> Result<RefreshResult> {
    tracing::info!("refresh_all started");
    let settings = config::load_settings();

    // 1) Auto-update marketplaces flagged with `autoUpdate=true`.
    //
    // Each marketplace gets a client matching its provider (GitHub or its Gitea
    // instance). Failures here are non-fatal: the local install stays usable
    // even if the network is down. We surface them via `tracing::warn!` so they
    // show up in the log file users can attach to a bug report.
    for cfg in &settings.marketplaces {
        if !cfg.github_repo.is_empty() {
            let info = marketplace_installer::get_install_info(&cfg.name);
            let auto = info
                .get("autoUpdate")
                .and_then(|v| v.as_bool())
                .unwrap_or(cfg.auto_update);
            if auto && marketplace_installer::is_marketplace_installed(&cfg.name) {
                if let Err(e) =
                    app.emit("refresh-progress", &format!("auto-update: {}", cfg.name))
                {
                    tracing::debug!("emit refresh-progress failed (ignored): {}", e);
                }
                let gh = match client_for_cfg(&settings, Some(cfg)) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!("client init failed for {}: {}", cfg.name, e);
                        continue;
                    }
                };
                let (updated, msg) = marketplace_installer::auto_update_if_changed(
                    &gh,
                    &cfg.name,
                    &cfg.github_repo,
                    &cfg.default_branch,
                );
                if !updated && msg != "up to date" {
                    tracing::warn!("auto-update {} skipped: {}", cfg.name, msg);
                }
            }
        }
    }

    // 2) Build local marketplace list.
    let mut marketplaces = local_scanner::build_marketplaces_from_settings(&settings.marketplaces);

    // 3) For each marketplace with a github source, fetch the registry and merge.
    //
    // `fetch_marketplace_plugins` returns an empty vector on network/parse
    // failure rather than propagating — that's intentional: a stale-but-usable
    // local view beats a hard error in the refresh pipeline. We still log when
    // the merge yields zero remote plugins for a known GitHub source so a
    // diagnostic trail exists.
    for mp in marketplaces.iter_mut() {
        if mp.source_repo.is_empty() {
            continue;
        }
        if let Err(e) = app.emit("refresh-progress", &format!("fetching: {}", mp.name)) {
            tracing::debug!("emit refresh-progress failed (ignored): {}", e);
        }
        let cfg = settings.get_marketplace(&mp.name);
        let r#ref = cfg.map(|c| c.default_branch.as_str()).unwrap_or("");
        let gh = match client_for_cfg(&settings, cfg) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("client init failed for {}: {}", mp.name, e);
                continue;
            }
        };
        let remote =
            marketplace_remote::fetch_marketplace_plugins(&gh, &mp.source_repo, r#ref, &mp.name);
        if remote.is_empty() {
            tracing::warn!(
                "no remote plugins fetched for marketplace {} ({}@{})",
                mp.name,
                mp.source_repo,
                if r#ref.is_empty() { "default" } else { r#ref }
            );
        }
        let local = std::mem::take(&mut mp.plugins);
        mp.plugins = marketplace_remote::merge_local_remote(local, remote);

        // Editable flag = current token has push rights on the source repo.
        // Drives whether the Admin → Distant tab lists this marketplace.
        mp.editable = gh.can_push(&mp.source_repo);

        // Merge remote-only skills for installed plugins with a github source.
        // Errors are non-fatal: we want the rest of the refresh to complete.
        for plugin in mp.plugins.iter_mut() {
            let Some(src) = plugin.source.clone() else {
                continue;
            };
            if src.repo.is_empty() {
                continue;
            }
            if plugin.installed_version.is_none() {
                continue;
            }
            match marketplace_remote::fetch_plugin_skills(&gh, &src, &plugin.name, &mp.name) {
                Ok(remote_skills) => {
                    let local = std::mem::take(&mut plugin.skills);
                    plugin.skills = marketplace_remote::merge_skills(local, remote_skills);
                }
                Err(e) => {
                    tracing::warn!(
                        "fetch_plugin_skills failed for {}@{}: {}",
                        plugin.name,
                        mp.name,
                        e
                    );
                }
            }
        }
    }

    // 4) Reconcile in-flight PR statuses so "in review" badges clear once a PR
    // merges/closes. The dedicated PR-history tab used to drive this; the
    // regular refresh now does it. Best-effort, provider-aware.
    reconcile_open_prs(&settings);

    let local_only = local_scanner::build_local_only_marketplace();

    tracing::info!(
        "refresh_all done: {} marketplace(s), {} local-only skill(s)",
        marketplaces.len(),
        local_only.plugins.iter().map(|p| p.skills.len()).sum::<usize>()
    );
    Ok(RefreshResult {
        marketplaces,
        local_only,
    })
}

#[tauri::command]
pub async fn install_plugin_cmd(plugin: Plugin) -> Result<PathBuf> {
    let s = config::load_settings();
    let gh = client_for_source(&s, plugin.source.as_ref(), &plugin.marketplace_name)?;
    let name = plugin.name.clone();
    let mp = plugin.marketplace_name.clone();
    match installer::install_plugin(&gh, &plugin) {
        Ok(p) => {
            tracing::info!("install_plugin ok: {}@{}", name, mp);
            Ok(p)
        }
        Err(e) => {
            tracing::error!("install_plugin failed: {}@{}: {}", name, mp, e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn uninstall_plugin_cmd(plugin: Plugin) -> Result<()> {
    let name = plugin.name.clone();
    let mp = plugin.marketplace_name.clone();
    match installer::uninstall(&plugin) {
        Ok(()) => {
            tracing::info!("uninstall_plugin ok: {}@{}", name, mp);
            Ok(())
        }
        Err(e) => {
            tracing::error!("uninstall_plugin failed: {}@{}: {}", name, mp, e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn install_marketplace_cmd(
    name: String,
    repo: String,
    r#ref: String,
    auto_update: Option<bool>,
    provider: Option<Provider>,
    base_url: Option<String>,
) -> Result<PathBuf> {
    // Build the client from the explicit provider/base_url passed by the
    // frontend so install doesn't depend on the marketplace config having been
    // saved first.
    let provider = provider.unwrap_or(Provider::Github);
    let base_url = base_url.unwrap_or_default();
    let gh = match provider {
        Provider::Gitea => gitea_client(&config::load_settings(), &base_url)?,
        Provider::Github => gh()?,
    };
    let label = name.clone();
    let repo_label = repo.clone();
    match marketplace_installer::install_marketplace(&gh, &name, &repo, &r#ref, auto_update) {
        Ok(p) => {
            tracing::info!("install_marketplace ok: {} from {}", label, repo_label);
            Ok(p)
        }
        Err(e) => {
            tracing::error!(
                "install_marketplace failed: {} from {}: {}",
                label,
                repo_label,
                e
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn uninstall_marketplace_cmd(name: String) -> Result<()> {
    let label = name.clone();
    match marketplace_installer::uninstall_marketplace(&name) {
        Ok(()) => {
            tracing::info!("uninstall_marketplace ok: {}", label);
            Ok(())
        }
        Err(e) => {
            tracing::error!("uninstall_marketplace failed: {}: {}", label, e);
            Err(e)
        }
    }
}

/// Full removal of a marketplace from the app's view.
///
/// `uninstall_marketplace` only touches `known_marketplaces.json` and the
/// marketplace folder — `installed_plugins.json` still has `"<plugin>@<mp>"`
/// keys, and the orphan-detection in `build_marketplaces_from_settings` would
/// resurrect the marketplace from those keys alone. So a real "delete"
/// cascades: uninstall every plugin recorded under this marketplace, then the
/// marketplace itself, then forget it from the app's settings.
///
/// Per-plugin failures are non-fatal — we always continue and report them in
/// the log, because partial cleanup is still better than nothing.
#[tauri::command]
pub async fn delete_marketplace_completely(name: String) -> Result<Settings> {
    tracing::info!("delete_marketplace_completely: {}", name);
    let plugins = local_scanner::installed_plugins_by_marketplace()
        .remove(&name)
        .unwrap_or_default();
    for plugin in plugins {
        if let Err(e) = installer::uninstall(&plugin) {
            tracing::warn!(
                "delete_marketplace_completely: failed to uninstall plugin '{}' from '{}': {}",
                plugin.name,
                name,
                e
            );
        }
    }
    if let Err(e) = marketplace_installer::uninstall_marketplace(&name) {
        tracing::warn!(
            "delete_marketplace_completely: uninstall_marketplace('{}') failed: {}",
            name,
            e
        );
    }
    let mut s = config::load_settings();
    s.marketplaces.retain(|m| m.name != name);
    config::save_settings(&s)?;
    Ok(s)
}

#[tauri::command]
pub async fn set_marketplace_auto_update(name: String, value: bool) -> Result<bool> {
    tracing::info!("set_marketplace_auto_update: {} -> {}", name, value);
    marketplace_installer::set_auto_update(&name, value)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub name: String,
    pub updated: bool,
    pub message: String,
}

#[tauri::command]
pub async fn check_marketplace_updates(only: Option<String>) -> Vec<UpdateCheckResult> {
    let settings = config::load_settings();
    let mut out = Vec::new();
    for cfg in &settings.marketplaces {
        if cfg.github_repo.is_empty() {
            continue;
        }
        if !marketplace_installer::is_marketplace_installed(&cfg.name) {
            continue;
        }
        if only.as_deref().is_some_and(|n| n != cfg.name) {
            continue;
        }
        let Ok(gh) = client_for_cfg(&settings, Some(cfg)) else {
            continue;
        };
        let r#ref = if cfg.default_branch.is_empty() {
            "main"
        } else {
            &cfg.default_branch
        };
        let (updated, msg) =
            marketplace_installer::auto_update_if_changed(&gh, &cfg.name, &cfg.github_repo, r#ref);
        out.push(UpdateCheckResult {
            name: cfg.name.clone(),
            updated,
            message: msg,
        });
    }
    out
}

#[tauri::command]
pub fn parse_marketplace_url(url: String) -> Option<String> {
    crate::registry::parse_github_marketplace_url(&url)
}

#[tauri::command]
pub async fn set_plugin_enabled(plugin: String, marketplace: String, value: bool) -> Result<()> {
    tracing::info!(
        "set_plugin_enabled: {}@{} -> {}",
        plugin,
        marketplace,
        value
    );
    plugin_state::set_enabled(&plugin, &marketplace, value)
}

#[tauri::command]
pub async fn list_skill_files(folder: PathBuf) -> Result<Vec<String>> {
    let mut out = Vec::new();
    if !folder.is_dir() {
        return Ok(out);
    }
    for entry in walkdir::WalkDir::new(&folder).max_depth(3).sort_by_file_name() {
        let Ok(entry) = entry else { continue };
        if entry.path() == folder {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(&folder) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn read_text_file(path: PathBuf) -> Result<String> {
    std::fs::read_to_string(&path).map_err(crate::error::Error::from)
}

/// Open a URL or filesystem path through the Windows shell (or platform
/// equivalent). Bypasses `tauri-plugin-opener`'s scope system, which silently
/// drops unscoped `file://` and `https://` targets in v2.
#[tauri::command]
pub async fn open_in_shell(target: String) -> Result<()> {
    let t = target.trim();
    if t.is_empty() {
        return Err(crate::error::Error::Invalid("empty target".into()));
    }
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        let target_wide: Vec<u16> = OsStr::new(t)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let verb_wide: Vec<u16> = OsStr::new("open")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(
                hwnd: *mut core::ffi::c_void,
                lp_operation: *const u16,
                lp_file: *const u16,
                lp_parameters: *const u16,
                lp_directory: *const u16,
                n_show_cmd: i32,
            ) -> isize;
        }
        const SW_SHOWNORMAL: i32 = 1;
        // ShellExecuteW returns >32 on success; any value <=32 is an error
        // code in the legacy HINSTANCE convention.
        let rc = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb_wide.as_ptr(),
                target_wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if rc > 32 {
            tracing::debug!("ShellExecuteW opened: {}", t);
            Ok(())
        } else {
            tracing::warn!(
                "ShellExecuteW failed for '{}' (code={})",
                t,
                rc
            );
            Err(crate::error::Error::Invalid(format!(
                "ShellExecuteW failed (code {rc})"
            )))
        }
    }
    #[cfg(not(windows))]
    {
        Err(crate::error::Error::Invalid(format!(
            "open_in_shell not implemented on this platform for: {t}"
        )))
    }
}

/// Launches VS Code with the given path opened as a folder/file.
///
/// Goes through `cmd /C code` on Windows because the VS Code launcher is
/// `code.cmd`, which Rust's `Command::new` won't pick up from PATH directly
/// (it searches for `.exe` only). `CREATE_NO_WINDOW` keeps the helper console
/// from flashing on screen. On other OSes we just call `code` directly.
///
/// We *don't* wait for the child — VS Code keeps running after this returns.
#[tauri::command]
pub async fn open_in_vscode(path: String) -> Result<()> {
    let p = path.trim();
    if p.is_empty() {
        return Err(crate::error::Error::Invalid("empty path".into()));
    }
    if !std::path::Path::new(p).exists() {
        return Err(crate::error::Error::Invalid(format!(
            "path does not exist: {p}"
        )));
    }
    tracing::info!("open_in_vscode: {}", p);

    let spawn_result = {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            std::process::Command::new("cmd")
                .args(["/C", "code", p])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("code").arg(p).spawn()
        }
    };

    spawn_result.map(|_| ()).map_err(|e| {
        tracing::warn!("open_in_vscode failed for '{}': {}", p, e);
        crate::error::Error::Invalid(format!(
            "Failed to launch VS Code: {e}. Make sure the `code` CLI is on \
             your PATH — in VS Code run the command 'Shell Command: Install \
             code command in PATH'."
        ))
    })
}

/// Last-modified timestamp for a file or directory, as an RFC3339 UTC string.
/// Returns `None` when the path doesn't exist or the FS doesn't expose mtime.
#[tauri::command]
pub async fn file_mtime(path: PathBuf) -> Option<String> {
    let meta = std::fs::metadata(&path).ok()?;
    let modified = meta.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    let secs = dur.as_secs() as i64;
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, dur.subsec_nanos())
        .map(|dt| dt.to_rfc3339())
}

#[tauri::command]
pub async fn write_text_file(path: PathBuf, content: String) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content).map_err(crate::error::Error::from)
}

#[tauri::command]
pub async fn parse_skill_md(text: String) -> Value {
    let (fields, body) = parse_frontmatter(&text);
    serde_json::json!({ "fields": fields, "body": body })
}

#[tauri::command]
pub async fn github_auth_check() -> (bool, String) {
    match gh() {
        Ok(g) => g.auth_check(),
        Err(e) => (false, e.to_string()),
    }
}

#[tauri::command]
pub async fn github_rate_limit() -> (i64, i64) {
    match gh() {
        Ok(g) => g.get_rate_limit(),
        Err(_) => (-1, -1),
    }
}

#[tauri::command]
pub async fn github_can_push(repo: String) -> bool {
    match gh() {
        Ok(g) => g.can_push(&repo),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn github_token_scopes() -> Vec<String> {
    match gh() {
        Ok(g) => g.get_token_scopes(),
        Err(_) => Vec::new(),
    }
}

// ---------- Gitea instance commands ----------

#[tauri::command]
pub async fn gitea_auth_check(base_url: String) -> (bool, String) {
    let s = config::load_settings();
    match gitea_client(&s, &base_url) {
        Ok(g) => g.auth_check(),
        Err(e) => (false, e.to_string()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiteaStatus {
    pub base_url: String,
    pub host: String,
    pub has_token: bool,
    pub insecure_tls: bool,
    pub ok: bool,
    /// Login when authenticated, otherwise a short error/status message.
    pub user: String,
}

/// Connection status for every registered Gitea instance — the multi-host
/// analogue of [`github_auth_check`], so the dashboard and sidebar can show
/// each instance's auth state next to GitHub's. One network call per instance;
/// the frontend caches the result like the GitHub checks.
#[tauri::command]
pub async fn gitea_status_all() -> Vec<GiteaStatus> {
    let s = config::load_settings();
    let mut out = Vec::new();
    for inst in &s.gitea_instances {
        let (ok, user) = match gitea_client(&s, &inst.base_url) {
            Ok(g) => g.auth_check(),
            Err(e) => (false, e.to_string()),
        };
        out.push(GiteaStatus {
            host: host_of(&inst.base_url),
            base_url: inst.base_url.clone(),
            has_token: inst.has_token,
            insecure_tls: inst.insecure_tls,
            ok,
            user,
        });
    }
    out
}

/// Register or update a Gitea instance (host + TLS mode). The token is set
/// separately via [`settings_set_gitea_token`].
#[tauri::command]
pub async fn settings_upsert_gitea_instance(
    base_url: String,
    insecure_tls: bool,
) -> Result<Settings> {
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() {
        return Err(crate::error::Error::Invalid(
            "Gitea instance URL is required.".into(),
        ));
    }
    let mut s = config::load_settings();
    let host = host_of(&base_url);
    match s
        .gitea_instances
        .iter_mut()
        .find(|i| host_of(&i.base_url) == host)
    {
        Some(existing) => {
            existing.base_url = base_url.clone();
            existing.insecure_tls = insecure_tls;
        }
        None => s.gitea_instances.push(GiteaInstance {
            base_url: base_url.clone(),
            insecure_tls,
            has_token: false,
        }),
    }
    config::save_settings(&s)?;
    tracing::info!("gitea instance upserted: {} (insecureTls={})", base_url, insecure_tls);
    Ok(config::load_settings())
}

/// Remove a Gitea instance and clear its stored token.
#[tauri::command]
pub async fn settings_remove_gitea_instance(base_url: String) -> Result<Settings> {
    let host = host_of(&base_url);
    let mut s = config::load_settings();
    s.gitea_instances.retain(|i| host_of(&i.base_url) != host);
    config::save_settings(&s)?;
    if let Err(e) = token_store::save_host(&host, "") {
        tracing::warn!("could not clear gitea token for {}: {}", host, e);
    }
    tracing::info!("gitea instance removed: {}", base_url);
    Ok(config::load_settings())
}

#[tauri::command]
pub async fn settings_set_gitea_token(base_url: String, token: String) -> Result<Settings> {
    let host = host_of(&base_url);
    tracing::info!("gitea token updated for {} (len={})", host, token.len());
    token_store::save_host(&host, &token)?;
    Ok(config::load_settings())
}

// ---------- Admin commands ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitChangesArgs {
    pub repo: String,
    pub base_branch: String,
    pub changes: Vec<FileChange>,
    #[serde(default)]
    pub deletions: Vec<String>,
    pub pr_title: String,
    #[serde(default)]
    pub pr_body: String,
    pub branch_prefix: String,
}

#[tauri::command]
pub async fn admin_submit_changes(args: SubmitChangesArgs) -> Result<UploadResult> {
    let gh = gh()?;
    let title = args.pr_title.clone();
    match admin::submit_changes(
        &gh,
        &args.repo,
        &args.base_branch,
        &args.changes,
        &args.pr_title,
        &args.pr_body,
        &args.branch_prefix,
        &args.deletions,
    ) {
        Ok(r) => Ok(r),
        Err(e) => {
            tracing::error!("admin.submit_changes failed: {}: {}", title, e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn admin_collect_skill_folder(
    folder: PathBuf,
    target_subpath: String,
) -> Result<Vec<FileChange>> {
    admin::collect_skill_folder_changes(&folder, &target_subpath)
}

#[tauri::command]
pub async fn admin_fetch_registry(repo: String, r#ref: String) -> Result<Value> {
    let gh = gh()?;
    let (data, path, _sha) = admin::fetch_marketplace_registry(&gh, &repo, &r#ref)?;
    Ok(serde_json::json!({ "data": data, "path": path }))
}

#[tauri::command]
pub async fn admin_validate_registry(registry: Value) -> Vec<String> {
    admin::validate_marketplace_registry(&registry)
}

#[tauri::command]
pub async fn admin_diff(old: String, new: String, path: String) -> String {
    admin::unified_diff(&old, &new, &path)
}

#[tauri::command]
pub async fn admin_bump_version(version: String, level: String) -> String {
    admin::bump_version(&version, &level)
}

#[tauri::command]
pub async fn admin_build_skill_md(name: String, description: String, body: String) -> Vec<u8> {
    admin::build_skill_md(&name, &description, &body)
}

// ---------- PR history & pending ----------

#[tauri::command]
pub async fn pr_history_list() -> Vec<PRRecord> {
    pr_history::load_all()
}

#[tauri::command]
pub async fn pr_history_remove(repo: String, number: i64) -> Result<()> {
    pr_history::remove(&repo, number)
}

#[tauri::command]
pub async fn pr_history_clear() -> Result<()> {
    pr_history::clear_all()
}

/// Derive a PR's lifecycle status ("merged" | "closed" | "open") from a forge
/// PR JSON object. GitHub and Gitea share these fields.
fn pr_status_of(pr: &Value) -> &'static str {
    if pr.get("merged_at").and_then(|v| v.as_str()).is_some() {
        "merged"
    } else if pr
        .get("state")
        .and_then(|v| v.as_str())
        .map(|s| s.eq_ignore_ascii_case("closed"))
        .unwrap_or(false)
    {
        "closed"
    } else {
        "open"
    }
}

/// Re-check every PR still marked "open" in `pr_history` against its forge and,
/// when it has merged/closed, update the history record and drop any matching
/// `pending_prs` entry — so the Admin "in review" badges clear automatically.
///
/// This used to be driven by the (now removed) PR-history tab; it now runs as
/// part of the regular refresh. Provider-aware via each record's own
/// `provider`/`base_url`. Best-effort: per-PR failures are logged, never fatal.
fn reconcile_open_prs(s: &Settings) {
    for rec in pr_history::load_all()
        .into_iter()
        .filter(|r| r.status == "open")
    {
        let client = match rec.provider {
            Provider::Gitea => gitea_client(s, &rec.base_url),
            _ => GitHubClient::new(&s.github_token),
        };
        let client = match client {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    "reconcile_open_prs: client init for {}#{} failed: {}",
                    rec.repo, rec.number, e
                );
                continue;
            }
        };
        let pr = match client.get_pull_request(&rec.repo, rec.number) {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(
                    "reconcile_open_prs: get PR {}#{} failed: {}",
                    rec.repo, rec.number, e
                );
                continue;
            }
        };
        let status = pr_status_of(&pr);
        if status != "open" {
            let _ = pr_history::update_status(&rec.repo, rec.number, status);
            let _ = pending_prs::remove_by_pr(&rec.repo, rec.number);
            tracing::info!("reconcile_open_prs: PR {}#{} → {}", rec.repo, rec.number, status);
        }
    }
}

#[tauri::command]
pub async fn pr_history_refresh_status(repo: String, number: i64) -> Result<String> {
    // Target the forge the PR actually lives on (recorded at creation time).
    let rec = pr_history::load_all()
        .into_iter()
        .find(|r| r.repo == repo && r.number == number);
    let gh = match rec {
        Some(r) if r.provider == Provider::Gitea => {
            gitea_client(&config::load_settings(), &r.base_url)?
        }
        _ => gh()?,
    };
    let pr = gh.get_pull_request(&repo, number)?;
    let status = pr_status_of(&pr);
    pr_history::update_status(&repo, number, status)?;
    // Once a PR leaves the "open" state, drop any matching pending record so
    // the Admin tab stops showing the skill as "in review".
    if status != "open" {
        let _ = pending_prs::remove_by_pr(&repo, number);
    }
    Ok(status.to_string())
}

#[tauri::command]
pub async fn pending_prs_list() -> Vec<PendingPR> {
    pending_prs::load_all()
}

#[tauri::command]
pub async fn pending_prs_upsert(item: PendingPR) -> Result<()> {
    pending_prs::upsert(item)
}

#[tauri::command]
pub async fn pending_prs_remove(
    marketplace: String,
    plugin: String,
    action: String,
) -> Result<()> {
    pending_prs::remove(&marketplace, &plugin, &action)
}

// ---------- Marketplace PR tracking ("Suivi Marketplace") ----------

/// One open PR surfaced by the marketplace tracker. Unlike [`PRRecord`] (only
/// PRs this app opened), these are *all* open PRs on a tracked marketplace's
/// repo and its plugins' repos, regardless of author.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedPr {
    pub marketplace_name: String,
    /// "marketplace" | "plugin"
    pub scope: String,
    /// Plugin name for plugin-scoped PRs; empty for marketplace-scoped.
    pub plugin_name: String,
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub created_at: String,
    pub provider: Provider,
    pub base_url: String,
}

/// Map a forge PR JSON object (GitHub or Gitea — same shape for these fields)
/// into a [`TrackedPr`]. Returns `None` when the entry has no PR number.
#[allow(clippy::too_many_arguments)]
fn tracked_pr_from_value(
    v: &Value,
    marketplace_name: &str,
    scope: &str,
    plugin_name: &str,
    repo: &str,
    provider: Provider,
    base_url: &str,
) -> Option<TrackedPr> {
    let number = v.get("number").and_then(|x| x.as_i64())?;
    Some(TrackedPr {
        marketplace_name: marketplace_name.to_string(),
        scope: scope.to_string(),
        plugin_name: plugin_name.to_string(),
        repo: repo.to_string(),
        number,
        title: v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        url: v.get("html_url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        author: v
            .get("user")
            .and_then(|u| u.get("login"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        created_at: v.get("created_at").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        provider,
        base_url: base_url.to_string(),
    })
}

/// Fetch open PRs for every marketplace flagged `track_prs` (or just `only`
/// when given) plus each of their plugins' source repos. Network-heavy and
/// provider-aware; per-repo failures are logged and skipped, never fatal.
///
/// Runs the blocking forge calls inline (same pattern as `refresh_all`): it's a
/// user-triggered fetch, not a hot path.
#[tauri::command]
pub async fn track_marketplace_prs(only: Option<String>) -> Result<Vec<TrackedPr>> {
    let s = config::load_settings();
    let mut out: Vec<TrackedPr> = Vec::new();
    // Avoid re-querying the same plugin repo twice within one marketplace.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for cfg in &s.marketplaces {
        if !cfg.track_prs || cfg.github_repo.is_empty() {
            continue;
        }
        if let Some(name) = &only {
            if &cfg.name != name {
                continue;
            }
        }

        let gh = match client_for_cfg(&s, Some(cfg)) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("track_marketplace_prs: client init failed for {}: {}", cfg.name, e);
                continue;
            }
        };

        match gh.list_open_prs(&cfg.github_repo) {
            Ok(prs) => out.extend(prs.iter().filter_map(|v| {
                tracked_pr_from_value(v, &cfg.name, "marketplace", "", &cfg.github_repo, cfg.provider, &cfg.base_url)
            })),
            Err(e) => tracing::warn!(
                "track_marketplace_prs: list PRs failed for marketplace {} ({}): {}",
                cfg.name, cfg.github_repo, e
            ),
        }

        // Plugin-level PRs: resolve each plugin's own source repo/forge.
        let plugins = marketplace_remote::fetch_marketplace_plugins(
            &gh, &cfg.github_repo, &cfg.default_branch, &cfg.name,
        );
        for p in &plugins {
            let Some(src) = p.source.as_ref() else { continue };
            if src.repo.is_empty() {
                continue;
            }
            if !seen.insert(format!("{}::{}", cfg.name, src.repo)) {
                continue;
            }
            let pclient = match client_for_source(&s, p.source.as_ref(), &cfg.name) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(
                        "track_marketplace_prs: plugin client init failed for {} ({}): {}",
                        p.name, src.repo, e
                    );
                    continue;
                }
            };
            let provider = pclient.provider();
            let base_url = pclient.base_url();
            match pclient.list_open_prs(&src.repo) {
                Ok(prs) => out.extend(prs.iter().filter_map(|v| {
                    tracked_pr_from_value(v, &cfg.name, "plugin", &p.name, &src.repo, provider, &base_url)
                })),
                Err(e) => tracing::warn!(
                    "track_marketplace_prs: list PRs failed for plugin {} ({}): {}",
                    p.name, src.repo, e
                ),
            }
        }
    }
    Ok(out)
}

// ---------- App settings sub-commands ----------

#[tauri::command]
pub async fn settings_upsert_marketplace(cfg: MarketplaceConfig) -> Result<Settings> {
    let mut s = config::load_settings();
    if let Some(idx) = s.marketplaces.iter().position(|m| m.name == cfg.name) {
        s.marketplaces[idx] = cfg;
    } else {
        s.marketplaces.push(cfg);
    }
    config::save_settings(&s)?;
    Ok(s)
}

#[tauri::command]
pub async fn settings_remove_marketplace(name: String) -> Result<Settings> {
    let mut s = config::load_settings();
    s.marketplaces.retain(|m| m.name != name);
    config::save_settings(&s)?;
    Ok(s)
}

#[tauri::command]
pub async fn settings_set_token(token: String) -> Result<Settings> {
    tracing::info!("github token updated (len={})", token.len());
    token_store::save(&token)?;
    // Reload so the returned Settings reflects what's actually stored.
    Ok(config::load_settings())
}

#[tauri::command]
pub async fn settings_set_ui(ui: UiPrefs) -> Result<Settings> {
    let mut s = config::load_settings();
    s.ui = ui;
    config::save_settings(&s)?;
    Ok(s)
}

#[tauri::command]
pub async fn settings_export() -> Result<String> {
    // Never include the GitHub token in an export blob — it stays in the OS
    // credential vault. Users re-enter it after importing on another machine.
    let mut s = config::load_settings();
    s.github_token.clear();
    serde_json::to_string_pretty(&s).map_err(crate::error::Error::from)
}

#[tauri::command]
pub async fn settings_import(payload: String) -> Result<Settings> {
    let s: Settings =
        serde_json::from_str(&payload).map_err(crate::error::Error::from)?;
    // Back-compat: an export from an older build may still carry a token.
    // Lift it into the credential vault rather than dropping it on disk.
    if !s.github_token.is_empty() {
        if let Err(e) = token_store::save(&s.github_token) {
            tracing::warn!("could not store imported token in credential vault: {e}");
        }
    }
    let mut to_save = s.clone();
    to_save.github_token.clear();
    config::save_settings(&to_save)?;
    tracing::info!(
        "imported settings: {} marketplace(s)",
        s.marketplaces.len()
    );
    Ok(config::load_settings())
}

#[tauri::command]
pub async fn settings_paths() -> serde_json::Value {
    serde_json::json!({
        "exeDir": config::exe_dir(),
        "configDir": config::app_settings_dir(),
        "logsDir": config::logs_dir(),
        "configFile": config::config_properties_file(),
        "marketplacesFile": config::marketplaces_file(),
        "loggingFile": config::logging_properties_file(),
    })
}

// ---------- Logging commands ----------

#[tauri::command]
pub async fn logging_get_config() -> LoggingConfig {
    config::load_logging_config()
}

#[tauri::command]
pub async fn logging_set_config(cfg: LoggingConfig) -> Result<LoggingConfig> {
    config::save_logging_config(&cfg)?;
    tracing::info!(
        "logging config updated: enabled={} level={}",
        cfg.enabled,
        cfg.level
    );
    Ok(cfg)
}

#[tauri::command]
pub async fn logging_purge() -> Result<u32> {
    let removed = logger::purge().map_err(crate::error::Error::from)?;
    Ok(removed as u32)
}

#[tauri::command]
pub async fn logging_tail(max_bytes: Option<usize>) -> Result<String> {
    logger::tail(max_bytes.unwrap_or(64 * 1024))
        .map_err(crate::error::Error::from)
}

#[tauri::command]
pub async fn logging_log(level: String, target: Option<String>, message: String) {
    let target = target.unwrap_or_else(|| "frontend".to_string());
    match level.to_ascii_uppercase().as_str() {
        "ERROR" => tracing::error!(target: "frontend", "[{}] {}", target, message),
        "WARN" => tracing::warn!(target: "frontend", "[{}] {}", target, message),
        "DEBUG" => tracing::debug!(target: "frontend", "[{}] {}", target, message),
        "TRACE" => tracing::trace!(target: "frontend", "[{}] {}", target, message),
        _ => tracing::info!(target: "frontend", "[{}] {}", target, message),
    }
}

// ---------- Admin draft commands ----------

#[tauri::command]
pub async fn admin_prepare_add_plugin(
    marketplace: String,
    source_url: String,
) -> Result<AdminDraft> {
    logged_admin("admin_prepare_add_plugin", format!("{source_url} -> {marketplace}"), || {
        let gh = client_for_marketplace(&marketplace)?;
        admin_drafts::prepare_add_plugin(&gh, &marketplace, &source_url)
    })
}

#[tauri::command]
pub async fn admin_prepare_bump_plugin(
    marketplace: String,
    plugin_name: String,
    new_version: String,
) -> Result<AdminDraft> {
    logged_admin("admin_prepare_bump_plugin", format!("{plugin_name}@{marketplace} -> {new_version}"), || {
        let gh = client_for_marketplace(&marketplace)?;
        admin_drafts::prepare_bump_plugin(&gh, &marketplace, &plugin_name, &new_version)
    })
}

#[tauri::command]
pub async fn admin_prepare_remove_plugin(
    marketplace: String,
    plugin_name: String,
) -> Result<AdminDraft> {
    logged_admin("admin_prepare_remove_plugin", format!("{plugin_name}@{marketplace}"), || {
        let gh = client_for_marketplace(&marketplace)?;
        admin_drafts::prepare_remove_plugin(&gh, &marketplace, &plugin_name)
    })
}

#[tauri::command]
pub async fn admin_prepare_upload_skill(args: UploadSkillArgs) -> Result<AdminDraft> {
    logged_admin("admin_prepare_upload_skill", format!("{}@{}", args.plugin_name, args.marketplace), || {
        let gh = client_for_marketplace(&args.marketplace)?;
        admin_drafts::prepare_upload_skill(&gh, &args)
    })
}

#[tauri::command]
pub async fn admin_prepare_delete_skill(
    marketplace: String,
    plugin_name: String,
    skill_name: String,
) -> Result<AdminDraft> {
    logged_admin("admin_prepare_delete_skill", format!("{skill_name} ({plugin_name}@{marketplace})"), || {
        let gh = client_for_marketplace(&marketplace)?;
        admin_drafts::prepare_delete_skill(&gh, &marketplace, &plugin_name, &skill_name)
    })
}

#[tauri::command]
pub async fn admin_submit_draft(draft: AdminDraft) -> Result<UploadResult> {
    // Resolve the client from the draft's marketplace so PRs land on the right
    // forge (the plugin source repo is on the same host as its marketplace).
    let marketplace = draft
        .pending_meta
        .as_ref()
        .map(|m| m.marketplace_name.clone())
        .unwrap_or_default();
    let gh = client_for_marketplace(&marketplace)?;
    let title = draft.pr_title.clone();
    match admin_drafts::submit_draft(&gh, &draft) {
        Ok(r) => Ok(r),
        Err(e) => {
            tracing::error!("admin.submit_changes failed: {}: {}", title, e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn admin_create_tag(repo: String, tag: String, marketplace: Option<String>) -> Result<String> {
    let gh = match marketplace {
        Some(m) if !m.is_empty() => client_for_marketplace(&m)?,
        _ => gh()?,
    };
    admin_drafts::create_tag_if_missing(&gh, &repo, &tag)
}

#[tauri::command]
pub async fn admin_list_user_skills() -> Vec<LocalSkill> {
    admin_drafts::list_user_skills()
}

#[tauri::command]
pub async fn admin_list_remote_skills(
    marketplace: String,
    plugin_name: String,
) -> Result<Vec<RemoteSkillInfo>> {
    let s = config::load_settings();
    let result = (|| {
        // The registry lives on the marketplace's own repo → marketplace client.
        let mp_gh = client_for_cfg(&s, s.get_marketplace(&marketplace))?;
        let (plugin_repo, plugin_url) =
            admin_drafts::resolve_plugin_source(&mp_gh, &marketplace, &plugin_name)?;
        // The plugin may live on a different forge than its marketplace — read
        // its skills with a client targeting the plugin's own host, falling back
        // to the marketplace client when the source carries no host hint.
        let plugin_gh = match client_for_source_url(&s, &plugin_url, "") {
            Some(c) => c?,
            None => mp_gh.clone(),
        };
        admin_drafts::list_skills_in_repo(&plugin_gh, &plugin_repo)
    })();
    if let Err(e) = &result {
        tracing::warn!(
            "admin_list_remote_skills {}@{} failed: {}",
            plugin_name,
            marketplace,
            e
        );
    }
    result
}

#[tauri::command]
pub async fn admin_suggest_bumps(version: String) -> BumpSuggestion {
    admin_drafts::suggest_bumps(&version)
}

// Type alias kept so the commands file is the single source of truth for
// the `Skill` struct re-exports the frontend may want.
pub type _SkillExport = Skill;

// ---------- Duplicate-skill detection ----------

#[tauri::command]
pub async fn list_duplicate_skills() -> Vec<local_scanner::DuplicateSkill> {
    local_scanner::find_duplicate_skills()
}

#[tauri::command]
pub async fn archive_user_skill(folder: PathBuf) -> Result<PathBuf> {
    tracing::info!("archive_user_skill: {}", folder.display());
    local_scanner::archive_user_skill_folder(&folder)
}

#[tauri::command]
pub async fn list_archived_skills() -> Vec<local_scanner::ArchivedSkill> {
    local_scanner::list_archived_skills()
}

#[tauri::command]
pub async fn restore_archived_skill(folder: PathBuf) -> Result<PathBuf> {
    tracing::info!("restore_archived_skill: {}", folder.display());
    local_scanner::restore_archived_skill_folder(&folder)
}

// ---------- App self-update ----------

#[tauri::command]
pub async fn app_check_update() -> Result<AppUpdateInfo> {
    app_updater::check_for_update()
}

/// Downloads the installer asset to %TEMP%, spawns it, then exits SkillManager
/// so NSIS can replace files in-place. The caller (front-end) will see the
/// window disappear and the OS-level UAC prompt from the installer take over.
#[tauri::command]
pub async fn app_install_update(
    app: AppHandle,
    asset_url: String,
    asset_name: String,
) -> Result<()> {
    let path = app_updater::download_installer(&asset_url, &asset_name)?;
    app_updater::launch_installer(&path)?;
    tracing::info!("app_install_update: installer launched, exiting app");
    // Tiny delay so the spawned process is fully detached, then quit. Without
    // this the installer occasionally fails to grab the file lock on the
    // running .exe before we exit and Windows blocks it.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        app.exit(0);
    });
    Ok(())
}

#[tauri::command]
pub async fn app_detect_uninstaller() -> UninstallInfo {
    app_uninstaller::detect()
}

/// Spawn the registered uninstaller and exit. Errors when the install is
/// portable (no uninstall.exe + no registry entry); the front-end is expected
/// to surface that case with a "delete the folder manually" message.
#[tauri::command]
pub async fn app_uninstall(app: AppHandle) -> Result<()> {
    let info = app_uninstaller::detect();
    if info.kind == "none" {
        tracing::warn!("app_uninstall: no uninstaller registered (portable install)");
        return Err(crate::error::Error::Invalid(
            "No uninstaller found. This looks like a portable install — \
             close SkillManager and delete the folder manually."
                .into(),
        ));
    }
    app_uninstaller::launch(&info)?;
    tracing::info!(
        "app_uninstall: uninstaller spawned ({}), exiting app",
        info.kind
    );
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        app.exit(0);
    });
    Ok(())
}

//! All `#[tauri::command]` handlers exposed to the frontend.
//!
//! Each command is a thin wrapper around the corresponding domain module —
//! the heavy lifting stays in installer/marketplace_*/admin/etc. so it can
//! be unit-tested without spinning up Tauri.

use crate::admin::{self, FileChange, UploadResult};
use crate::admin_drafts::{
    self, AdminDraft, BumpSuggestion, LocalSkill, RemoteSkillInfo, UploadSkillArgs,
};
use crate::config::{self, MarketplaceConfig, Settings};
use crate::error::Result;
use crate::frontmatter::parse_frontmatter;
use crate::github_client::GitHubClient;
use crate::installer;
use crate::local_scanner;
use crate::marketplace_installer;
use crate::marketplace_remote;
use crate::models::{Marketplace, Plugin, Skill};
use crate::pending_prs::{self, PendingPR};
use crate::plugin_state;
use crate::pr_history::{self, PRRecord};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

fn gh() -> Result<GitHubClient> {
    let token = config::load_settings().github_token;
    GitHubClient::new(&token)
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
    let settings = config::load_settings();
    let gh = GitHubClient::new(&settings.github_token)?;

    // 1) Auto-update marketplaces flagged with `autoUpdate=true`.
    for cfg in &settings.marketplaces {
        if !cfg.github_repo.is_empty() {
            let info = marketplace_installer::get_install_info(&cfg.name);
            let auto = info
                .get("autoUpdate")
                .and_then(|v| v.as_bool())
                .unwrap_or(cfg.auto_update);
            if auto && marketplace_installer::is_marketplace_installed(&cfg.name) {
                let _ = app.emit("refresh-progress", &format!("auto-update: {}", cfg.name));
                let _ = marketplace_installer::auto_update_if_changed(
                    &gh,
                    &cfg.name,
                    &cfg.github_repo,
                    &cfg.default_branch,
                );
            }
        }
    }

    // 2) Build local marketplace list.
    let mut marketplaces = local_scanner::build_marketplaces_from_settings(&settings.marketplaces);

    // 3) For each marketplace with a github source, fetch the registry and merge.
    for mp in marketplaces.iter_mut() {
        if mp.source_repo.is_empty() {
            continue;
        }
        let _ = app.emit("refresh-progress", &format!("fetching: {}", mp.name));
        let cfg = settings.get_marketplace(&mp.name);
        let r#ref = cfg.map(|c| c.default_branch.as_str()).unwrap_or("");
        let remote =
            marketplace_remote::fetch_marketplace_plugins(&gh, &mp.source_repo, r#ref, &mp.name);
        let local = std::mem::take(&mut mp.plugins);
        mp.plugins = marketplace_remote::merge_local_remote(local, remote);

        // Editable flag = current token has push rights.
        mp.editable = gh.can_push(&mp.source_repo);

        // Merge remote-only skills for installed plugins with a github source.
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
            if let Ok(remote_skills) = marketplace_remote::fetch_plugin_skills(
                &gh,
                &src,
                &plugin.name,
                &mp.name,
            ) {
                let local = std::mem::take(&mut plugin.skills);
                plugin.skills = marketplace_remote::merge_skills(local, remote_skills);
            }
        }
    }

    let local_only = local_scanner::build_local_only_marketplace();

    Ok(RefreshResult {
        marketplaces,
        local_only,
    })
}

#[tauri::command]
pub async fn install_plugin_cmd(plugin: Plugin) -> Result<PathBuf> {
    let gh = gh()?;
    installer::install_plugin(&gh, &plugin)
}

#[tauri::command]
pub async fn uninstall_plugin_cmd(plugin: Plugin) -> Result<()> {
    installer::uninstall(&plugin)
}

#[tauri::command]
pub async fn install_marketplace_cmd(
    name: String,
    repo: String,
    r#ref: String,
    auto_update: Option<bool>,
) -> Result<PathBuf> {
    let gh = gh()?;
    marketplace_installer::install_marketplace(&gh, &name, &repo, &r#ref, auto_update)
}

#[tauri::command]
pub async fn uninstall_marketplace_cmd(name: String) -> Result<()> {
    marketplace_installer::uninstall_marketplace(&name)
}

#[tauri::command]
pub async fn set_marketplace_auto_update(name: String, value: bool) -> Result<bool> {
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
    let Ok(gh) = GitHubClient::new(&settings.github_token) else {
        return Vec::new();
    };
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
    admin::submit_changes(
        &gh,
        &args.repo,
        &args.base_branch,
        &args.changes,
        &args.pr_title,
        &args.pr_body,
        &args.branch_prefix,
        &args.deletions,
    )
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

#[tauri::command]
pub async fn pr_history_refresh_status(repo: String, number: i64) -> Result<String> {
    let gh = gh()?;
    let pr = gh.get_pull_request(&repo, number)?;
    let status = if pr.get("merged_at").and_then(|v| v.as_str()).is_some() {
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
    };
    pr_history::update_status(&repo, number, status)?;
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
    let mut s = config::load_settings();
    s.github_token = token;
    config::save_settings(&s)?;
    Ok(s)
}

// ---------- Admin draft commands ----------

#[tauri::command]
pub async fn admin_prepare_add_plugin(
    marketplace: String,
    source_url: String,
) -> Result<AdminDraft> {
    let gh = gh()?;
    admin_drafts::prepare_add_plugin(&gh, &marketplace, &source_url)
}

#[tauri::command]
pub async fn admin_prepare_bump_plugin(
    marketplace: String,
    plugin_name: String,
    new_version: String,
) -> Result<AdminDraft> {
    let gh = gh()?;
    admin_drafts::prepare_bump_plugin(&gh, &marketplace, &plugin_name, &new_version)
}

#[tauri::command]
pub async fn admin_prepare_remove_plugin(
    marketplace: String,
    plugin_name: String,
) -> Result<AdminDraft> {
    let gh = gh()?;
    admin_drafts::prepare_remove_plugin(&gh, &marketplace, &plugin_name)
}

#[tauri::command]
pub async fn admin_prepare_upload_skill(args: UploadSkillArgs) -> Result<AdminDraft> {
    let gh = gh()?;
    admin_drafts::prepare_upload_skill(&gh, &args)
}

#[tauri::command]
pub async fn admin_prepare_delete_skill(
    marketplace: String,
    plugin_name: String,
    skill_name: String,
) -> Result<AdminDraft> {
    let gh = gh()?;
    admin_drafts::prepare_delete_skill(&gh, &marketplace, &plugin_name, &skill_name)
}

#[tauri::command]
pub async fn admin_submit_draft(draft: AdminDraft) -> Result<UploadResult> {
    let gh = gh()?;
    admin_drafts::submit_draft(&gh, &draft)
}

#[tauri::command]
pub async fn admin_create_tag(repo: String, tag: String) -> Result<String> {
    let gh = gh()?;
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
    let gh = gh()?;
    admin_drafts::list_remote_skills(&gh, &marketplace, &plugin_name)
}

#[tauri::command]
pub async fn admin_suggest_bumps(version: String) -> BumpSuggestion {
    admin_drafts::suggest_bumps(&version)
}

// Type alias kept so the commands file is the single source of truth for
// the `Skill` struct re-exports the frontend may want.
pub type _SkillExport = Skill;

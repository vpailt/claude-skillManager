//! Library root. main.rs calls `run()`.
//!
//! Every module here is a 1:1 port of one Python file under src/. The split
//! mirrors that layout so cross-module refactors line up with the legacy code.

pub mod admin;
pub mod admin_drafts;
pub mod commands;
pub mod config;
pub mod error;
pub mod frontmatter;
pub mod github_client;
pub mod installer;
pub mod local_scanner;
pub mod marketplace_installer;
pub mod marketplace_remote;
pub mod models;
pub mod pending_prs;
pub mod plugin_state;
pub mod pr_history;
pub mod registry;

use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_app_settings,
            save_app_settings,
            refresh_all,
            install_plugin_cmd,
            uninstall_plugin_cmd,
            install_marketplace_cmd,
            uninstall_marketplace_cmd,
            set_marketplace_auto_update,
            check_marketplace_updates,
            parse_marketplace_url,
            set_plugin_enabled,
            list_skill_files,
            read_text_file,
            write_text_file,
            parse_skill_md,
            github_auth_check,
            github_rate_limit,
            github_can_push,
            github_token_scopes,
            admin_submit_changes,
            admin_collect_skill_folder,
            admin_fetch_registry,
            admin_validate_registry,
            admin_diff,
            admin_bump_version,
            admin_build_skill_md,
            pr_history_list,
            pr_history_remove,
            pr_history_clear,
            pr_history_refresh_status,
            pending_prs_list,
            pending_prs_upsert,
            pending_prs_remove,
            settings_upsert_marketplace,
            settings_remove_marketplace,
            settings_set_token,
            admin_prepare_add_plugin,
            admin_prepare_bump_plugin,
            admin_prepare_remove_plugin,
            admin_prepare_upload_skill,
            admin_prepare_delete_skill,
            admin_submit_draft,
            admin_create_tag,
            admin_list_user_skills,
            admin_list_remote_skills,
            admin_suggest_bumps,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

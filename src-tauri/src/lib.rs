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
pub mod logger;
pub mod marketplace_installer;
pub mod marketplace_remote;
pub mod models;
pub mod notification_setup;
pub mod pending_prs;
pub mod plugin_state;
pub mod pr_history;
pub mod properties;
pub mod registry;
pub mod tray;

use commands::*;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logger::init();
    tracing::info!(
        "SkillManager starting (version {})",
        env!("CARGO_PKG_VERSION")
    );

    tauri::Builder::default()
        // Single-instance must be registered first so the callback fires before
        // any other setup runs. When a second process launches we surface the
        // existing window (in case it was hidden to tray) and let the new
        // process exit on its own.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tracing::info!("second instance launched — focusing existing window");
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            // Intercept close: if "close to tray" is enabled, hide instead.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let close_to_tray = config::load_settings().ui.close_to_tray;
                if close_to_tray {
                    api.prevent_close();
                    if let Err(e) = window.hide() {
                        tracing::warn!("failed to hide window on close: {}", e);
                    } else {
                        tracing::debug!("window hidden to tray on close request");
                    }
                }
            }
        })
        .setup(|app| {
            // Register the AppUserModelID so Windows accepts our toast
            // notifications. No-op on non-Windows.
            let identifier = app.config().identifier.clone();
            notification_setup::register_aumid(&identifier, "SkillManager");

            tray::setup_tray(app.handle())?;

            // Honor `start_minimized`: hide the main window on startup.
            let prefs = config::load_settings().ui;
            if prefs.start_minimized {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                    tracing::info!("startup: hidden to tray (start_minimized=true)");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_app_settings,
            save_app_settings,
            refresh_all,
            install_plugin_cmd,
            uninstall_plugin_cmd,
            install_marketplace_cmd,
            uninstall_marketplace_cmd,
            delete_marketplace_completely,
            set_marketplace_auto_update,
            check_marketplace_updates,
            parse_marketplace_url,
            set_plugin_enabled,
            list_skill_files,
            read_text_file,
            write_text_file,
            file_mtime,
            open_in_shell,
            open_in_vscode,
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
            settings_set_ui,
            settings_export,
            settings_import,
            settings_paths,
            logging_get_config,
            logging_set_config,
            logging_purge,
            logging_tail,
            logging_log,
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
            list_duplicate_skills,
            archive_user_skill,
            list_archived_skills,
            restore_archived_skill,
            tray::show_main_window,
            tray::hide_main_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

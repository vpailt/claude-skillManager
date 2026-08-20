//! Library root. main.rs calls `run()`.
//!
//! Every module here is a 1:1 port of one Python file under src/. The split
//! mirrors that layout so cross-module refactors line up with the legacy code.

pub mod admin;
pub mod admin_drafts;
pub mod app_uninstaller;
pub mod app_updater;
pub mod authenticode;
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
pub mod pr_poller;
pub mod pr_history;
pub mod properties;
pub mod registry;
pub mod skill_watch;
pub mod taskbar;
pub mod token_store;
pub mod tray;
pub mod update_poller;
pub mod usage_audit;

use commands::*;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logger::init();
    tracing::info!(
        "SkillManager starting (version {})",
        env!("CARGO_PKG_VERSION")
    );

    // Pin the executable path before anything can rename it (the self-update
    // does exactly that), so every later resolution names the install slot.
    let _ = config::exe_path();

    // Relaunched by the self-updater: the outgoing process is still alive for a
    // moment. Wait it out *here*, before the single-instance plugin arms —
    // otherwise the guard sees the old process, hands the session back to the
    // build we just replaced, and this one exits.
    if let Some(pid) = app_updater::wait_pid_from_args() {
        tracing::info!("waiting for the outgoing process {} to exit", pid);
        app_updater::wait_for_pid(pid, 15_000);
    }
    // Sweep the binary a previous update parked in <exe_dir>/update — it was
    // locked while its process ran, and this launch is the first that can
    // delete it.
    app_updater::cleanup_stale();

    tauri::Builder::default()
        // Single-instance must be registered first so the callback fires before
        // any other setup runs. When a second process launches we surface the
        // existing window (in case it was hidden to tray) and let the new
        // process exit on its own.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tracing::info!("second instance launched — surfacing existing window");
            // The window may have been released to tray, so rebuild it first.
            tray::ensure_main_window(app);
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
            // Intercept close: with "close to tray" on, the app survives it.
            //
            // Two ways to survive. `release_ui_on_tray` (the default) lets the
            // close proceed — the window is destroyed and its WebView2 processes
            // go with it, which is the whole point; `RunEvent::ExitRequested`
            // below then keeps the process alive with just the tray icon. With
            // the flag off we fall back to the classic hide, which keeps the
            // webview (and its ~400 MB) resident but makes re-showing instant.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let ui = config::load_settings().ui;
                if !ui.close_to_tray {
                    return;
                }
                if ui.release_ui_on_tray {
                    tracing::debug!("close to tray: releasing webview");
                    return;
                }
                api.prevent_close();
                if let Err(e) = window.hide() {
                    tracing::warn!("failed to hide window on close: {}", e);
                } else {
                    tracing::debug!("window hidden to tray on close request");
                }
            }
        })
        .setup(|app| {
            // Register the AppUserModelID so Windows accepts our toast
            // notifications. No-op on non-Windows.
            let identifier = app.config().identifier.clone();
            notification_setup::register_aumid(&identifier, "SkillManager");

            tray::setup_tray(app.handle())?;

            // Skill change-detection watcher state (lazily arms its fs watcher
            // the first time the frontend calls `skill_watch_set`).
            app.manage(skill_watch::SkillWatch::new());

            // PR status polling lives in Rust so it keeps running (and keeps
            // raising notifications) when the UI has been released to tray.
            pr_poller::start(app.handle().clone());

            // Same reasoning for the self-updater: it swaps the binary in place
            // in the background, so it must survive the window being released.
            update_poller::start(app.handle().clone());

            // Honor `start_minimized`: send the main window straight to tray.
            let prefs = config::load_settings().ui;
            if prefs.start_minimized {
                if let Some(win) = app.get_webview_window("main") {
                    if prefs.close_to_tray && prefs.release_ui_on_tray {
                        let _ = win.destroy();
                        tracing::info!("startup: released to tray (start_minimized=true)");
                    } else {
                        let _ = win.hide();
                        tracing::info!("startup: hidden to tray (start_minimized=true)");
                    }
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
            uninstall_marketplace_cascade,
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
            gitea_auth_check,
            gitea_status_all,
            settings_upsert_gitea_instance,
            settings_remove_gitea_instance,
            settings_set_gitea_token,
            gitea_get_token,
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
            track_marketplace_prs,
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
            admin_prepare_upload_skills,
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
            skill_watch_set,
            skill_mark_synced,
            skill_dirty_list,
            add_skill_to_plugin,
            usage_audit,
            usage_export_xlsx,
            app_check_update,
            app_update_staged,
            app_apply_update,
            app_restart,
            app_install_update,
            app_detect_uninstaller,
            app_uninstall,
            tray::show_main_window,
            tray::hide_main_window,
            taskbar::set_taskbar_badge,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Closing the last window normally ends the process. In tray mode it
            // must not: the window is released on purpose and the tray icon is
            // still the app's front door.
            //
            // `code: Some(_)` means someone called `AppHandle::exit` — the tray
            // "Quit" item, or the self-updater. That is an explicit request to
            // go away, so it is always honored.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                if code.is_none() && config::load_settings().ui.close_to_tray {
                    tracing::debug!("exit requested by last window closing — staying in tray");
                    api.prevent_exit();
                }
            }
        });
}

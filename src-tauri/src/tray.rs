//! System-tray icon: lives in the Windows notification area (bottom-right,
//! next to the clock). Owns the right-click context menu and the left-click
//! show/hide toggle.
//!
//! Menu items are handled directly in Rust where possible; for everything that
//! needs UI work (refresh, open Settings) we emit a Tauri event the frontend
//! listens to in `src/lib/trayEvents.ts`.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

/// Build and attach the tray icon. Called once from `setup()`.
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "tray-show", "Show SkillManager", true, None::<&str>)?;
    let refresh_item = MenuItem::with_id(app, "tray-refresh", "Refresh", true, None::<&str>)?;
    let settings_item =
        MenuItem::with_id(app, "tray-settings", "Open Settings", true, None::<&str>)?;
    let help_item = MenuItem::with_id(app, "tray-help", "Help", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit SkillManager", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &refresh_item,
            &settings_item,
            &help_item,
            &sep,
            &quit_item,
        ],
    )?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("no default window icon configured")?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("SkillManager")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => {
                show_window(app);
            }
            "tray-refresh" => {
                show_window(app);
                if let Err(e) = app.emit("tray://refresh", ()) {
                    tracing::warn!("emit tray://refresh failed: {}", e);
                }
            }
            "tray-settings" => {
                show_window(app);
                if let Err(e) = app.emit("tray://open-settings", ()) {
                    tracing::warn!("emit tray://open-settings failed: {}", e);
                }
            }
            "tray-help" => {
                show_window(app);
                if let Err(e) = app.emit("tray://open-help", ()) {
                    tracing::warn!("emit tray://open-help failed: {}", e);
                }
            }
            "tray-quit" => {
                tracing::info!("quit requested from tray menu");
                app.exit(0);
            }
            other => {
                tracing::debug!("unhandled tray menu id: {}", other);
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click toggles the window. Right-click is handled by the menu.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    tracing::info!("tray icon installed");
    Ok(())
}

fn show_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
}

fn hide_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

fn toggle_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let visible = win.is_visible().unwrap_or(false);
    if visible {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    show_window(&app);
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) {
    hide_window(&app);
}

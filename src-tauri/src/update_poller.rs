//! Background self-update — a Rust worker thread.
//!
//! Same reasoning as `pr_poller`: the window can be released to tray at any
//! time, so anything that must keep happening lives here, not in a frontend
//! `setInterval`.
//!
//! The loop checks GitHub Releases every `update.auto.interval.hours` and, when
//! a newer build is out, applies it **in place** (`app_updater::apply_update`) —
//! no installer window, no uninstall/reinstall, no UAC on a per-user install.
//! The running session is untouched; the new binary takes over at the next
//! launch. The UI is told through [`EVENT_READY`] so it can offer "restart now",
//! and when no window is around to show that, a native toast says the same.
//!
//! [`EVENT_AVAILABLE`] is the degraded path: a release exists but we can't swap
//! it ourselves (install directory read-only, or the release ships only an
//! installer). The frontend then points at the manual buttons in Settings.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::app_updater;
use crate::config;

/// A new build is on disk; restarting picks it up.
pub const EVENT_READY: &str = "app-update-ready";
/// A new build exists but needs the user to act (Settings → Mise à jour).
pub const EVENT_AVAILABLE: &str = "app-update-available";

/// Let the first refresh and the PR poller settle before adding network work.
const STARTUP_DELAY_SECS: u64 = 25;
/// Re-read settings this often while auto-update is switched off, so flipping
/// the toggle in Settings takes effect without a restart.
const DISABLED_POLL_SECS: u64 = 120;
/// Floor on the check interval — GitHub's unauthenticated budget is 60 req/h
/// per IP and nothing here is urgent.
const MIN_INTERVAL_HOURS: u32 = 1;

static STARTED: AtomicBool = AtomicBool::new(false);

/// Last version announced through [`EVENT_AVAILABLE`]. A release we can't
/// install ourselves stays "available" forever, and re-toasting it every
/// interval would be nagging, not informing — so each version is announced
/// once per session.
fn announced() -> &'static Mutex<Option<String>> {
    static LAST: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvent {
    pub version: String,
    pub running_version: String,
    pub release_notes: String,
    pub release_url: Option<String>,
    /// True for [`EVENT_READY`]: the binary is already swapped in.
    pub staged: bool,
}

/// Arm the updater. Idempotent: subsequent calls are no-ops.
pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // A debug build lives in `target/debug` next to the artifacts cargo is
    // about to rewrite. Swapping a release binary in there would be actively
    // hostile to the dev loop, so background updates are release-only. The
    // Settings page's manual button still works in either build.
    if cfg!(debug_assertions) {
        tracing::info!("update_poller: skipped (debug build)");
        return;
    }
    let _ = std::thread::Builder::new()
        .name("update-poller".into())
        .spawn(move || worker(app));
    tracing::info!("update_poller: background self-update armed");
}

fn worker(app: AppHandle) {
    std::thread::sleep(Duration::from_secs(STARTUP_DELAY_SECS));
    loop {
        let settings = config::load_settings();
        if !settings.ui.auto_update_enabled {
            std::thread::sleep(Duration::from_secs(DISABLED_POLL_SECS));
            continue;
        }
        // Already updated this session — the work is done until the user
        // restarts, and re-checking would just re-download the same release.
        if app_updater::staged().is_none() {
            tick(&app, &settings);
        }
        let hours = settings
            .ui
            .auto_update_interval_hours
            .max(MIN_INTERVAL_HOURS) as u64;
        std::thread::sleep(Duration::from_secs(hours * 3600));
    }
}

fn tick(app: &AppHandle, settings: &config::Settings) {
    let info = match app_updater::check_for_update() {
        Ok(i) => i,
        Err(e) => {
            // Offline, VPN, rate limit: normal, and never worth a popup.
            tracing::debug!("update_poller: check failed: {}", e);
            return;
        }
    };
    if !info.has_update {
        return;
    }
    let version = info.latest_version.clone().unwrap_or_default();

    if !info.can_self_update {
        tracing::info!(
            "update_poller: {} available but not self-installable (portable asset: {}, writable: {})",
            version,
            info.portable_asset_name.as_deref().unwrap_or("<none>"),
            app_updater::install_dir_writable()
        );
        emit(app, settings, &info, false);
        return;
    }

    match app_updater::apply_update(&info) {
        Ok(staged) => {
            tracing::info!(
                "update_poller: {} staged in place (running {})",
                staged.version,
                staged.running_version
            );
            emit(app, settings, &info, true);
        }
        Err(e) => {
            tracing::warn!("update_poller: in-place update to {} failed: {}", version, e);
            emit(app, settings, &info, false);
        }
    }
}

fn emit(
    app: &AppHandle,
    settings: &config::Settings,
    info: &app_updater::AppUpdateInfo,
    staged: bool,
) {
    let payload = UpdateEvent {
        version: info.latest_version.clone().unwrap_or_default(),
        running_version: info.current_version.clone(),
        release_notes: info.release_notes.clone(),
        release_url: info.release_url.clone(),
        staged,
    };
    let event = if staged { EVENT_READY } else { EVENT_AVAILABLE };
    if !staged {
        let mut last = announced().lock();
        if last.as_deref() == Some(payload.version.as_str()) {
            tracing::debug!(
                "update_poller: {} already announced this session",
                payload.version
            );
            return;
        }
        *last = Some(payload.version.clone());
    }
    if let Err(e) = app.emit(event, &payload) {
        tracing::debug!("update_poller: emit {} failed: {}", event, e);
    }
    maybe_notify(app, settings, &payload);
}

/// Raise a Windows toast, unless a visible window already showed the in-app one
/// or the user silenced informational notifications.
fn maybe_notify(app: &AppHandle, settings: &config::Settings, payload: &UpdateEvent) {
    let ui = &settings.ui;
    if !ui.native_notifications_enabled || !ui.notify_info {
        return;
    }
    let ui_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if ui_visible {
        return;
    }
    let (title, body) = if payload.staged {
        (
            format!("SkillManager {} est installé", payload.version),
            "La nouvelle version démarrera au prochain lancement.".to_string(),
        )
    } else {
        (
            format!("SkillManager {} est disponible", payload.version),
            "Ouvrez les Paramètres pour lancer la mise à jour.".to_string(),
        )
    };
    if let Err(e) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
    {
        tracing::debug!("update_poller: native notification failed: {}", e);
    }
}

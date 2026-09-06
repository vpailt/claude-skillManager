//! Background self-update — a Rust worker thread.
//!
//! Same reasoning as `pr_poller`: the window can be released to tray at any
//! time, so anything that must keep happening lives here, not in a frontend
//! `setInterval`.
//!
//! The loop checks GitHub Releases every `update.auto.interval.hours` and, when
//! a newer build is out, **says so and stops there** — it emits
//! [`EVENT_AVAILABLE`], which raises the green banner at the top of the window
//! (and a native toast when no window is around to show it).
//!
//! It deliberately downloads nothing. Replacing the binary is the user's call,
//! taken by pressing "Installer": the frontend then invokes `app_apply_update`,
//! which streams the download with progress and emits [`EVENT_READY`] once the
//! new build is on disk. So this module detects, and only detects — the whole
//! point of `update.auto.enabled` is now "check automatically", not "install
//! automatically".

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::app_updater;
use crate::config;

/// A new build is on disk; restarting picks it up. Emitted by
/// `commands::app_apply_update`, never by this poller.
pub const EVENT_READY: &str = "app-update-ready";
/// A new build exists and is waiting on the user to press "Installer".
pub const EVENT_AVAILABLE: &str = "app-update-available";
/// Download/verify/install progress of a user-triggered update. Emitted by
/// `commands::app_apply_update` and `commands::app_install_update`.
pub const EVENT_PROGRESS: &str = "app-update-progress";

/// Let the first refresh and the PR poller settle before adding network work.
/// Short enough that the answer lands while the window is still being read —
/// the check is meant to happen *at* startup, not merely at some point after.
const STARTUP_DELAY_SECS: u64 = 8;
/// Re-read settings this often while auto-update is switched off, so flipping
/// the toggle in Settings takes effect without a restart.
const DISABLED_POLL_SECS: u64 = 120;
/// Floor on the check interval — GitHub's unauthenticated budget is 60 req/h
/// per IP and nothing here is urgent.
const MIN_INTERVAL_HOURS: u32 = 1;

static STARTED: AtomicBool = AtomicBool::new(false);

/// The release last announced through [`EVENT_AVAILABLE`], kept for two
/// reasons.
///
/// A release stays "available" until the user installs it, and re-toasting it
/// every interval would be nagging, not informing — so the toast fires once per
/// version while the event keeps flowing.
///
/// And the window is destroyed in tray mode: a frontend that rebuilt after the
/// announcement would have nothing to show until the next tick, hours later.
/// [`last_available`] lets it ask, the same way it asks `app_update_staged`.
fn available_slot() -> &'static Mutex<Option<UpdateEvent>> {
    static LAST: OnceLock<Mutex<Option<UpdateEvent>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// Version whose banner the user waved away.
///
/// Kept in the process, not in the store: the webview owns no memory that
/// survives a tray close, and `last_available` would hand the rebuilt window
/// the very release it was just told to stop showing.
fn dismissed_slot() -> &'static Mutex<Option<String>> {
    static DISMISSED: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    DISMISSED.get_or_init(|| Mutex::new(None))
}

/// Stop offering `version` until a newer one shows up (or the app restarts).
pub fn dismiss(version: &str) {
    tracing::info!("update_poller: {} dismissed by the user", version);
    *dismissed_slot().lock() = Some(version.to_string());
}

fn is_dismissed(version: &str) -> bool {
    dismissed_slot().lock().as_deref() == Some(version)
}

/// The pending release, if the poller has seen one this session and the user
/// has not waved it away.
pub fn last_available() -> Option<UpdateEvent> {
    let pending = available_slot().lock().clone()?;
    if is_dismissed(&pending.version) {
        return None;
    }
    Some(pending)
}

/// Drop the pending release — called once it has actually been installed, so a
/// window opened afterwards doesn't offer an update that is already on disk.
pub fn clear_available() {
    *available_slot().lock() = None;
}

/// Raise the "installed, restart when you like" toast. Lives here because
/// `maybe_notify` owns the "is a window actually showing this?" decision, but
/// the install itself is now driven by `commands::app_apply_update`.
pub fn notify_staged(app: &AppHandle, payload: &UpdateEvent) {
    let settings = config::load_settings();
    maybe_notify(app, &settings, payload);
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
    /// Whether "Installer" can do the in-place swap, or has to fall back to the
    /// NSIS installer (read-only install dir, or a release with no portable
    /// asset). Only changes the button's wording — both paths are one click.
    pub can_self_update: bool,
}

/// Progress of a user-triggered update, mirrored from
/// `app_updater::UpdatePhase`. `total` is 0 while the size is unknown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub version: String,
    pub phase: app_updater::UpdatePhase,
    pub downloaded: u64,
    pub total: u64,
}

/// Arm the updater. Idempotent: subsequent calls are no-ops.
pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // A debug build lives in `target/debug` next to the artifacts cargo is
    // about to rewrite. Announcing (and letting someone press "Installer" on)
    // a release binary in there would be actively hostile to the dev loop, so
    // background checks are release-only. The Settings page's manual button
    // still works in either build.
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
    // The startup check. It is a check like any other — the loop below would
    // reach it anyway — but saying so out loud matters: "is there a new
    // version?" is a question every launch should answer, not one that waits
    // for an interval to elapse. The short delay is only there to let the first
    // refresh and the PR poller have the network to themselves.
    std::thread::sleep(Duration::from_secs(STARTUP_DELAY_SECS));
    let mut first = true;
    loop {
        let settings = config::load_settings();
        if !settings.ui.auto_update_enabled {
            // Including at startup: switching this off means "do not go and
            // ask", and a launch is no exception. The Settings page's button
            // still checks on demand.
            if first {
                tracing::info!(
                    "update_poller: startup check skipped (auto-update disabled)"
                );
                first = false;
            }
            std::thread::sleep(Duration::from_secs(DISABLED_POLL_SECS));
            continue;
        }
        if first {
            tracing::info!("update_poller: startup check");
            first = false;
        }
        // Already installed this session — the work is done until the user
        // restarts, and re-announcing would just repeat what the banner says.
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
    tracing::info!(
        "update_poller: {} available (portable asset: {}, self-installable: {})",
        info.latest_version.as_deref().unwrap_or("?"),
        info.portable_asset_name.as_deref().unwrap_or("<none>"),
        info.can_self_update
    );
    announce(app, settings, &info);
}

/// Raise the banner (and, if nothing is on screen, a toast) for a release the
/// user has not installed yet. Nothing is downloaded — that starts when they
/// press "Installer".
fn announce(app: &AppHandle, settings: &config::Settings, info: &app_updater::AppUpdateInfo) {
    let payload = UpdateEvent {
        version: info.latest_version.clone().unwrap_or_default(),
        running_version: info.current_version.clone(),
        release_notes: info.release_notes.clone(),
        release_url: info.release_url.clone(),
        staged: false,
        can_self_update: info.can_self_update,
    };
    // Waved away: remember it (so a later, newer release still gets through)
    // but say nothing more about this one.
    if is_dismissed(&payload.version) {
        *available_slot().lock() = Some(payload.clone());
        tracing::debug!("update_poller: {} is dismissed, staying quiet", payload.version);
        return;
    }
    // The event is cheap and idempotent — a window opened after the first tick
    // needs it — but the toast is not, so only the toast is once-per-version.
    let is_new = {
        let mut slot = available_slot().lock();
        let changed = slot.as_ref().map(|p| p.version.as_str()) != Some(payload.version.as_str());
        *slot = Some(payload.clone());
        changed
    };
    if let Err(e) = app.emit(EVENT_AVAILABLE, &payload) {
        tracing::debug!("update_poller: emit {} failed: {}", EVENT_AVAILABLE, e);
    }
    if !is_new {
        tracing::debug!(
            "update_poller: {} already announced this session",
            payload.version
        );
        return;
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
            "Ouvrez SkillManager et cliquez sur Installer pour la télécharger.".to_string(),
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

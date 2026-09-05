//! Background marketplace / plugin sweep — a Rust worker thread.
//!
//! The catalogue used to be refreshed only by the frontend's TanStack query: a
//! 30-minute `refetchInterval`, with `refetchIntervalInBackground` left at its
//! default of `false`. Combined with `ui.tray.release.ui` — which *destroys* the
//! window rather than hiding it — that meant the query object did not merely
//! slow down when the app went to tray, it stopped existing. An app whose normal
//! resting state is the tray therefore did no upstream detection at all: a new
//! plugin version, a skill added to a repo, a marketplace re-indexed, all
//! invisible until someone reopened the window.
//!
//! So it lives here now, next to `pr_poller` and `update_poller`, for the reason
//! the module docs of both already give: nothing user-visible may depend on the
//! frontend being alive.
//!
//! Each tick re-reads settings, so toggling the sweep or changing its interval in
//! the Settings page takes effect without a restart.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::commands;
use crate::config;
use crate::models::InstallState;

/// Emitted after every successful sweep so an open UI refreshes its view.
pub const EVENT: &str = "catalog-changed";

/// Emitted around each background sweep, payload `true` at the start and
/// `false` at the end, so the status bar can show it running.
///
/// The sweep already emits `refresh-progress` from inside `sweep_remote`, but
/// that only says what it is *currently* reading — there is no first or last
/// event to open and close a progress line with, and a tick that finds nothing
/// to change emits no `catalog-changed` either. Without this pair, background
/// work was invisible unless it happened to alter something.
pub const EVENT_SWEEPING: &str = "catalog-sweeping";

/// Floor on the interval. The sweep is an N+1 across the forge (registry, push
/// rights, a manifest read and a git tree per plugin) and is quota-limited —
/// a tighter loop buys nothing and burns rate limit.
const MIN_INTERVAL_MINS: u32 = 5;
/// Idle step while the sweep is switched off, short enough that re-enabling it
/// in Settings feels immediate.
const DISABLED_POLL_SECS: u64 = 60;
/// How long to stay out of the way at launch — see [`worker`].
const STARTUP_DELAY_SECS: u64 = 180;

static STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCounts {
    /// Installed plugins with a newer version published.
    pub outdated: u32,
    /// Installed plugins whose tracked ref moved without a version bump.
    pub content_changed: u32,
    /// Skill folders that are modified, new, or deleted locally.
    pub skills_to_push: u32,
}

/// Arm the poller. Idempotent: subsequent calls are no-ops.
pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("catalog-poller".into())
        .spawn(move || worker(app));
    tracing::info!("catalog_poller: background catalogue sweep armed");
}

fn worker(app: AppHandle) {
    // Counts from the previous tick, so a toast fires on a *transition* rather
    // than on every sweep that still has work outstanding.
    let mut last = CatalogCounts::default();
    let mut first_tick = true;

    // Let the frontend's own initial refresh finish before adding network work.
    // A cold sweep across a large catalogue takes tens of seconds; at 45 s this
    // thread woke up while the first one was still running and immediately ran
    // a second, identical pass.
    std::thread::sleep(Duration::from_secs(STARTUP_DELAY_SECS));
    loop {
        let settings = config::load_settings();
        if !settings.ui.catalog_poll_enabled {
            std::thread::sleep(Duration::from_secs(DISABLED_POLL_SECS));
            continue;
        }
        if let Err(e) = app.emit(EVENT_SWEEPING, true) {
            tracing::debug!("catalog_poller: emit sweeping failed: {e}");
        }
        let ticked = tick(&app);
        if let Err(e) = app.emit(EVENT_SWEEPING, false) {
            tracing::debug!("catalog_poller: emit sweeping failed: {e}");
        }
        match ticked {
            Some(counts) => {
                // Emit only — the taskbar badge stays the frontend's to write.
                // It decorates the taskbar *button*, which does not exist while
                // the window is released to tray, and the frontend's count
                // includes PRs awaiting review, which this sweep knows nothing
                // about. Two writers with two formulas would just fight.
                // An open UI reacts to this event by re-running the refresh,
                // which recomputes the badge through the usual path.
                if let Err(e) = app.emit(EVENT, &counts) {
                    tracing::debug!("catalog_poller: emit failed: {e}");
                }
                // Never announce on the very first sweep of a session: the user
                // just launched the app, whatever is outstanding is not news.
                if !first_tick {
                    maybe_notify(&app, &settings, &last, &counts);
                }
                last = counts;
                first_tick = false;
            }
            None => {
                // A failed sweep is normal (VPN down, rate limit) and must not be
                // surfaced — `sweep_remote` already logged the detail.
            }
        }
        let mins = settings
            .ui
            .catalog_poll_interval_minutes
            .max(MIN_INTERVAL_MINS) as u64;
        std::thread::sleep(Duration::from_secs(mins * 60));
    }
}

fn tick(app: &AppHandle) -> Option<CatalogCounts> {
    // Reuse a sweep the frontend just ran rather than repeat it: this timer and
    // the UI's query answer the same question, and nothing is learnt by asking
    // the forge twice within seconds.
    let result = match commands::sweep_or_reuse(app) {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!("catalog_poller: sweep failed: {e}");
            return None;
        }
    };
    let mut counts = CatalogCounts::default();
    for mp in &result.marketplaces {
        for p in &mp.plugins {
            if p.install_state == InstallState::Outdated {
                counts.outdated += 1;
            }
            if p.remote_content_changed {
                counts.content_changed += 1;
            }
        }
    }
    // The sweep just refreshed these, so reading them back is free.
    counts.skills_to_push = app
        .state::<crate::skill_watch::SkillWatch>()
        .states()
        .iter()
        .filter(|s| s.status.is_actionable())
        .count() as u32;
    tracing::debug!(
        "catalog_poller: {} outdated, {} drifted, {} skill(s) to push",
        counts.outdated,
        counts.content_changed,
        counts.skills_to_push
    );
    Some(counts)
}

/// Raise a Windows toast when something *newly* needs attention, and only when no
/// visible window could have shown the in-app one — otherwise the user gets both.
fn maybe_notify(
    app: &AppHandle,
    settings: &config::Settings,
    before: &CatalogCounts,
    now: &CatalogCounts,
) {
    let ui = &settings.ui;
    if !ui.native_notifications_enabled || !ui.notify_info {
        return;
    }
    let mut lines: Vec<String> = Vec::new();
    if now.outdated > before.outdated {
        lines.push(format!("{} plugin(s) à mettre à jour", now.outdated));
    }
    if now.content_changed > before.content_changed {
        lines.push(format!(
            "{} plugin(s) dont le contenu distant a changé",
            now.content_changed
        ));
    }
    if now.skills_to_push > before.skills_to_push {
        lines.push(format!(
            "{} compétence(s) à pousser",
            now.skills_to_push
        ));
    }
    if lines.is_empty() {
        return;
    }
    let ui_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if ui_visible {
        return;
    }
    let res = app
        .notification()
        .builder()
        .title("SkillManager")
        .body(lines.join("\n"))
        .show();
    if let Err(e) = res {
        tracing::debug!("catalog_poller: native notification failed: {e}");
    }
}

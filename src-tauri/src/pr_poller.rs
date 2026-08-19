//! Background PR status polling — a Rust worker thread.
//!
//! This used to live in the frontend (`usePrPolling`), which forced the webview
//! to stay alive in the tray purely to keep a `setInterval` running. That was by
//! far the app's most expensive habit at rest: ~400 MB of resident Chromium for
//! a job that is a handful of HTTP GETs a minute. Running it here lets the UI be
//! released entirely while the window is hidden (see `lib::run`).
//!
//! Each tick re-reads settings, so toggling polling or changing its interval in
//! the Settings page takes effect without a restart.
//!
//! On a status transition the worker:
//!   * updates the `pr_history` record and settles the PR (deferred tags on
//!     merge, pending record dropped) via [`crate::commands::finalize_pr_outcome`];
//!   * emits [`EVENT`] so an open UI can refresh its badges and raise an in-app
//!     toast;
//!   * raises a **native** Windows toast itself, but only when no visible window
//!     could have shown the in-app one — otherwise the user would get both.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::commands::{finalize_pr_outcome, gitea_client, pr_status_of};
use crate::config;
use crate::github_client::{GitHubClient, Provider};
use crate::pr_history;

/// Emitted whenever a tracked PR leaves the state we had recorded.
pub const EVENT: &str = "pr-status-changed";

/// Floor on the poll interval, mirroring the frontend's old guard. A tighter
/// loop only burns forge rate limit.
const MIN_INTERVAL_SECS: u64 = 15;
/// How long to idle between checks while polling is switched off. Short enough
/// that re-enabling it in Settings feels immediate.
const DISABLED_POLL_SECS: u64 = 30;

/// Guards against arming the worker twice (the window can be recreated many
/// times over a session; polling must not be).
static STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStatusChange {
    pub repo: String,
    pub number: i64,
    pub title: String,
    /// `"merged"` | `"closed"` — never `"open"`, since only transitions away
    /// from open are reported.
    pub status: String,
}

/// Arm the poller. Idempotent: subsequent calls are no-ops.
pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("pr-poller".into())
        .spawn(move || worker(app));
    tracing::info!("pr_poller: background PR status polling armed");
}

fn worker(app: AppHandle) {
    // Let the first refresh settle before adding network work of our own.
    std::thread::sleep(Duration::from_secs(10));
    loop {
        let settings = config::load_settings();
        if !settings.ui.pr_polling_enabled {
            std::thread::sleep(Duration::from_secs(DISABLED_POLL_SECS));
            continue;
        }
        let interval = (settings.ui.pr_polling_interval_seconds as u64).max(MIN_INTERVAL_SECS);
        tick(&app, &settings);
        std::thread::sleep(Duration::from_secs(interval));
    }
}

fn tick(app: &AppHandle, settings: &config::Settings) {
    let open: Vec<pr_history::PRRecord> = pr_history::load_all()
        .into_iter()
        .filter(|r| r.status == "open")
        .collect();
    if open.is_empty() {
        return;
    }
    tracing::debug!("pr_poller: checking {} open PR(s)", open.len());

    for rec in open {
        let client = match rec.provider {
            Provider::Gitea => gitea_client(settings, &rec.base_url),
            _ => GitHubClient::new(&settings.github_token),
        };
        let client = match client {
            Ok(c) => c,
            Err(e) => {
                tracing::debug!(
                    "pr_poller: client init for {}#{} failed: {}",
                    rec.repo,
                    rec.number,
                    e
                );
                continue;
            }
        };
        let pr = match client.get_pull_request(&rec.repo, rec.number) {
            Ok(v) => v,
            Err(e) => {
                // Networks flap and the Gitea instance is VPN-gated; a failed
                // check is normal and must not be surfaced to the user.
                tracing::debug!(
                    "pr_poller: get PR {}#{} failed: {}",
                    rec.repo,
                    rec.number,
                    e
                );
                continue;
            }
        };
        let status = pr_status_of(&pr);
        if status == "open" {
            continue;
        }
        if let Err(e) = pr_history::update_status(&rec.repo, rec.number, status) {
            tracing::warn!(
                "pr_poller: could not persist status for {}#{}: {}",
                rec.repo,
                rec.number,
                e
            );
        }
        finalize_pr_outcome(&client, &rec.repo, rec.number, &pr, status);
        tracing::info!(
            "pr_poller: PR {}#{} {} → {}",
            rec.repo,
            rec.number,
            rec.status,
            status
        );

        let change = PrStatusChange {
            repo: rec.repo.clone(),
            number: rec.number,
            title: rec.title.clone(),
            status: status.to_string(),
        };
        if let Err(e) = app.emit(EVENT, &change) {
            tracing::debug!("pr_poller: emit failed: {e}");
        }
        maybe_notify(app, settings, &change);
    }
}

/// Raise a Windows toast for `change`, unless a visible window already showed
/// the in-app one or the user has silenced this kind of notification.
fn maybe_notify(app: &AppHandle, settings: &config::Settings, change: &PrStatusChange) {
    let ui = &settings.ui;
    if !ui.native_notifications_enabled {
        return;
    }
    // A merge is a success; a plain close is informational.
    let allowed = if change.status == "merged" {
        ui.notify_success
    } else {
        ui.notify_info
    };
    if !allowed {
        return;
    }
    // With a visible window the frontend's `pr-status-changed` handler raises an
    // in-app toast — don't double up.
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
        .title(format!("PR #{} {}", change.number, change.status))
        .body(format!("{} — {}", change.repo, change.title))
        .show();
    if let Err(e) = res {
        tracing::debug!("pr_poller: native notification failed: {e}");
    }
}

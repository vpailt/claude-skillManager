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
//!
//! A PR the forge no longer knows about is written off after
//! [`MISSING_STRIKES`] consecutive 404s. Without that, a deleted PR stays `open`
//! in the history forever and is re-checked on every single tick.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::commands::{finalize_pr_outcome, gitea_client, pr_status_of};
use crate::config;
use crate::error::Error;
use crate::github_client::{GitHubClient, Provider};
use crate::pending_prs;
use crate::pr_history;

/// Emitted whenever a tracked PR leaves the state we had recorded.
pub const EVENT: &str = "pr-status-changed";

/// Floor on the poll interval, mirroring the frontend's old guard. A tighter
/// loop only burns forge rate limit.
const MIN_INTERVAL_SECS: u64 = 15;
/// How long to idle between checks while polling is switched off. Short enough
/// that re-enabling it in Settings feels immediate.
const DISABLED_POLL_SECS: u64 = 30;

/// Consecutive "not found" answers before a tracked PR is written off as gone.
/// More than one on purpose: a forge can 404 for a transient reason (a proxy
/// hiccup, a repo momentarily unreadable), and there is no way to reopen a
/// wrongly closed record from the UI. Only a real `404` counts — a transport
/// failure never does, or a day off the VPN would bury every tracked PR.
const MISSING_STRIKES: u32 = 3;

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
    // Consecutive-404 tally per PR, reset by any successful read. Deliberately
    // in memory rather than on the record: persisting it would mean rewriting
    // `pr_history.json` on every failing tick, which is exactly the write churn
    // `atomic_write_json` now exists to avoid. Losing the tally on restart only
    // means a gone PR takes a few more ticks to be written off.
    let mut missing: HashMap<(String, i64), u32> = HashMap::new();

    // Let the first refresh settle before adding network work of our own.
    std::thread::sleep(Duration::from_secs(10));
    loop {
        let settings = config::load_settings();
        if !settings.ui.pr_polling_enabled {
            std::thread::sleep(Duration::from_secs(DISABLED_POLL_SECS));
            continue;
        }
        let interval = (settings.ui.pr_polling_interval_seconds as u64).max(MIN_INTERVAL_SECS);
        tick(&app, &settings, &mut missing);
        std::thread::sleep(Duration::from_secs(interval));
    }
}

fn tick(
    app: &AppHandle,
    settings: &config::Settings,
    missing: &mut HashMap<(String, i64), u32>,
) {
    let open: Vec<pr_history::PRRecord> = pr_history::load_all()
        .into_iter()
        .filter(|r| r.status == "open")
        .collect();
    if open.is_empty() {
        missing.clear();
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
        let key = (rec.repo.clone(), rec.number);
        let pr = match client.get_pull_request(&rec.repo, rec.number) {
            Ok(v) => {
                missing.remove(&key);
                v
            }
            Err(Error::NotFound(detail)) => {
                // The forge says this PR does not exist — it was deleted, or its
                // repo was recreated. Give it a few strikes, then write it off so
                // it stops being polled forever.
                let strikes = missing.entry(key.clone()).or_insert(0);
                *strikes += 1;
                if *strikes >= MISSING_STRIKES {
                    missing.remove(&key);
                    write_off_missing(app, &rec);
                } else {
                    tracing::debug!(
                        "pr_poller: PR {}#{} not found ({}/{}): {}",
                        rec.repo,
                        rec.number,
                        strikes,
                        MISSING_STRIKES,
                        detail
                    );
                }
                continue;
            }
            Err(e) => {
                // Networks flap and the Gitea instance is VPN-gated; a failed
                // check is normal, must not be surfaced to the user, and must not
                // count toward writing the PR off.
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

/// Record a PR the forge no longer has as `closed` and drop any pending record
/// still holding it "in review".
///
/// [`EVENT`] is emitted so an open UI resyncs its badges, but **no native toast**
/// is raised: this is housekeeping, not an outcome the user is waiting on, and
/// "PR #17 closed" popping up for something that was deleted days ago would be
/// more confusing than useful.
fn write_off_missing(app: &AppHandle, rec: &pr_history::PRRecord) {
    tracing::info!(
        "pr_poller: PR {}#{} gone from the forge after {} checks — recording it closed",
        rec.repo,
        rec.number,
        MISSING_STRIKES
    );
    if let Err(e) = pr_history::update_status(&rec.repo, rec.number, "closed") {
        tracing::warn!(
            "pr_poller: could not write off {}#{}: {}",
            rec.repo,
            rec.number,
            e
        );
        return;
    }
    if let Err(e) = pending_prs::remove_by_pr(&rec.repo, rec.number) {
        tracing::debug!(
            "pr_poller: could not drop pending record for {}#{}: {}",
            rec.repo,
            rec.number,
            e
        );
    }
    let change = PrStatusChange {
        repo: rec.repo.clone(),
        number: rec.number,
        title: rec.title.clone(),
        status: "closed".to_string(),
    };
    if let Err(e) = app.emit(EVENT, &change) {
        tracing::debug!("pr_poller: emit failed: {e}");
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

//! Watches Claude Code's own install state so changes made *outside* this app
//! show up on their own.
//!
//! `~/.claude/` is shared ground: `/plugin install`, `/plugin uninstall` and the
//! enable/disable toggles all write there, as does anyone editing the JSON by
//! hand. Nothing was listening, so a plugin installed from a terminal stayed
//! invisible until the user alt-tabbed into the window (a focus refetch) or the
//! 30-minute timer came round — and in tray mode, where the webview is
//! destroyed, neither of those happens.
//!
//! This is deliberately dumber than [`crate::skill_watch`]: it reads nothing,
//! compares nothing, and classifies nothing. It only says "the install state
//! moved", and the refresh sweep — the only thing that can actually interpret it
//! — does the rest.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::config;

/// Emitted when anything under Claude's install state changed on disk.
pub const EVENT: &str = "claude-state-changed";

static STARTED: AtomicBool = AtomicBool::new(false);

/// How many [`QuietGuard`]s are alive — the app is writing to `~/.claude` itself.
static QUIET_DEPTH: AtomicUsize = AtomicUsize::new(0);
/// Unix millis until which events stay ignored after the last guard dropped.
static QUIET_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
/// Filesystem events land a beat after the writes that caused them, so the
/// window has to outlive the guard itself.
const QUIET_GRACE_MS: u64 = 2_500;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// True while this app is the one writing to `~/.claude`.
fn is_quiet() -> bool {
    QUIET_DEPTH.load(Ordering::SeqCst) > 0 || now_ms() < QUIET_UNTIL_MS.load(Ordering::SeqCst)
}

/// Silences this watcher while the app writes to `~/.claude` itself, and for a
/// short grace period after.
///
/// The refresh sweep re-extracts every auto-updating marketplace, rewriting
/// `known_marketplaces.json` and the marketplace directories. Without this the
/// watcher reported the app's own writes as an outside change, the frontend
/// asked for a refresh, and that refresh made the same writes again — a sweep
/// triggering the next one for as long as anything was auto-updating.
///
/// It only suppresses *our* writes: anything Claude Code (or a text editor)
/// does outside the guard's lifetime still wakes the sweep, which is the whole
/// point of the watcher.
pub struct QuietGuard(());

impl Drop for QuietGuard {
    fn drop(&mut self) {
        QUIET_UNTIL_MS.store(now_ms() + QUIET_GRACE_MS, Ordering::SeqCst);
        QUIET_DEPTH.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Take a [`QuietGuard`]; hold it for the duration of a write to `~/.claude`.
pub fn quiet_guard() -> QuietGuard {
    QUIET_DEPTH.fetch_add(1, Ordering::SeqCst);
    QuietGuard(())
}
/// Holds the watcher for the process lifetime — dropping it stops the watch.
static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

/// Arm the watcher. Idempotent; safe to call before the paths exist (a missing
/// directory is simply skipped, and the next launch picks it up).
pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            // Metadata-only events (an access-time bump from a reader) are not
            // state changes and would wake the sweep for nothing.
            if matches!(
                ev.kind,
                notify::EventKind::Create(_)
                    | notify::EventKind::Modify(_)
                    | notify::EventKind::Remove(_)
            ) && !is_quiet()
            {
                let _ = tx.send(());
            }
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("claude_watch: could not create fs watcher: {e}");
            return;
        }
    };

    let mut watcher = watcher;
    // `plugins/` non-recursively: `installed_plugins.json` and
    // `known_marketplaces.json` live there, and so does `marketplaces/` — whose
    // *contents* are re-pulled by our own auto-update on every sweep. Watching it
    // recursively would make the app wake itself in a loop.
    let targets: Vec<(PathBuf, RecursiveMode)> = vec![
        (config::claude_plugins_dir(), RecursiveMode::NonRecursive),
        // `~/.claude` itself, for `settings.json` — where `enabledPlugins` lives.
        (config::claude_home(), RecursiveMode::NonRecursive),
    ];
    let mut armed = 0usize;
    for (path, mode) in targets {
        if !path.is_dir() {
            tracing::debug!("claude_watch: {} does not exist — skipped", path.display());
            continue;
        }
        match watcher.watch(&path, mode) {
            Ok(()) => armed += 1,
            Err(e) => tracing::debug!("claude_watch: watch {} failed: {e}", path.display()),
        }
    }
    if armed == 0 {
        tracing::warn!("claude_watch: nothing to watch — Claude install not found");
        return;
    }

    *WATCHER.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
    let _ = std::thread::Builder::new()
        .name("claude-watch".into())
        .spawn(move || {
            while rx.recv().is_ok() {
                // Coalesce a burst — Claude Code rewrites several files per
                // operation, and each atomic write is create + rename.
                while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
                // A write of ours may have started while the burst was
                // coalescing; re-check rather than announce our own change.
                if is_quiet() {
                    continue;
                }
                tracing::debug!("claude_watch: install state changed on disk");
                if let Err(e) = app.emit(EVENT, ()) {
                    tracing::debug!("claude_watch: emit failed: {e}");
                }
            }
        });
    tracing::info!("claude_watch: watching Claude install state ({armed} path(s))");
}

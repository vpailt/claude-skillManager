//! Persisted notification history — what the status bar's bell reads back.
//!
//! The in-app notification store keeps two lists: a toast queue that empties
//! itself after eight seconds, and a history that does not. The history was
//! memory-only, which undid most of its point: the frontend store dies with the
//! webview, and `ui.tray.release.ui` *destroys* the window on every close — so
//! the list was wiped by the ordinary way of using the app, not merely by a
//! restart.
//!
//! It lives here rather than in the frontend for the same reason `pr_poller`
//! and `catalog_poller` do: nothing user-visible may depend on the frontend
//! being alive. A notification raised by a background thread while no window
//! exists can be written straight here.
//!
//! One thing deliberately does **not** survive: `onClick`. A notification may
//! carry an in-app action (open the exported file, follow a PR link), and that
//! is a closure — it cannot be serialised, and re-creating it from a stored
//! payload would mean the panel offering an action that no longer does what it
//! said. Restored entries are text.

use crate::config;
use crate::error::{Error, Result};
use crate::installer::atomic_write_json;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const FILE_NAME: &str = "notifications.json";

/// Same cap the frontend store applied in memory. Old enough to answer "what
/// did that toast say?", short enough that the panel stays scannable.
const MAX_ENTRIES: usize = 50;

/// Serialises read-modify-write. Notifications arrive in bursts — a bulk run
/// raises one per failed operation — and two overlapping pushes would each read
/// the same list and write back a copy missing the other's entry.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredNotification {
    pub id: String,
    /// `info` | `success` | `warning` | `error`, as the frontend's
    /// `NotificationKind`. Kept a plain string: this module never branches on
    /// it, and a new kind should not need a migration here.
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    /// Epoch milliseconds, matching `Date.now()` on the frontend side, which is
    /// what renders it.
    pub created_at: i64,
}

fn file() -> PathBuf {
    config::app_settings_dir().join(FILE_NAME)
}

/// Newest first, the order the panel renders.
pub fn load_all() -> Vec<StoredNotification> {
    let f = file();
    if !f.exists() {
        return Vec::new();
    }
    fs::read_to_string(&f)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<StoredNotification>>(&s).ok())
        .unwrap_or_default()
}

fn save_all(items: &[StoredNotification]) -> Result<()> {
    let f = file();
    if let Some(parent) = f.parent() {
        fs::create_dir_all(parent).map_err(Error::from)?;
    }
    let value = serde_json::to_value(items)?;
    atomic_write_json(&f, &value)
}

/// Record one notification. Newest first, capped, duplicate ids replaced.
pub fn add(entry: StoredNotification) -> Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut items = load_all();
    items.retain(|it| it.id != entry.id);
    items.insert(0, entry);
    items.truncate(MAX_ENTRIES);
    save_all(&items)
}

/// Forget one entry — the × in the panel.
pub fn remove(id: &str) -> Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let items = load_all();
    let before = items.len();
    let kept: Vec<StoredNotification> = items.into_iter().filter(|it| it.id != id).collect();
    if kept.len() != before {
        save_all(&kept)?;
    }
    Ok(())
}

pub fn clear_all() -> Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    save_all(&[])
}

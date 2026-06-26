//! Watches the user's editable skill folders and flags those whose on-disk
//! content drifts from a stored baseline — the "you edited this skill, want to
//! push it?" signal behind the Skills-tab badge.
//!
//! Two cooperating mechanisms:
//!   * a `notify` filesystem watcher gives real-time detection while the app is
//!     open (a save in VS Code flips the badge within ~250 ms);
//!   * a persisted content-hash baseline (`<exe_dir>/config/skill_baselines.json`)
//!     is the comparison basis AND catches edits made while the app was closed
//!     (re-scanned on every `set_watched`, i.e. every refresh).
//!
//! A folder's baseline is (re)captured when it's first seen and after a PR is
//! opened for it (`mark_synced`). "Dirty" = current content hash differs from
//! that baseline. The authoritative remote diff is still computed later by the
//! upload-skill wizard; this is only the cheap local nudge.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::config;
use crate::installer;

/// Path segments never hashed — mirrors `admin::DEFAULT_SKIP` so the local hash
/// and the eventual uploaded file set agree on what counts as content.
const SKIP: &[&str] = &[".git", "__pycache__", ".DS_Store"];

const BASELINE_FILE: &str = "skill_baselines.json";
/// Tauri event emitted when a folder's dirty flag flips.
const EVENT: &str = "skill-dirty";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyState {
    /// The folder path exactly as the frontend passed it, so it round-trips to
    /// `skill.folder` for badge lookup regardless of canonicalization.
    pub folder: String,
    pub dirty: bool,
}

#[derive(Default)]
struct Shared {
    /// Folder paths (as the frontend passed them) currently being watched.
    roots: Vec<String>,
    /// folder input string -> content hash captured at baseline.
    baselines: HashMap<String, u64>,
    /// folder input strings currently considered dirty.
    dirty: HashSet<String>,
}

/// Managed Tauri state: holds the live watcher, the watched-path set, and the
/// shared baseline/dirty bookkeeping. `Send + Sync` so it can be `manage`d.
pub struct SkillWatch {
    shared: Arc<Mutex<Shared>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    /// Canonical paths currently registered with the OS watcher.
    watched: Mutex<HashSet<PathBuf>>,
}

impl Default for SkillWatch {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillWatch {
    pub fn new() -> Self {
        SkillWatch {
            shared: Arc::new(Mutex::new(Shared {
                baselines: load_baselines(),
                ..Default::default()
            })),
            watcher: Mutex::new(None),
            watched: Mutex::new(HashSet::new()),
        }
    }

    /// Replace the watched set, (re)compute each folder's dirty state, and
    /// return it so the frontend can seed its badge map. A folder seen for the
    /// first time has its current content captured as the baseline (so first
    /// sight is never "dirty"). Also re-arms the OS watcher to the new set.
    pub fn set_watched(&self, app: &AppHandle, folders: Vec<String>) -> Vec<DirtyState> {
        self.ensure_started(app);

        // Dedup + hash outside the lock — folder IO shouldn't block other
        // commands that briefly touch `shared`.
        let mut seen: HashSet<String> = HashSet::new();
        let mut computed: Vec<(String, u64)> = Vec::new();
        let mut new_canon: HashSet<PathBuf> = HashSet::new();
        for input in folders {
            if input.trim().is_empty() || !seen.insert(input.clone()) {
                continue;
            }
            new_canon.insert(std::fs::canonicalize(&input).unwrap_or_else(|_| PathBuf::from(&input)));
            let hash = hash_folder(Path::new(&input));
            computed.push((input, hash));
        }

        let mut out = Vec::with_capacity(computed.len());
        {
            let mut sh = self.shared.lock();
            let mut roots = Vec::with_capacity(computed.len());
            let mut baseline_changed = false;
            for (input, hash) in computed {
                let baseline = match sh.baselines.get(&input) {
                    Some(&b) => b,
                    None => {
                        sh.baselines.insert(input.clone(), hash);
                        baseline_changed = true;
                        hash
                    }
                };
                let dirty = hash != baseline;
                if dirty {
                    sh.dirty.insert(input.clone());
                } else {
                    sh.dirty.remove(&input);
                }
                out.push(DirtyState {
                    folder: input.clone(),
                    dirty,
                });
                roots.push(input);
            }
            sh.roots = roots;
            if baseline_changed {
                save_baselines(&sh.baselines);
            }
        }

        self.rearm(new_canon);
        out
    }

    /// Capture the folder's current content as its new baseline and clear its
    /// dirty flag — called once a PR has been opened for it.
    pub fn mark_synced(&self, folder: &str) {
        let hash = hash_folder(Path::new(folder));
        let mut sh = self.shared.lock();
        sh.baselines.insert(folder.to_string(), hash);
        sh.dirty.remove(folder);
        save_baselines(&sh.baselines);
    }

    /// Current dirty set (re-seeds the UI without forcing a rescan).
    pub fn dirty_list(&self) -> Vec<DirtyState> {
        let sh = self.shared.lock();
        sh.roots
            .iter()
            .map(|input| DirtyState {
                folder: input.clone(),
                dirty: sh.dirty.contains(input),
            })
            .collect()
    }

    /// Lazily create the watcher + debounce worker the first time we have an
    /// `AppHandle` to emit through. Idempotent.
    fn ensure_started(&self, app: &AppHandle) {
        let mut w = self.watcher.lock();
        if w.is_some() {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let watcher = match notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                // Coalesce everything to a "something changed" ping; the worker
                // re-scans the (small) watched set. We don't route by path here —
                // canonicalization mismatches make per-path matching flaky.
                if res.is_ok() {
                    let _ = tx.send(());
                }
            },
        ) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("skill_watch: could not create fs watcher: {e}");
                return;
            }
        };
        let shared = self.shared.clone();
        let app = app.clone();
        let _ = std::thread::Builder::new()
            .name("skill-watch".into())
            .spawn(move || worker_loop(rx, shared, app));
        *w = Some(watcher);
        tracing::info!("skill_watch: filesystem watcher started");
    }

    /// Diff the OS watch set against `new_canon`: unwatch removed folders, watch
    /// added ones. Keeps the watcher alive across refreshes instead of tearing
    /// it down each time.
    fn rearm(&self, new_canon: HashSet<PathBuf>) {
        let mut wopt = self.watcher.lock();
        let Some(watcher) = wopt.as_mut() else {
            return;
        };
        let mut watched = self.watched.lock();
        for p in watched.difference(&new_canon).cloned().collect::<Vec<_>>() {
            let _ = watcher.unwatch(&p);
            watched.remove(&p);
        }
        for p in new_canon.difference(&watched).cloned().collect::<Vec<_>>() {
            if !p.is_dir() {
                continue;
            }
            match watcher.watch(&p, RecursiveMode::Recursive) {
                Ok(()) => {
                    watched.insert(p);
                }
                Err(e) => tracing::debug!("skill_watch: watch {} failed: {e}", p.display()),
            }
        }
    }
}

fn worker_loop(rx: Receiver<()>, shared: Arc<Mutex<Shared>>, app: AppHandle) {
    while rx.recv().is_ok() {
        // Debounce a burst of save events (editors fire several per save) into
        // one re-scan.
        while rx.recv_timeout(Duration::from_millis(250)).is_ok() {}
        for ds in rescan(&shared) {
            if let Err(e) = app.emit(EVENT, &ds) {
                tracing::debug!("skill_watch: emit failed: {e}");
            }
        }
    }
}

/// Recompute every root's hash, update the dirty set, and return only the
/// folders whose dirty flag actually flipped (so emitted events stay minimal).
fn rescan(shared: &Arc<Mutex<Shared>>) -> Vec<DirtyState> {
    let mut sh = shared.lock();
    let roots: Vec<(String, u64)> = sh
        .roots
        .iter()
        .filter_map(|input| sh.baselines.get(input).map(|b| (input.clone(), *b)))
        .collect();
    let mut changed = Vec::new();
    for (input, baseline) in roots {
        let dirty = hash_folder(Path::new(&input)) != baseline;
        let was = sh.dirty.contains(&input);
        if dirty == was {
            continue;
        }
        if dirty {
            sh.dirty.insert(input.clone());
        } else {
            sh.dirty.remove(&input);
        }
        changed.push(DirtyState {
            folder: input,
            dirty,
        });
    }
    changed
}

/// Order-independent content hash of every file under `folder` (path + bytes),
/// skipping the [`SKIP`] segments. `DefaultHasher` (SipHash, std, fixed keys) is
/// deterministic across runs so the persisted baseline stays comparable — no
/// crypto-hash dependency needed for a "did it change" check.
fn hash_folder(folder: &Path) -> u64 {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for entry in WalkDir::new(folder).sort_by_file_name() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = match entry.path().strip_prefix(folder) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let parts: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        if parts.iter().any(|p| SKIP.contains(&p.as_str())) {
            continue;
        }
        match std::fs::read(entry.path()) {
            Ok(bytes) => files.push((parts.join("/"), bytes)),
            Err(_) => continue,
        }
    }
    files.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    files.len().hash(&mut h);
    for (path, bytes) in files {
        path.hash(&mut h);
        bytes.hash(&mut h);
    }
    h.finish()
}

fn baseline_path() -> PathBuf {
    config::app_settings_dir().join(BASELINE_FILE)
}

fn load_baselines() -> HashMap<String, u64> {
    let Ok(text) = std::fs::read_to_string(baseline_path()) else {
        return HashMap::new();
    };
    let Ok(val) = serde_json::from_str::<Value>(&text) else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    if let Some(obj) = val.as_object() {
        for (k, v) in obj {
            // Hashes are stored as strings to dodge JSON's 2^53 integer limit.
            if let Some(n) = v.as_str().and_then(|s| s.parse::<u64>().ok()) {
                out.insert(k.clone(), n);
            }
        }
    }
    out
}

fn save_baselines(map: &HashMap<String, u64>) {
    let mut obj = Map::new();
    for (k, v) in map {
        obj.insert(k.clone(), Value::String(v.to_string()));
    }
    if let Err(e) = installer::atomic_write_json(&baseline_path(), &Value::Object(obj)) {
        tracing::warn!("skill_watch: could not persist baselines: {e}");
    }
}

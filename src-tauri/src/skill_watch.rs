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
//! opened for it (`mark_synced`). "Dirty" = current hash differs from that
//! baseline. The authoritative remote diff is still computed later by the
//! upload-skill wizard; this is only the cheap local nudge.
//!
//! ## Why the hash is metadata-only
//!
//! [`hash_folder`] hashes each file's *relative path + size + mtime*, never its
//! bytes. Reading the contents meant pulling ~3 MB off disk for a typical
//! install on every single filesystem event — for a signal whose only job is to
//! light up a badge. Metadata catches every real edit (an editor save always
//! moves mtime) and costs a `stat` that `walkdir` already has in hand from the
//! directory listing. The trade is that a byte-identical rewrite now reads as
//! "modified"; the upload wizard's remote diff still tells the truth.

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
/// Baseline schema. Bumped when [`hash_folder`] changes meaning: v1 held content
/// hashes, v2 holds metadata hashes. A mismatch drops the whole file rather than
/// migrating — stale values would read as "every skill was modified".
const BASELINE_VERSION: u32 = 2;
/// Folders explicitly flagged "new, not yet pushed" (persisted set).
const PENDING_NEW_FILE: &str = "skill_new.json";
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
    /// Folders explicitly flagged as "new, not yet pushed" (a skill just created
    /// inside a plugin). Always read dirty regardless of their content hash until
    /// a PR is opened for them (`mark_synced`). Persisted so the nudge survives a
    /// refresh (which re-captures a first-sight baseline) and an app restart.
    pending_new: HashSet<String>,
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
                pending_new: load_pending_new(),
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
                // A folder flagged "new, not yet pushed" stays dirty regardless of
                // its baseline (first-sight would otherwise read clean).
                let dirty = sh.pending_new.contains(&input) || hash != baseline;
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
            // Drop baselines for folders that no longer exist. They accumulate
            // forever otherwise — every plugin version bump strands the previous
            // version's skill folders (measured: 372 entries, 136 of them dead).
            // Pruning on *existence* rather than on "absent from the watched set"
            // is deliberate: the watched set collapses to empty whenever the
            // forge is unreachable (`editable` degrades to false), and wiping
            // baselines then would lose every pending "you edited this" flag.
            let before = sh.baselines.len();
            sh.baselines.retain(|k, _| Path::new(k).is_dir());
            let pruned = before - sh.baselines.len();
            if pruned > 0 {
                let alive: Vec<String> = sh.baselines.keys().cloned().collect();
                sh.dirty.retain(|k| alive.contains(k));
                tracing::debug!("skill_watch: pruned {pruned} baseline(s) for removed folders");
            }
            if baseline_changed || pruned > 0 {
                save_baselines(&sh.baselines);
            }
        }

        self.rearm(new_canon);
        out
    }

    /// Capture the folder's current content as its new baseline and clear its
    /// dirty flag — called once a PR has been opened for it. Also clears any
    /// "new, not yet pushed" flag so the folder stops reading dirty.
    pub fn mark_synced(&self, folder: &str) {
        let hash = hash_folder(Path::new(folder));
        let mut sh = self.shared.lock();
        sh.baselines.insert(folder.to_string(), hash);
        sh.dirty.remove(folder);
        if sh.pending_new.remove(folder) {
            save_pending_new(&sh.pending_new);
        }
        save_baselines(&sh.baselines);
    }

    /// Flag a freshly-created skill folder as "new, not yet pushed": persist it,
    /// add it to the watched roots + dirty set, and emit a `skill-dirty` event so
    /// the badge lights up immediately (before the next refresh re-arms the
    /// watcher). Stays dirty until `mark_synced` (a PR was opened) or
    /// `forget_under` (the plugin was reinstalled/removed).
    pub fn mark_new(&self, app: &AppHandle, folder: &str) {
        self.ensure_started(app);
        {
            let mut sh = self.shared.lock();
            sh.pending_new.insert(folder.to_string());
            sh.dirty.insert(folder.to_string());
            if !sh.roots.iter().any(|r| r == folder) {
                sh.roots.push(folder.to_string());
            }
            // Capture a baseline now so a later real edit is still detectable.
            let hash = hash_folder(Path::new(folder));
            sh.baselines.insert(folder.to_string(), hash);
            save_pending_new(&sh.pending_new);
            save_baselines(&sh.baselines);
        }
        // Watch the new folder so subsequent edits fire the live watcher too.
        let canon = std::fs::canonicalize(folder).unwrap_or_else(|_| PathBuf::from(folder));
        if let Some(watcher) = self.watcher.lock().as_mut() {
            if canon.is_dir() {
                let mut watched = self.watched.lock();
                if watched.insert(canon.clone()) {
                    let _ = watcher.watch(&canon, RecursiveMode::Recursive);
                }
            }
        }
        if let Err(e) = app.emit(
            EVENT,
            &DirtyState {
                folder: folder.to_string(),
                dirty: true,
            },
        ) {
            tracing::debug!("skill_watch: mark_new emit failed: {e}");
        }
    }

    /// Drop every persisted baseline (and dirty flag) for skill folders at or
    /// under `root`. Called right after an install overwrites a plugin's folder
    /// or an uninstall removes it: the on-disk content is then the new truth, so
    /// a stale baseline from a *previous* install must not linger and read as
    /// "you edited this skill". The next `set_watched` re-captures the survivors
    /// as first-sight (never dirty). Path matching is normalized (strips the
    /// Windows `\\?\` prefix, unifies separators, case-folds) so it works
    /// regardless of how the watched-folder string was formatted.
    pub fn forget_under(&self, root: &Path) {
        let root_norm = norm_path(&root.to_string_lossy());
        if root_norm.is_empty() {
            return;
        }
        let prefix = format!("{root_norm}/");
        let under = |k: &str| {
            let kn = norm_path(k);
            kn == root_norm || kn.starts_with(&prefix)
        };
        let mut sh = self.shared.lock();
        let before = sh.baselines.len();
        sh.baselines.retain(|k, _| !under(k));
        sh.dirty.retain(|k| !under(k));
        let pending_before = sh.pending_new.len();
        sh.pending_new.retain(|k| !under(k));
        let dropped = before - sh.baselines.len();
        if dropped > 0 {
            save_baselines(&sh.baselines);
            tracing::info!(
                "skill_watch: forgot {dropped} baseline(s) under {}",
                root.display()
            );
        }
        if sh.pending_new.len() != pending_before {
            save_pending_new(&sh.pending_new);
        }
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
        let (tx, rx) = std::sync::mpsc::channel::<Vec<PathBuf>>();
        let watcher = match notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                // Forward the changed paths so the worker can re-hash only the
                // roots they fall under. Canonicalization mismatches make that
                // match unreliable, so an empty or unmatched path set degrades to
                // a full rescan rather than a missed change (see `rescan`).
                if let Ok(ev) = res {
                    let _ = tx.send(ev.paths);
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

fn worker_loop(rx: Receiver<Vec<PathBuf>>, shared: Arc<Mutex<Shared>>, app: AppHandle) {
    while let Ok(first) = rx.recv() {
        // Debounce a burst of save events (editors fire several per save) into
        // one re-scan, accumulating every path the burst touched.
        let mut touched = first;
        while let Ok(more) = rx.recv_timeout(Duration::from_millis(250)) {
            touched.extend(more);
        }
        for ds in rescan(&shared, &touched) {
            if let Err(e) = app.emit(EVENT, &ds) {
                tracing::debug!("skill_watch: emit failed: {e}");
            }
        }
    }
}

/// Recompute the affected roots' hashes, update the dirty set, and return only
/// the folders whose dirty flag actually flipped (so emitted events stay
/// minimal).
///
/// `touched` is the set of paths the filesystem burst reported. Only roots those
/// paths fall under are re-hashed — an edit under one skill cannot change
/// another's hash. An empty `touched`, or one matching no root (a
/// canonicalization mismatch), falls back to re-hashing everything: missing a
/// change is worse than the extra work.
///
/// Hashing happens **outside** the lock. `rescan` used to hold `shared` for the
/// whole walk, so one filesystem event blocked every command touching the
/// watcher state.
fn rescan(shared: &Arc<Mutex<Shared>>, touched: &[PathBuf]) -> Vec<DirtyState> {
    let snapshot: Vec<(String, u64, bool)> = {
        let sh = shared.lock();
        sh.roots
            .iter()
            .filter_map(|input| {
                sh.baselines
                    .get(input)
                    .map(|b| (input.clone(), *b, sh.pending_new.contains(input)))
            })
            .collect()
    };

    let selected: Vec<&(String, u64, bool)> = {
        let norms: Vec<String> = touched
            .iter()
            .map(|p| norm_path(&p.to_string_lossy()))
            .collect();
        let hit: Vec<&(String, u64, bool)> = snapshot
            .iter()
            .filter(|(input, _, _)| {
                let rn = norm_path(input);
                let prefix = format!("{rn}/");
                norms.iter().any(|n| *n == rn || n.starts_with(&prefix))
            })
            .collect();
        if hit.is_empty() {
            snapshot.iter().collect()
        } else {
            hit
        }
    };

    let computed: Vec<(String, bool)> = selected
        .iter()
        .map(|(input, baseline, is_new)| {
            (
                input.clone(),
                *is_new || hash_folder(Path::new(input)) != *baseline,
            )
        })
        .collect();

    let mut sh = shared.lock();
    let mut changed = Vec::new();
    for (input, dirty) in computed {
        // A refresh may have re-armed the watched set while we were hashing —
        // don't resurrect a root that is no longer watched.
        if !sh.roots.iter().any(|r| *r == input) {
            continue;
        }
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

/// Order-independent hash of every file under `folder` — relative path, size and
/// mtime — skipping the [`SKIP`] segments. `DefaultHasher` (SipHash, std, fixed
/// keys) is deterministic across runs so the persisted baseline stays
/// comparable; no crypto-hash dependency is needed for a "did it change" check.
///
/// Deliberately **does not read file contents**: `walkdir` already carries the
/// metadata from the directory listing, so this costs one already-paid `stat`
/// per file instead of a full read of the tree. See the module docs.
fn hash_folder(folder: &Path) -> u64 {
    let mut files: Vec<(String, u64, u64)> = Vec::new();
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
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        files.push((parts.join("/"), meta.len(), mtime));
    }
    files.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    files.len().hash(&mut h);
    for (path, len, mtime) in files {
        path.hash(&mut h);
        len.hash(&mut h);
        mtime.hash(&mut h);
    }
    h.finish()
}

/// Normalize a path string for prefix comparison: strip the Windows long-path
/// prefix, unify separators to `/`, drop any trailing slash, and case-fold
/// (Windows paths are case-insensitive). Both sides come from app-constructed
/// cache paths, so this only needs to absorb formatting differences, not resolve
/// symlinks.
fn norm_path(p: &str) -> String {
    let p = p.strip_prefix(r"\\?\").unwrap_or(p);
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
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
    // Anything that isn't the current schema is discarded — notably the v1 flat
    // map of *content* hashes, whose values mean nothing to the metadata hash.
    // Starting empty makes every folder first-sight, i.e. clean.
    if val.get("version").and_then(Value::as_u64) != Some(BASELINE_VERSION as u64) {
        return HashMap::new();
    }
    let mut out = HashMap::new();
    if let Some(obj) = val.get("baselines").and_then(Value::as_object) {
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
    let mut root = Map::new();
    root.insert("version".into(), Value::from(BASELINE_VERSION));
    root.insert("baselines".into(), Value::Object(obj));
    if let Err(e) = installer::atomic_write_json(&baseline_path(), &Value::Object(root)) {
        tracing::warn!("skill_watch: could not persist baselines: {e}");
    }
}

fn pending_new_path() -> PathBuf {
    config::app_settings_dir().join(PENDING_NEW_FILE)
}

fn load_pending_new() -> HashSet<String> {
    let Ok(text) = std::fs::read_to_string(pending_new_path()) else {
        return HashSet::new();
    };
    serde_json::from_str::<Vec<String>>(&text)
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn save_pending_new(set: &HashSet<String>) {
    let arr: Vec<Value> = set.iter().cloned().map(Value::String).collect();
    if let Err(e) = installer::atomic_write_json(&pending_new_path(), &Value::Array(arr)) {
        tracing::warn!("skill_watch: could not persist pending-new set: {e}");
    }
}

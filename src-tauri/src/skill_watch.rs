//! Tracks where every local skill folder stands relative to its plugin's remote
//! repo — the state behind the Skills-tab badges and the "push this" affordances.
//!
//! ## The contract: the watcher triggers, the refresh decides
//!
//! Two cooperating halves, and the split is the whole design:
//!
//! * a `notify` filesystem watcher gives **immediacy**. On an event it re-hashes
//!   only the folders the event touched, and only their *metadata* (path + size
//!   + mtime) — no file contents, no network. It can therefore say "something
//!   moved here" within ~250 ms of a save, and nothing more.
//! * the refresh pipeline gives **truth**. It knows what the plugin's repo
//!   actually holds (a single recursive git-tree read per plugin yields every
//!   file's blob SHA), so it can settle each folder exactly: identical, edited,
//!   never pushed, or deleted locally.
//!
//! ## Why the old baseline model kept being wrong
//!
//! This module used to store one hash per folder, captured the first time the
//! folder was seen, and call any later drift "dirty". Three consequences, all of
//! them silent:
//!
//! * a folder seen for the first time was **clean by construction** — so a skill
//!   created by hand, by Claude Code, or by a `git checkout` never surfaced, and
//!   only the in-app "add skill" path flagged anything;
//! * after a baseline-schema bump, a plugin reinstall, or a fresh install of
//!   SkillManager, every pre-existing local modification was adopted as the new
//!   reference and reported as clean;
//! * a deletion was indistinguishable from a skill that had never been installed.
//!
//! The fix is to stop letting local history define the reference. The reference
//! is now the remote itself: [`content_sig`] hashes the folder into the same
//! shape a git tree gives us (relative path → blob SHA), so local and remote
//! compare exactly. `synced_sig` remembers the last signature confirmed equal to
//! the remote, which is what keeps the verdict meaningful while the forge is
//! unreachable.
//!
//! ## Why reading bytes here is still cheap
//!
//! [`content_sig`] does read every file, so the metadata hash gates it: a folder
//! whose `meta` is unchanged reuses its cached `sig`, and a steady-state sweep
//! therefore reads **zero** file bytes. A filesystem event reads only the folders
//! the debounced burst actually touched — typically one. That bound is what made
//! the original whole-tree content hash expensive (~3 MB per event, under the
//! shared mutex), not the reading itself.
//!
//! Reading on an event is what lets the watcher *retract* a verdict, not just
//! raise one. An earlier revision only ever raised `Modified` and waited for the
//! next sweep to correct it, which left the badge lit for up to the sweep
//! interval after an edit was undone — half an hour on the shipped default. A
//! stale badge is tolerable; a wrong one is the bug this module exists to fix.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::config;
use crate::installer;
use crate::models::SkillSync;

/// Path segments never hashed — mirrors [`crate::admin::DEFAULT_SKIP`] so the
/// local signature and the eventual uploaded file set agree on what counts as
/// content. Keep the two in step: a file counted here but not uploaded pins the
/// skill to `Modified` with nothing the user can do about it.
const SKIP: &[&str] = &[".git", "__pycache__", ".DS_Store", ".sf"];

const BASELINE_FILE: &str = "skill_baselines.json";
/// Baseline schema. v1 held content hashes, v2 metadata hashes, v3 holds
/// `{meta, sig, syncedSig}`. A mismatch drops the whole file rather than
/// migrating — but unlike v1→v2, that is no longer a detection outage: with the
/// remote as the reference, an empty baseline map only costs one extra content
/// hash per folder on the next refresh, not a wrongly-clean verdict.
const BASELINE_VERSION: u32 = 3;
/// Folders explicitly flagged "new, not yet pushed" (persisted set).
const PENDING_NEW_FILE: &str = "skill_new.json";
/// Folders the app deleted on purpose, whose removal is not pushed yet.
const PENDING_DELETED_FILE: &str = "skill_deleted.json";
/// Emitted when a folder's sync status changes.
const EVENT: &str = "skill-sync-changed";
/// Emitted when the *set* of skill folders changed on disk (a folder appeared or
/// disappeared under a watched plugin). The frontend answers by invalidating the
/// refresh query — classifying the newcomer needs the remote, which only the
/// refresh reads.
pub const EVENT_TREE: &str = "skills-tree-changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillState {
    /// The folder path exactly as the caller passed it, so it round-trips to
    /// `skill.folder` for badge lookup regardless of canonicalization.
    pub folder: String,
    pub status: SkillSync,
}

/// What the refresh pipeline knows about one skill folder's remote counterpart.
#[derive(Debug, Clone)]
pub struct SkillInput {
    pub folder: String,
    /// Whether the plugin repo's skill listing was actually read. `false` ⇒
    /// `remote_present` and `remote_blobs` carry no information.
    pub remote_known: bool,
    /// Whether the remote holds a skill folder at this path.
    pub remote_present: bool,
    /// The remote folder's contents as `(relative path, git blob SHA)`.
    ///
    /// The full list rather than just its signature: a scalar can only say
    /// "different", and the first question anyone asks of a skill flagged
    /// `Modified` is *which file*. [`explain`] answers that from this.
    pub remote_blobs: Option<Vec<(String, String)>>,
}

/// A skill the remote holds at a path where nothing exists locally. Only becomes
/// [`SkillSync::Deleted`] when we hold a baseline for it — i.e. we watched that
/// folder before. Without that evidence it is simply a skill this install never
/// had, which is not the same thing at all.
#[derive(Debug, Clone)]
pub struct MissingLocal {
    pub folder: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
struct Baseline {
    /// Cheap metadata hash (path + size + mtime). Guards `sig`: unchanged `meta`
    /// means the cached `sig` is still valid, so no bytes are read.
    meta: u64,
    /// Content signature of the folder at the time `meta` was captured.
    sig: u64,
    /// The last signature confirmed identical to the remote (or accepted as the
    /// new reference when a PR was opened). This is the durable reference that
    /// keeps `Modified` meaningful while the forge is unreachable.
    synced_sig: Option<u64>,
}

#[derive(Default)]
struct Shared {
    /// Skill folder paths (as the caller passed them), in display order.
    roots: Vec<String>,
    /// Plugin directories watched recursively. A filesystem event landing under
    /// one of these but under no `roots` entry means a skill folder was created
    /// or removed.
    plugin_roots: Vec<String>,
    baselines: HashMap<String, Baseline>,
    /// Last authoritative status per folder.
    status: HashMap<String, SkillSync>,
    /// Signature of each folder's remote counterpart, from the last sweep that
    /// could read it. In memory only — it describes a remote we may no longer be
    /// able to reach, and `synced_sig` is the durable fallback.
    ///
    /// This is what lets a filesystem event *retract* a `Modified` verdict, not
    /// just raise one. Without it the watcher could only ever say "something
    /// moved", and reverting an edit left the badge lit until the next sweep —
    /// up to half an hour of a badge that is simply wrong.
    remote_sig: HashMap<String, u64>,
    /// Folders explicitly flagged "new, not yet pushed" — a skill just created
    /// in-app, before any refresh could ask the remote about it. Purely
    /// optimistic: once the remote listing lands, absence from it is what makes a
    /// skill `New`, and this set stops mattering. Persisted so the nudge survives
    /// a restart while offline.
    pending_new: HashSet<String>,
    /// Folders this app deleted locally, whose removal has not been pushed yet.
    ///
    /// Not an optimisation: it is the only thing that keeps such a deletion
    /// alive across a sweep that could not reach the forge. With no remote
    /// listing there is no `MissingLocal`, the folder leaves `roots`, and the
    /// prune in `sync` drops the baseline that proves we ever had it — turning
    /// "you deleted this" into "never installed here", permanently.
    pending_deleted: HashSet<String>,
}

/// Managed Tauri state: the live watcher plus the shared bookkeeping.
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
                pending_deleted: load_pending_deleted(),
                ..Default::default()
            })),
            watcher: Mutex::new(None),
            watched: Mutex::new(HashSet::new()),
        }
    }

    /// Settle every folder's status against what the remote holds, re-arm the OS
    /// watcher, and return the result. Called at the end of each refresh — the
    /// only place with both halves of the picture.
    ///
    /// `plugin_roots` are watched recursively instead of the individual skill
    /// folders: an event in `<plugin>/skills/` is how a *new* skill folder
    /// announces itself, and watching only the skill folders themselves meant
    /// nobody was listening at that level.
    ///
    /// `remote_known_roots` are the plugin roots whose remote listing was
    /// actually read this pass. It is what lets a pending deletion be *retired*:
    /// under such a root, absence from `missing` proves the remote no longer
    /// holds the skill, so there is nothing left to publish.
    pub fn sync(
        &self,
        app: &AppHandle,
        entries: Vec<SkillInput>,
        missing: Vec<MissingLocal>,
        plugin_roots: Vec<String>,
        remote_known_roots: Vec<String>,
    ) -> Vec<SkillState> {
        self.ensure_started(app);

        // Snapshot what we need to resolve statuses, then do all folder IO
        // outside the lock — hashing must never block a command touching state.
        let (known_baselines, pending_new, pending_deleted) = {
            let sh = self.shared.lock();
            (
                sh.baselines.clone(),
                sh.pending_new.clone(),
                sh.pending_deleted.clone(),
            )
        };

        let mut seen: HashSet<String> = HashSet::new();
        // (folder, status, baseline, remote_known, remote_sig)
        let mut resolved: Vec<(String, SkillSync, Baseline, bool, Option<u64>)> = Vec::new();
        for input in entries {
            if input.folder.trim().is_empty() || !seen.insert(input.folder.clone()) {
                continue;
            }
            let path = Path::new(&input.folder);
            if !path.is_dir() {
                // Handled through `missing` below, which carries the remote's
                // view; a folder that is simply gone and unknown to the remote
                // has nothing to report.
                continue;
            }
            let meta = hash_folder_meta(path);
            let prev = known_baselines.get(&input.folder).copied();
            // The metadata hash is exactly here to avoid re-reading the tree: an
            // unchanged `meta` means the cached signature still describes the
            // folder.
            let sig = match prev {
                Some(b) if b.meta == meta => b.sig,
                _ => content_sig(path),
            };
            let mut baseline = Baseline {
                meta,
                sig,
                synced_sig: prev.and_then(|b| b.synced_sig),
            };
            let status = resolve(&input, sig, &baseline, pending_new.contains(&input.folder));
            // A folder that reads `Modified` is the app's most consequential
            // claim — it is what tells the user their work is about to be
            // overwritten by the next plugin update. Say which files back it up,
            // so "it stays modified after I reverted my edit" is answerable
            // without a debugger.
            if matches!(status, SkillSync::Modified | SkillSync::Outdated)
                && tracing::enabled!(tracing::Level::DEBUG)
            {
                if let Some(remote) = input.remote_blobs.as_ref() {
                    tracing::debug!(
                        "skill_watch: {} differs from remote — {}",
                        input.folder,
                        explain(&content_entries(path), remote)
                    );
                }
            }
            // A folder confirmed identical to the remote becomes the reference
            // that later offline comparisons lean on.
            if status == SkillSync::Synced {
                baseline.synced_sig = Some(sig);
            }
            let remote_known = input.remote_known;
            let remote_sig = input.remote_blobs.as_ref().map(|b| sig_of(b));
            resolved.push((input.folder, status, baseline, remote_known, remote_sig));
        }

        // A remote skill with no local folder is a deletion only when we have a
        // baseline proving we once had it. Otherwise it was never installed here.
        let mut deleted: Vec<String> = Vec::new();
        let missing_folders: Vec<String> = missing.iter().map(|m| m.folder.clone()).collect();
        for m in missing {
            if seen.contains(&m.folder) || Path::new(&m.folder).is_dir() {
                continue;
            }
            if known_baselines.contains_key(&m.folder) {
                deleted.push(m.folder);
            }
        }
        // Deletions this app performed itself. They are folded in even when the
        // remote listing failed — that is the whole point of the set: an
        // unreachable forge produces no `MissingLocal`, and the folder would
        // otherwise leave `roots` and lose its baseline for good.
        //
        // Unless the forge *was* reached and does not hold the skill. A deletion
        // is only publishable while there is something upstream to remove: a
        // skill created here and never pushed, or one someone else removed
        // first, has nothing left to delete. Kept, it would sit in the Changes
        // tab forever and open a PR whose only real effect is a version bump.
        let known_roots: Vec<String> = remote_known_roots
            .iter()
            .map(|r| norm_path(r))
            .filter(|r| !r.is_empty())
            .collect();
        let remote_holds: HashSet<String> =
            missing_folders.iter().map(|f| norm_path(f)).collect();
        let mut stale_deleted: Vec<String> = Vec::new();
        for folder in &pending_deleted {
            if seen.contains(folder) || Path::new(folder).is_dir() {
                continue;
            }
            let key = norm_path(folder);
            let under_known_root = known_roots
                .iter()
                .any(|r| key == *r || key.starts_with(&format!("{r}/")));
            if under_known_root && !remote_holds.contains(&key) {
                stale_deleted.push(folder.clone());
                continue;
            }
            if !deleted.iter().any(|d| d == folder) {
                deleted.push(folder.clone());
            }
        }

        let mut out = Vec::with_capacity(resolved.len() + deleted.len());
        let mut new_canon: HashSet<PathBuf> = HashSet::new();
        {
            let mut sh = self.shared.lock();
            let mut roots = Vec::with_capacity(resolved.len() + deleted.len());
            for (folder, status, baseline, remote_known, remote_sig) in resolved {
                sh.baselines.insert(folder.clone(), baseline);
                sh.status.insert(folder.clone(), status);
                match remote_sig {
                    Some(r) => {
                        sh.remote_sig.insert(folder.clone(), r);
                    }
                    // Keep the last known value rather than forgetting it: a
                    // sweep that could not reach the forge is not evidence the
                    // remote changed.
                    None => {}
                }
                // Drop the optimistic flag only once the remote has actually
                // been consulted — from then on, absence from its listing is
                // what makes a skill `New`, on its own merit. Clearing it after
                // a sweep that could not reach the forge would lose the nudge
                // for a skill created while offline, which is exactly the case
                // the flag exists for.
                if remote_known {
                    sh.pending_new.remove(&folder);
                }
                // The folder exists again — restored by hand, or re-installed
                // by a plugin update — so nothing is pending on it any more.
                sh.pending_deleted.remove(&folder);
                out.push(SkillState {
                    folder: folder.clone(),
                    status,
                });
                roots.push(folder);
            }
            for folder in deleted {
                sh.status.insert(folder.clone(), SkillSync::Deleted);
                out.push(SkillState {
                    folder: folder.clone(),
                    status: SkillSync::Deleted,
                });
                roots.push(folder);
            }

            // Prune baselines for folders that are neither watched nor pending
            // deletion. Pruning on *membership of the current set* rather than on
            // "the directory is gone" is what makes deletions detectable at all;
            // it still collects the folders stranded by a plugin version bump,
            // since those paths leave the set the moment the new version installs.
            let alive: HashSet<&String> = roots.iter().collect();
            let before = sh.baselines.len();
            sh.baselines.retain(|k, _| alive.contains(k));
            sh.status.retain(|k, _| alive.contains(k));
            sh.remote_sig.retain(|k, _| alive.contains(k));
            let pruned = before - sh.baselines.len();
            if pruned > 0 {
                tracing::debug!("skill_watch: pruned {pruned} baseline(s) no longer watched");
            }
            if !stale_deleted.is_empty() {
                for folder in &stale_deleted {
                    sh.pending_deleted.remove(folder);
                }
                tracing::info!(
                    "skill_watch: retired {} pending deletion(s) the remote no longer holds",
                    stale_deleted.len()
                );
            }
            sh.roots = roots;

            for p in &plugin_roots {
                if p.trim().is_empty() {
                    continue;
                }
                new_canon.insert(
                    std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p)),
                );
            }
            sh.plugin_roots = plugin_roots;

            save_baselines(&sh.baselines);
            save_pending_new(&sh.pending_new);
            save_pending_deleted(&sh.pending_deleted);
        }

        self.rearm(new_canon);
        out
    }

    /// Accept the folder's current contents as the synced reference and clear any
    /// "new, not yet pushed" flag — called once a PR has been opened for it.
    ///
    /// A folder that no longer exists means the PR being opened is a *deletion*.
    /// There is nothing to take a reference of, and keeping the baseline would
    /// re-raise `Deleted` on every refresh until the PR merges — nagging the user
    /// about work they already did. Dropping it lets the skill read as simply
    /// "not installed here" until the remote listing loses it too.
    pub fn mark_synced(&self, folder: &str) {
        let path = Path::new(folder);
        if !path.is_dir() {
            let mut sh = self.shared.lock();
            sh.baselines.remove(folder);
            sh.status.remove(folder);
            if sh.pending_new.remove(folder) {
                save_pending_new(&sh.pending_new);
            }
            // The deletion has been pushed: stop keeping it alive.
            if sh.pending_deleted.remove(folder) {
                save_pending_deleted(&sh.pending_deleted);
            }
            save_baselines(&sh.baselines);
            return;
        }
        let meta = hash_folder_meta(path);
        let sig = content_sig(path);
        let mut sh = self.shared.lock();
        sh.baselines.insert(
            folder.to_string(),
            Baseline {
                meta,
                sig,
                synced_sig: Some(sig),
            },
        );
        sh.status.insert(folder.to_string(), SkillSync::Synced);
        sh.pending_new.remove(folder);
        save_pending_new(&sh.pending_new);
        if sh.pending_deleted.remove(folder) {
            save_pending_deleted(&sh.pending_deleted);
        }
        save_baselines(&sh.baselines);
    }

    /// Flag a freshly-created skill folder as "new, not yet pushed" and emit the
    /// event so the badge lights up now rather than at the next refresh.
    ///
    /// This is a shortcut, not the detection mechanism: a skill created *outside*
    /// the app is caught just as well, because the next refresh finds it absent
    /// from the remote listing.
    pub fn mark_new(&self, app: &AppHandle, folder: &str) {
        self.ensure_started(app);
        {
            let mut sh = self.shared.lock();
            sh.pending_new.insert(folder.to_string());
            sh.status.insert(folder.to_string(), SkillSync::New);
            if !sh.roots.iter().any(|r| r == folder) {
                sh.roots.push(folder.to_string());
            }
            let path = Path::new(folder);
            sh.baselines.insert(
                folder.to_string(),
                Baseline {
                    meta: hash_folder_meta(path),
                    sig: content_sig(path),
                    synced_sig: None,
                },
            );
            save_pending_new(&sh.pending_new);
            save_baselines(&sh.baselines);
        }
        emit_state(
            app,
            &SkillState {
                folder: folder.to_string(),
                status: SkillSync::New,
            },
        );
    }

    /// Capture a baseline for `folder` if we do not hold one yet.
    ///
    /// Must run *before* the bytes are removed: the baseline is what later turns
    /// "the remote has it, the disk does not" into `Deleted` rather than "never
    /// installed here", and it cannot be computed from a folder that is gone.
    pub fn ensure_baseline(&self, folder: &str) {
        let path = Path::new(folder);
        if !path.is_dir() {
            return;
        }
        {
            let sh = self.shared.lock();
            if sh.baselines.contains_key(folder) {
                return;
            }
        }
        let meta = hash_folder_meta(path);
        let sig = content_sig(path);
        let mut sh = self.shared.lock();
        sh.baselines.entry(folder.to_string()).or_insert(Baseline {
            meta,
            sig,
            synced_sig: None,
        });
        save_baselines(&sh.baselines);
    }

    /// Flag a folder the app just deleted as "deleted, not yet pushed" and emit
    /// the event so the badge turns red now.
    ///
    /// The filesystem watcher cannot do this on its own: a vanished folder
    /// hashes as an empty tree, which reads `Modified` (amber). The status set
    /// here survives that, because `rescan` leaves `New` and `Deleted` alone.
    pub fn mark_deleted(&self, app: &AppHandle, folder: &str) {
        self.ensure_started(app);
        {
            let mut sh = self.shared.lock();
            sh.pending_deleted.insert(folder.to_string());
            sh.status.insert(folder.to_string(), SkillSync::Deleted);
            // `states()` reads `roots`, so an entry missing from it would vanish
            // from the UI on the next re-seed.
            if !sh.roots.iter().any(|r| r == folder) {
                sh.roots.push(folder.to_string());
            }
            save_pending_deleted(&sh.pending_deleted);
        }
        emit_state(
            app,
            &SkillState {
                folder: folder.to_string(),
                status: SkillSync::Deleted,
            },
        );
        // The set of skill folders changed, and the watcher will not say so
        // (the removed path is a known skill root, so `tree_changed` stays
        // false) — tell the frontend to re-run the sweep itself.
        let _ = app.emit(EVENT_TREE, ());
    }

    /// This folder's last settled status, if the watcher holds one.
    pub fn status_of(&self, folder: &str) -> Option<SkillSync> {
        self.shared.lock().status.get(folder).copied()
    }

    /// Drop every trace of one folder — baseline, status, watch root, both
    /// pending flags.
    ///
    /// This is what deleting a skill that never reached the forge means. It is
    /// not a removal anyone can publish: the repo has no such folder, so
    /// `mark_deleted` would park it in `pending_deleted` for good and offer a
    /// PR whose only real content is a version bump. Undoing the creation
    /// leaves nothing behind, which is exactly right.
    pub fn forget(&self, app: &AppHandle, folder: &str) {
        {
            let mut sh = self.shared.lock();
            sh.baselines.remove(folder);
            sh.status.remove(folder);
            sh.remote_sig.remove(folder);
            sh.roots.retain(|r| r != folder);
            if sh.pending_new.remove(folder) {
                save_pending_new(&sh.pending_new);
            }
            if sh.pending_deleted.remove(folder) {
                save_pending_deleted(&sh.pending_deleted);
            }
            save_baselines(&sh.baselines);
        }
        // The set of skill folders changed and the watcher will not say so (the
        // removed path is a known skill root, so `tree_changed` stays false).
        let _ = app.emit(EVENT_TREE, ());
    }

    /// Drop every baseline and status at or under `root`. Called right after an
    /// install overwrites a plugin's folder or an uninstall removes it: the
    /// on-disk content is then the new truth, so a stale reference from a
    /// *previous* install must not linger. Path matching is normalized (strips
    /// the Windows `\\?\` prefix, unifies separators, case-folds).
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
        sh.status.retain(|k, _| !under(k));
        let pending_before = sh.pending_new.len();
        sh.pending_new.retain(|k| !under(k));
        let deleted_before = sh.pending_deleted.len();
        sh.pending_deleted.retain(|k| !under(k));
        if sh.pending_deleted.len() != deleted_before {
            save_pending_deleted(&sh.pending_deleted);
        }
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

    /// Current statuses (re-seeds the UI without rescanning anything).
    pub fn states(&self) -> Vec<SkillState> {
        let sh = self.shared.lock();
        sh.roots
            .iter()
            .map(|folder| SkillState {
                folder: folder.clone(),
                status: sh
                    .status
                    .get(folder)
                    .copied()
                    .unwrap_or(SkillSync::Unknown),
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
        let watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                let _ = tx.send(ev.paths);
            }
        }) {
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

    /// Diff the OS watch set against `new_canon`: unwatch what left, watch what
    /// arrived. Keeps the watcher alive across refreshes instead of tearing it
    /// down each time.
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

/// Decide one folder's status. Pure — all IO already happened.
///
/// The ordering matters: remote knowledge wins when we have it, and the local
/// reference only steps in when we could not look. What never happens any more
/// is a folder reading `Synced` because nothing was known about it.
fn resolve(input: &SkillInput, sig: u64, baseline: &Baseline, pending_new: bool) -> SkillSync {
    if !input.remote_known {
        // Offline / forge unreachable. `synced_sig` is what we last confirmed
        // against the remote, so the comparison stays meaningful; without one,
        // say so rather than guessing.
        return match baseline.synced_sig {
            Some(s) if s == sig => SkillSync::Synced,
            Some(_) => SkillSync::Modified,
            None if pending_new => SkillSync::New,
            None => SkillSync::Unknown,
        };
    }
    if !input.remote_present {
        return SkillSync::New;
    }
    match input.remote_blobs.as_ref().map(|b| sig_of(b)) {
        Some(remote) if remote == sig => SkillSync::Synced,
        // Local and remote differ — but "differ" has two causes, and calling
        // both `Modified` blamed the user for the remote moving.
        //
        // The remote tree is read at the plugin's tracked ref (branch HEAD),
        // the local copy is the version actually installed. So every upstream
        // release made every skill in the plugin read as a local edit.
        // `synced_sig` settles it: it is the signature we last confirmed equal
        // to the remote, so a folder still hashing to it has not been touched
        // here, and the difference can only be upstream's.
        Some(_) => match baseline.synced_sig {
            Some(s) if s == sig => SkillSync::Outdated,
            _ => SkillSync::Modified,
        },
        // The listing succeeded and holds this skill, but carried no signature
        // (a truncated tree fell back to a plain listing). Presence is all we
        // know; lean on the local reference rather than inventing a verdict.
        None => match baseline.synced_sig {
            Some(s) if s == sig => SkillSync::Synced,
            Some(_) => SkillSync::Modified,
            None => SkillSync::Unknown,
        },
    }
}

fn emit_state(app: &AppHandle, state: &SkillState) {
    if let Err(e) = app.emit(EVENT, state) {
        tracing::debug!("skill_watch: emit failed: {e}");
    }
}

fn worker_loop(rx: Receiver<Vec<PathBuf>>, shared: Arc<Mutex<Shared>>, app: AppHandle) {
    while let Ok(first) = rx.recv() {
        // Debounce a burst of save events (editors fire several per save) into
        // one rescan, accumulating every path the burst touched.
        let mut touched = first;
        while let Ok(more) = rx.recv_timeout(Duration::from_millis(250)) {
            touched.extend(more);
        }
        let (changed, tree_changed) = rescan(&shared, &touched);
        for st in changed {
            emit_state(&app, &st);
        }
        if tree_changed {
            tracing::debug!("skill_watch: skill folder set changed on disk");
            if let Err(e) = app.emit(EVENT_TREE, ()) {
                tracing::debug!("skill_watch: tree emit failed: {e}");
            }
        }
    }
}

/// React to a filesystem burst: re-decide the affected folders and return the
/// statuses that flipped, plus whether the burst implies the *set* of skill
/// folders changed.
///
/// The metadata hash is the gate, not the verdict. A folder whose `meta` is
/// unchanged is left alone for free; one whose `meta` moved gets its contents
/// hashed and compared against the reference — the remote's signature when the
/// last sweep read one, else the last confirmed-synced signature.
///
/// Reading that one folder's bytes is the point. The watcher used to only ever
/// raise `Modified` and wait for the next sweep to retract it, so undoing an
/// edit left the badge lit for up to the sweep interval — half an hour on the
/// shipped default. That is not a stale badge, it is a wrong one. The cost is
/// bounded to the folders a debounced burst actually touched, which is what
/// made the old whole-tree content hash expensive, not the reading itself.
///
/// `New` and `Deleted` are still left untouched: they describe whether the
/// remote has the folder, which no local edit can change.
fn rescan(shared: &Arc<Mutex<Shared>>, touched: &[PathBuf]) -> (Vec<SkillState>, bool) {
    // The baseline's own `meta` is deliberately re-read under the lock further
    // down rather than snapshotted here: a refresh may land while we hash, and
    // comparing against a stale value would resurrect a status it just settled.
    struct Snap {
        folder: String,
        status: SkillSync,
        meta: u64,
        reference: Option<u64>,
        /// Last signature confirmed equal to the remote. Kept alongside
        /// `reference` (which prefers the remote's own signature) because it is
        /// what tells a local edit from the remote having moved on.
        synced: Option<u64>,
    }
    let (snapshot, plugin_roots) = {
        let sh = shared.lock();
        let snap: Vec<Snap> = sh
            .roots
            .iter()
            .filter_map(|folder| {
                let b = sh.baselines.get(folder)?;
                Some(Snap {
                    folder: folder.clone(),
                    status: sh.status.get(folder).copied().unwrap_or(SkillSync::Unknown),
                    meta: b.meta,
                    reference: sh.remote_sig.get(folder).copied().or(b.synced_sig),
                    synced: b.synced_sig,
                })
            })
            .collect();
        (snap, sh.plugin_roots.clone())
    };

    let norms: Vec<String> = touched
        .iter()
        .map(|p| norm_path(&p.to_string_lossy()))
        .collect();
    let under = |root: &str, n: &String| {
        let rn = norm_path(root);
        *n == rn || n.starts_with(&format!("{rn}/"))
    };

    let hit: Vec<&Snap> = snapshot
        .iter()
        .filter(|s| norms.iter().any(|n| under(&s.folder, n)))
        .collect();

    // A path under a watched plugin but under no known skill folder means a
    // folder appeared or vanished — the case the old per-skill watch set could
    // not see at all, since nobody was listening to `<plugin>/skills/` itself.
    let tree_changed = norms.iter().any(|n| {
        plugin_roots.iter().any(|p| under(p, n)) && !snapshot.iter().any(|s| under(&s.folder, n))
    });

    // An empty or unmatched path set falls back to re-checking everything:
    // missing a change is worse than the extra `stat`s.
    let selected: Vec<&Snap> = if hit.is_empty() && !tree_changed {
        snapshot.iter().collect()
    } else {
        hit
    };

    // All hashing outside the lock — one filesystem event must never block a
    // command touching the watcher state.
    struct Computed {
        folder: String,
        prev: SkillSync,
        meta: u64,
        /// `None` when `meta` was unchanged and the contents were not read.
        sig: Option<u64>,
        next: SkillSync,
    }
    let computed: Vec<Computed> = selected
        .iter()
        .map(|s| {
            let path = Path::new(&s.folder);
            let meta = hash_folder_meta(path);
            if matches!(s.status, SkillSync::New | SkillSync::Deleted) || meta == s.meta {
                return Computed {
                    folder: s.folder.clone(),
                    prev: s.status,
                    meta,
                    sig: None,
                    next: s.status,
                };
            }
            let sig = content_sig(path);
            let next = match s.reference {
                Some(r) if r == sig => SkillSync::Synced,
                // Differs from the reference. If the folder still hashes to the
                // last signature confirmed against the remote, nothing changed
                // here — this is a folder the remote moved past, and a stray
                // filesystem event must not relabel it as the user's edit.
                Some(_) if s.synced == Some(sig) => SkillSync::Outdated,
                Some(_) => SkillSync::Modified,
                // Nothing to compare against — a sweep has never settled this
                // folder. Say it moved and let the next sweep name it properly.
                None => SkillSync::Modified,
            };
            Computed {
                folder: s.folder.clone(),
                prev: s.status,
                meta,
                sig: Some(sig),
                next,
            }
        })
        .collect();

    let mut sh = shared.lock();
    let mut changed = Vec::new();
    for c in computed {
        // A refresh may have re-armed the watched set while we were hashing.
        if !sh.roots.iter().any(|r| *r == c.folder) {
            continue;
        }
        // Fold the fresh hashes back in so the next sweep reuses them instead of
        // re-reading the folder it just missed by a second.
        if let Some(sig) = c.sig {
            if let Some(b) = sh.baselines.get_mut(&c.folder) {
                b.meta = c.meta;
                b.sig = sig;
                if c.next == SkillSync::Synced {
                    b.synced_sig = Some(sig);
                }
            }
        }
        if c.next == c.prev {
            continue;
        }
        sh.status.insert(c.folder.clone(), c.next);
        changed.push(SkillState {
            folder: c.folder,
            status: c.next,
        });
    }
    if !changed.is_empty() {
        save_baselines(&sh.baselines);
    }
    (changed, tree_changed)
}

/// Order-independent hash of every file's *metadata* under `folder` — relative
/// path, size and mtime. Costs one already-paid `stat` per file (`walkdir`
/// carries it from the directory listing) and reads nothing.
///
/// Its only job is to answer "could anything have changed here?" so the far more
/// expensive [`content_sig`] can be skipped. `DefaultHasher` (SipHash, std, fixed
/// keys) is deterministic across runs, so the persisted value stays comparable.
fn hash_folder_meta(folder: &Path) -> u64 {
    let mut files: Vec<(String, u64, u64)> = Vec::new();
    for entry in walk(folder) {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Some(rel) = rel_posix(folder, entry.path()) else {
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        files.push((rel, meta.len(), mtime));
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

/// A skill folder as `(relative path, git blob SHA)` — the same shape a
/// recursive git-tree read yields for the remote copy, so the two compare
/// exactly rather than heuristically.
///
/// Reads file bytes, so callers gate it behind [`hash_folder_meta`].
fn content_entries(folder: &Path) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();
    for entry in walk(folder) {
        let Some(rel) = rel_posix(folder, entry.path()) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        entries.push((rel, git_blob_sha(&bytes)));
    }
    entries
}

/// Content signature of a skill folder — [`content_entries`] hashed down to one
/// comparable number.
fn content_sig(folder: &Path) -> u64 {
    sig_of(&content_entries(folder))
}

/// Human-readable account of why two content listings differ: which files were
/// added locally, which are missing, and which changed.
///
/// Bounded output — a folder that differs wholesale (a plugin installed from a
/// different ref, say) would otherwise dump its entire tree into the log on
/// every sweep.
fn explain(local: &[(String, String)], remote: &[(String, String)]) -> String {
    use std::collections::HashMap;
    let rmap: HashMap<&str, &str> = remote
        .iter()
        .map(|(p, s)| (p.as_str(), s.as_str()))
        .collect();
    let lmap: HashMap<&str, &str> = local
        .iter()
        .map(|(p, s)| (p.as_str(), s.as_str()))
        .collect();
    let mut notes: Vec<String> = Vec::new();
    for (path, sha) in local {
        match rmap.get(path.as_str()) {
            None => notes.push(format!("+{path}")),
            Some(r) if *r != sha.as_str() => notes.push(format!("~{path}")),
            Some(_) => {}
        }
    }
    for (path, _) in remote {
        if !lmap.contains_key(path.as_str()) {
            notes.push(format!("-{path}"));
        }
    }
    if notes.is_empty() {
        // Same files, same SHAs, yet the signatures disagreed: that is a bug in
        // this module, not a local edit. Say so rather than printing "no
        // differences" next to a `Modified` verdict.
        return "no file-level difference (signature mismatch is a bug)".into();
    }
    const MAX: usize = 8;
    let total = notes.len();
    if total > MAX {
        notes.truncate(MAX);
        format!("{} (+{} more)", notes.join(" "), total - MAX)
    } else {
        notes.join(" ")
    }
}

/// Hash a `(path, blob sha)` list into one comparable number. Both sides of the
/// comparison — the local folder and the remote git tree — go through this, so
/// it is the single definition of "same contents".
pub fn sig_of(entries: &[(String, String)]) -> u64 {
    let mut sorted: Vec<(&str, &str)> = entries
        .iter()
        .map(|(p, s)| (p.as_str(), s.as_str()))
        .collect();
    sorted.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    sorted.len().hash(&mut h);
    for (path, sha) in sorted {
        path.to_lowercase().hash(&mut h);
        sha.hash(&mut h);
    }
    h.finish()
}

/// Git's object id for a blob: `sha1("blob <len>\0" + bytes)`. Computing it
/// locally is what lets a git tree listing serve as the remote reference without
/// downloading a single file.
fn git_blob_sha(bytes: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(format!("blob {}\0", bytes.len()).as_bytes());
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// Whether a path relative to a skill folder is excluded from its signature.
///
/// Both sides of the comparison go through this — the local walk and the remote
/// git tree. They must agree exactly: a file committed upstream but skipped
/// locally (a stray `.DS_Store`, say) would make the two signatures differ
/// forever, pinning the skill to `Modified` with nothing the user could do
/// about it.
pub fn is_skipped(rel_posix: &str) -> bool {
    rel_posix.split('/').any(|c| SKIP.contains(&c))
}

/// Files under `folder`, skipping the [`SKIP`] segments.
fn walk(folder: &Path) -> impl Iterator<Item = walkdir::DirEntry> + '_ {
    WalkDir::new(folder)
        .sort_by_file_name()
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(move |e| {
            rel_posix(folder, e.path())
                .map(|rel| !is_skipped(&rel))
                .unwrap_or(false)
        })
}

fn rel_posix(folder: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(folder).ok()?;
    Some(
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// Normalize a path string for prefix comparison: strip the Windows long-path
/// prefix, unify separators to `/`, drop any trailing slash, and case-fold
/// (Windows paths are case-insensitive). Both sides come from app-constructed
/// paths, so this only absorbs formatting differences — it resolves nothing.
fn norm_path(p: &str) -> String {
    let p = p.strip_prefix(r"\\?\").unwrap_or(p);
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn baseline_path() -> PathBuf {
    config::app_settings_dir().join(BASELINE_FILE)
}

fn load_baselines() -> HashMap<String, Baseline> {
    let Ok(text) = std::fs::read_to_string(baseline_path()) else {
        return HashMap::new();
    };
    let Ok(val) = serde_json::from_str::<Value>(&text) else {
        return HashMap::new();
    };
    if val.get("version").and_then(Value::as_u64) != Some(BASELINE_VERSION as u64) {
        return HashMap::new();
    }
    let mut out = HashMap::new();
    if let Some(obj) = val.get("baselines").and_then(Value::as_object) {
        for (k, v) in obj {
            // Hashes are stored as strings to dodge JSON's 2^53 integer limit.
            let num = |key: &str| -> Option<u64> {
                v.get(key).and_then(Value::as_str)?.parse::<u64>().ok()
            };
            let (Some(meta), Some(sig)) = (num("meta"), num("sig")) else {
                continue;
            };
            out.insert(
                k.clone(),
                Baseline {
                    meta,
                    sig,
                    synced_sig: num("syncedSig"),
                },
            );
        }
    }
    out
}

fn save_baselines(map: &HashMap<String, Baseline>) {
    let mut obj = Map::new();
    for (k, b) in map {
        let mut e = Map::new();
        e.insert("meta".into(), Value::String(b.meta.to_string()));
        e.insert("sig".into(), Value::String(b.sig.to_string()));
        if let Some(s) = b.synced_sig {
            e.insert("syncedSig".into(), Value::String(s.to_string()));
        }
        obj.insert(k.clone(), Value::Object(e));
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

fn pending_deleted_path() -> PathBuf {
    config::app_settings_dir().join(PENDING_DELETED_FILE)
}

fn load_pending_deleted() -> HashSet<String> {
    let Ok(text) = std::fs::read_to_string(pending_deleted_path()) else {
        return HashSet::new();
    };
    serde_json::from_str::<Vec<String>>(&text)
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn save_pending_deleted(set: &HashSet<String>) {
    let arr: Vec<Value> = set.iter().cloned().map(Value::String).collect();
    if let Err(e) = installer::atomic_write_json(&pending_deleted_path(), &Value::Array(arr)) {
        tracing::warn!("skill_watch: could not persist pending-deleted set: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `blobs` stands in for the remote listing; the tests only care whether its
    /// signature matches the local one, so a single synthetic entry suffices.
    fn input(known: bool, present: bool, blobs: Option<&[(&str, &str)]>) -> SkillInput {
        SkillInput {
            folder: "f".into(),
            remote_known: known,
            remote_present: present,
            remote_blobs: blobs.map(|b| {
                b.iter()
                    .map(|(p, s)| (p.to_string(), s.to_string()))
                    .collect()
            }),
        }
    }

    fn sig_for(blobs: &[(&str, &str)]) -> u64 {
        sig_of(
            &blobs
                .iter()
                .map(|(p, s)| (p.to_string(), s.to_string()))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn absent_from_remote_is_new_not_clean() {
        // The regression that started all this: a folder the remote does not have
        // must never read as synced, whatever the local baseline says.
        let b = Baseline {
            meta: 1,
            sig: 7,
            synced_sig: Some(7),
        };
        assert_eq!(resolve(&input(true, false, None), 7, &b, false), SkillSync::New);
    }

    #[test]
    fn first_sight_offline_is_unknown_not_clean() {
        let b = Baseline::default();
        assert_eq!(
            resolve(&input(false, false, None), 42, &b, false),
            SkillSync::Unknown
        );
    }

    #[test]
    fn signature_decides_when_remote_is_known() {
        let remote: &[(&str, &str)] = &[("SKILL.md", "abc")];
        let b = Baseline {
            meta: 1,
            sig: sig_for(remote),
            synced_sig: None,
        };
        assert_eq!(
            resolve(&input(true, true, Some(remote)), sig_for(remote), &b, false),
            SkillSync::Synced
        );
        assert_eq!(
            resolve(&input(true, true, Some(remote)), 9, &b, false),
            SkillSync::Modified
        );
    }

    #[test]
    fn explain_names_the_files_behind_a_modified_verdict() {
        let local = vec![
            ("SKILL.md".to_string(), "aaa".to_string()),
            ("notes.md".to_string(), "bbb".to_string()),
        ];
        let remote = vec![
            ("SKILL.md".to_string(), "zzz".to_string()),
            ("gone.md".to_string(), "ccc".to_string()),
        ];
        let out = explain(&local, &remote);
        assert!(out.contains("~SKILL.md"), "{out}");
        assert!(out.contains("+notes.md"), "{out}");
        assert!(out.contains("-gone.md"), "{out}");
    }

    #[test]
    fn explain_flags_an_impossible_mismatch() {
        let same = vec![("SKILL.md".to_string(), "aaa".to_string())];
        assert!(explain(&same, &same).contains("bug"));
    }

    #[test]
    fn offline_keeps_a_freshly_created_skill_flagged() {
        // A skill created in-app with no forge in reach: the optimistic flag is
        // the only thing that knows, and it must survive sweeps that could not
        // consult the remote.
        let b = Baseline::default();
        assert_eq!(
            resolve(&input(false, false, None), 42, &b, true),
            SkillSync::New
        );
    }

    #[test]
    fn offline_falls_back_to_last_synced_signature() {
        let b = Baseline {
            meta: 1,
            sig: 7,
            synced_sig: Some(3),
        };
        assert_eq!(
            resolve(&input(false, false, None), 7, &b, false),
            SkillSync::Modified
        );
    }

    #[test]
    fn blob_sha_matches_git() {
        // `git hash-object` for an empty blob and for "hello\n".
        assert_eq!(git_blob_sha(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
        assert_eq!(
            git_blob_sha(b"hello\n"),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
    }

    #[test]
    fn signature_ignores_entry_order() {
        let a = vec![("a".to_string(), "1".to_string()), ("b".into(), "2".into())];
        let b = vec![("b".to_string(), "2".to_string()), ("a".into(), "1".into())];
        assert_eq!(sig_of(&a), sig_of(&b));
    }
}

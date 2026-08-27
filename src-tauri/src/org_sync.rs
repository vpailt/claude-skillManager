//! Incremental mirror of the Gitea `Claude` organisation into the GitHub
//! `sforge-labs` organisation.
//!
//! The initial migration was a one-shot script: clone, rewrite, single import
//! commit, push. It cannot answer "what moved upstream since?", which is what
//! this module exists for.
//!
//! Two rules travel with every byte copied, the same ones the migration applied:
//! `acx-cl` becomes `cl` (so the `acx-` prefix disappears from repository
//! names), and forge references are repointed at `github.com/<GITHUB_ORG>`.
//!
//! ## How a repository is anchored
//!
//! Nothing in git links a GitHub commit to the Gitea commit it came from, so
//! every commit this module writes carries a [`TRAILER`] naming its source sha.
//! The anchor is the newest GitHub commit carrying one — and reading it from
//! `HEAD` specifically is also the divergence test: if `HEAD` has no trailer,
//! someone committed straight to GitHub and the mirror must not touch it.
//!
//! The seven repositories migrated by the script predate the trailer, so
//! [`anchor_from_message`] also accepts the `Imported from … at <sha>.` wording
//! that script left behind. That fallback is what lets them join the scheme
//! without being rewritten first.
//!
//! ## Constraints
//!
//! No `git` binary — the app ships as a standalone exe. Reads go through the
//! Gitea REST API, writes through GitHub's Git Data API, which is the only way
//! to build a commit that keeps its original author, date and message.

use crate::config::Settings;
use crate::error::{Error, Result};
use crate::github_client::{CommitAuthor, CommitInfo, GitHubClient, TreeEntry};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

pub const GITEA_ORG: &str = "Claude";
pub const GITHUB_ORG: &str = "sforge-labs";

/// Tauri event carrying [`SyncProgress`] while a pull runs.
pub const EVENT_PROGRESS: &str = "org-sync-progress";

/// Commit-message trailer tying a mirrored commit to its Gitea origin.
const TRAILER: &str = "Gitea-Source-Sha:";

const COMMITS_PER_PAGE: usize = 50;
/// How far back to look for the anchor before giving up. Ten pages is far more
/// history than a sync that runs even occasionally will ever need; failing loud
/// beats replaying from an anchor we merely failed to find.
const MAX_COMMIT_PAGES: usize = 10;

/// Serialised in place of the source repository's own privacy setting: the
/// target org holds internal material and nothing here should silently publish.
const CREATE_PRIVATE: bool = true;

/// Serialised over the wire to the frontend; also the discriminator it renders.
pub mod status {
    pub const UP_TO_DATE: &str = "upToDate";
    pub const BEHIND: &str = "behind";
    pub const NEW: &str = "new";
    pub const DIVERGED: &str = "diverged";
    pub const EMPTY: &str = "empty";
    pub const ERROR: &str = "error";
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoComparison {
    /// Name on Gitea, e.g. `acx-cl-salesforce`.
    pub source: String,
    /// Name on GitHub, e.g. `cl-salesforce`.
    pub target: String,
    pub branch: String,
    /// One of [`status`].
    pub status: String,
    /// Commits waiting to be replayed.
    pub pending: usize,
    /// Human-readable explanation — carries the reason for `diverged`/`error`.
    pub detail: String,
    pub head_sha: String,
    pub anchor_sha: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub gitea_url: String,
    pub gitea_org: String,
    pub github_org: String,
    pub repos: Vec<RepoComparison>,
    /// Present on GitHub with no Gitea counterpart. Reported, never deleted.
    pub orphans: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoOutcome {
    pub source: String,
    pub target: String,
    /// `"synced"` | `"created"` | `"skipped"` | `"error"`.
    pub status: String,
    pub replayed: usize,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub repo: String,
    /// `"compare"` | `"create"` | `"replay"` | `"ref"` | `"done"`.
    pub phase: String,
    /// Commits replayed so far, out of `total`.
    pub done: usize,
    pub total: usize,
    /// Files handled within the current commit, out of `step_total`.
    ///
    /// The commit counter alone is near-useless for the common case: an
    /// incremental sync replays a single commit, so it reads 0/1 for the whole
    /// run while the actual work — one request per changed blob — happens
    /// invisibly underneath. This is the granularity time is really spent at.
    pub step: usize,
    pub step_total: usize,
    pub detail: String,
}

/// Callback rather than an `AppHandle`, so this module keeps no `tauri`
/// dependency — the same shape `app_updater` uses for download progress.
pub type ProgressFn<'a> = &'a mut dyn FnMut(SyncProgress);

/// A pull rewrites refs on a whole organisation; two overlapping runs would
/// race on the same branches. Mirrors the guard around `sweep_remote`.
static PULL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Set by [`request_cancel`], cleared when a pull starts.
static CANCEL: AtomicBool = AtomicBool::new(false);

const CANCEL_MSG: &str = "Rapatriement annulé.";

/// Number of tries for a call that failed at the transport layer.
const RETRY_ATTEMPTS: usize = 3;

/// Ask the running pull to stop at its next checkpoint.
///
/// Safe at any point: a repository's branch ref is moved only after all of its
/// objects exist, so stopping before that leaves GitHub exactly as it was, with
/// nothing but unreferenced objects the forge collects on its own.
pub fn request_cancel() {
    tracing::info!("org sync: annulation demandée");
    CANCEL.store(true, Ordering::Relaxed);
}

fn check_cancelled() -> Result<()> {
    if CANCEL.load(Ordering::Relaxed) {
        return Err(Error::Invalid(CANCEL_MSG.into()));
    }
    Ok(())
}

fn is_cancellation(e: &Error) -> bool {
    matches!(e, Error::Invalid(m) if m == CANCEL_MSG)
}

/// Retry a call that failed at the **transport** layer — a dropped connection,
/// a TLS reset, a timeout.
///
/// The forge sits behind a VPN and a replay makes hundreds of sequential calls,
/// so a single blip would otherwise abort a whole repository's sync. That is
/// the same failure the batched admin upload was rebuilt to survive, and the
/// replay had inherited it verbatim.
///
/// HTTP statuses are deliberately **not** retried: a 404 or a 422 will not turn
/// into a success, and retrying them only makes the user wait longer to read
/// the real error.
fn with_retry<T>(what: &str, mut f: impl FnMut() -> Result<T>) -> Result<T> {
    let mut last: Option<Error> = None;
    for attempt in 1..=RETRY_ATTEMPTS {
        check_cancelled()?;
        match f() {
            Ok(v) => {
                if attempt > 1 {
                    tracing::info!("{what} : réussi à la tentative {attempt}");
                }
                return Ok(v);
            }
            Err(Error::Http(e)) => {
                let wrapped = Error::Http(e);
                tracing::warn!(
                    "{what} : tentative {attempt}/{RETRY_ATTEMPTS} échouée au transport — {}",
                    wrapped.chain()
                );
                last = Some(wrapped);
                if attempt < RETRY_ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(500 * attempt as u64));
                }
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| Error::Other(format!("{what} : échec"))))
}

// ---------------------------------------------------------------- rewriting --

/// The ordered substitution pipeline shared by contents, paths and messages.
pub struct Rewriter {
    /// Applied in order; later rules see earlier rules' output.
    content: Vec<(Vec<u8>, Vec<u8>)>,
}

impl Rewriter {
    pub fn new(gitea_host: &str) -> Self {
        // The forge rules run after the acx-cl one so they match owner paths in
        // their already-renamed form. They stay deliberately narrow — only the
        // "<forge>/<org>/" prefix and the quoted "<org>/" of a JSON repo field.
        // A bare "Claude", and the ~/.claude paths skills legitimately document,
        // must not move.
        let content = vec![
            (b"acx-cl".to_vec(), b"cl".to_vec()),
            (
                format!("https://{gitea_host}/{GITEA_ORG}/").into_bytes(),
                format!("https://github.com/{GITHUB_ORG}/").into_bytes(),
            ),
            (
                format!("{gitea_host}/{GITEA_ORG}/").into_bytes(),
                format!("github.com/{GITHUB_ORG}/").into_bytes(),
            ),
            (
                format!("\"{GITEA_ORG}/").into_bytes(),
                format!("\"{GITHUB_ORG}/").into_bytes(),
            ),
        ];
        Self { content }
    }

    /// Rewrite file bytes. Binary content is passed through untouched.
    ///
    /// Byte-level on purpose: decoding to UTF-8 first would mangle any file
    /// that is not valid UTF-8, and re-encoding would not preserve a BOM or
    /// mixed line endings. Working on raw bytes makes the copy exact apart from
    /// the substitutions themselves.
    pub fn content(&self, bytes: &[u8]) -> Vec<u8> {
        if is_binary(bytes) {
            return bytes.to_vec();
        }
        let mut cur = bytes.to_vec();
        for (from, to) in &self.content {
            cur = replace_bytes(&cur, from, to);
        }
        cur
    }

    /// Rewrite a commit message, description or any other UTF-8 text.
    pub fn text(&self, s: &str) -> String {
        String::from_utf8_lossy(&self.content(s.as_bytes())).into_owned()
    }

    /// Rewrite a path. Only the `acx-cl` rule applies — a path never carries a
    /// forge URL, and the JSON-quote rule would be nonsense here.
    pub fn path(&self, p: &str) -> String {
        p.replace("acx-cl", "cl")
    }
}

/// Repository name on the GitHub side: the `acx-` prefix is dropped.
pub fn target_repo_name(source: &str) -> String {
    source.strip_prefix("acx-").unwrap_or(source).to_string()
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

fn replace_bytes(input: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    if from.is_empty() || input.len() < from.len() {
        return input.to_vec();
    }
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == from[0] && input.len() - i >= from.len() && &input[i..i + from.len()] == from
        {
            out.extend_from_slice(to);
            i += from.len();
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    out
}

// ------------------------------------------------------------------ anchors --

fn is_sha40(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The Gitea sha a mirrored commit came from, or `None` if this commit was not
/// written by the mirror.
pub fn anchor_from_message(msg: &str) -> Option<String> {
    for line in msg.lines() {
        if let Some(rest) = line.trim().strip_prefix(TRAILER) {
            let sha = rest.trim().trim_end_matches('.');
            if is_sha40(sha) {
                return Some(sha.to_ascii_lowercase());
            }
        }
    }
    // Legacy wording from the migration script, which predates the trailer.
    // Gated on the phrase so a random 40-hex token in an ordinary commit
    // message can never be mistaken for an anchor.
    if msg.contains("Imported from ") {
        for tok in msg.split_whitespace() {
            let t = tok.trim_end_matches('.');
            if is_sha40(t) {
                return Some(t.to_ascii_lowercase());
            }
        }
    }
    None
}

fn with_trailer(message: &str, source_sha: &str) -> String {
    let body = message.trim_end();
    format!("{body}\n\n{TRAILER} {source_sha}\n")
}

// ------------------------------------------------------------------ clients --

/// Resolve the Gitea instance hosting [`GITEA_ORG`], returning a client and the
/// bare host (which the rewriter needs to build its forge rules).
pub fn gitea_for(settings: &Settings) -> Result<(GitHubClient, String)> {
    let base = settings
        .marketplaces
        .iter()
        .find(|m| {
            m.provider == crate::github_client::Provider::Gitea
                && m.github_repo
                    .split('/')
                    .next()
                    .is_some_and(|owner| owner.eq_ignore_ascii_case(GITEA_ORG))
        })
        .map(|m| m.base_url.clone())
        .or_else(|| settings.gitea_instances.first().map(|i| i.base_url.clone()))
        .ok_or_else(|| {
            Error::Invalid(
                "Aucune instance Gitea enregistrée : ajoutez-la dans Paramètres avant de \
                 synchroniser."
                    .into(),
            )
        })?;

    let host = crate::github_client::host_of(&base);
    let client = crate::commands::gitea_client(settings, &base)?;
    Ok((client, host))
}

/// Does `<GITHUB_ORG>/<target>` exist?
///
/// Probed one repository at a time rather than read off an org listing. A
/// listing only ever shows what the token is allowed to see, so a repository
/// missing from it for a permission reason reads as "absent" — and the remedy
/// for absent is to create it, which is precisely the wrong move against a repo
/// that already exists. Only a 404 is a definite absence; any other failure is
/// an unknown and is propagated rather than guessed.
fn repo_exists(gh: &GitHubClient, target: &str) -> Result<bool> {
    match gh.get_repo(&format!("{GITHUB_ORG}/{target}")) {
        Ok(_) => Ok(true),
        Err(Error::NotFound(_)) => Ok(false),
        Err(e) => Err(e),
    }
}

fn github_for(settings: &Settings) -> Result<GitHubClient> {
    if settings.github_token.trim().is_empty() {
        return Err(Error::Invalid(
            "Aucun jeton GitHub enregistré : renseignez-le dans Paramètres avant de \
             synchroniser."
                .into(),
        ));
    }
    GitHubClient::new(&settings.github_token)
}

// ----------------------------------------------------------------- compare --

/// Walk `repo`'s commits back from `branch` until `anchor`, returning them
/// oldest-first.
///
/// `anchor` of `None` means "take everything", which is the new-repository
/// case. An anchor that never turns up inside [`MAX_COMMIT_PAGES`] is an error
/// rather than a silent full replay: the difference between the two is whether
/// we rewrite the whole history of a repo that only needed one commit.
fn commits_since(
    client: &GitHubClient,
    repo: &str,
    branch: &str,
    anchor: Option<&str>,
) -> Result<Vec<CommitInfo>> {
    let mut collected: Vec<CommitInfo> = Vec::new();
    for page in 1..=MAX_COMMIT_PAGES {
        let batch = client.list_commits(repo, branch, page, COMMITS_PER_PAGE)?;
        if batch.is_empty() {
            if anchor.is_some() {
                return Err(Error::Invalid(format!(
                    "{repo} : point de synchronisation introuvable dans l'historique."
                )));
            }
            break;
        }
        let exhausted = batch.len() < COMMITS_PER_PAGE;
        for c in batch {
            if let Some(a) = anchor {
                if c.sha.eq_ignore_ascii_case(a) {
                    collected.reverse();
                    return Ok(collected);
                }
            }
            collected.push(c);
        }
        if exhausted {
            if anchor.is_some() {
                return Err(Error::Invalid(format!(
                    "{repo} : point de synchronisation introuvable dans l'historique."
                )));
            }
            collected.reverse();
            return Ok(collected);
        }
    }
    Err(Error::Invalid(format!(
        "{repo} : plus de {} commits de retard, synchronisation manuelle requise.",
        MAX_COMMIT_PAGES * COMMITS_PER_PAGE
    )))
}

/// Compare one Gitea repository against its GitHub counterpart.
fn compare_one(
    gitea: &GitHubClient,
    gh: &GitHubClient,
    source: &str,
    branch: &str,
    exists_on_github: bool,
) -> RepoComparison {
    let target = target_repo_name(source);
    let mut row = RepoComparison {
        source: source.to_string(),
        target: target.clone(),
        branch: branch.to_string(),
        status: status::ERROR.into(),
        pending: 0,
        detail: String::new(),
        head_sha: String::new(),
        anchor_sha: String::new(),
    };

    let gitea_repo = format!("{GITEA_ORG}/{source}");
    let head = match gitea.list_commits(&gitea_repo, branch, 1, 1) {
        Ok(v) => match v.into_iter().next() {
            Some(c) => c,
            None => {
                row.status = status::EMPTY.into();
                row.detail = "Dépôt vide côté Gitea.".into();
                return row;
            }
        },
        Err(e) => {
            row.detail = e.to_string();
            return row;
        }
    };
    row.head_sha = head.sha.clone();

    if !exists_on_github {
        match commits_since(gitea, &gitea_repo, branch, None) {
            Ok(all) => {
                row.status = status::NEW.into();
                row.pending = all.len();
                row.detail = format!("Absent de GitHub — {} commit(s) à rejouer.", all.len());
            }
            Err(e) => row.detail = e.to_string(),
        }
        return row;
    }

    // HEAD must itself be a mirrored commit. Anything else means work landed on
    // GitHub outside the mirror, and replaying on top would bury it.
    let gh_repo = format!("{GITHUB_ORG}/{target}");
    let gh_head = match gh.list_commits(&gh_repo, branch, 1, 1) {
        Ok(v) => v.into_iter().next(),
        Err(e) => {
            row.detail = e.to_string();
            return row;
        }
    };
    let Some(gh_head) = gh_head else {
        row.status = status::NEW.into();
        row.detail = "Dépôt GitHub présent mais vide.".into();
        match commits_since(gitea, &gitea_repo, branch, None) {
            Ok(all) => row.pending = all.len(),
            Err(e) => {
                row.status = status::ERROR.into();
                row.detail = e.to_string();
            }
        }
        return row;
    };

    let Some(anchor) = anchor_from_message(&gh_head.message) else {
        row.status = status::DIVERGED.into();
        row.detail =
            "Le dernier commit GitHub ne provient pas de la synchronisation — rapatriement \
             refusé pour ne pas l'écraser."
                .into();
        return row;
    };
    row.anchor_sha = anchor.clone();

    if anchor.eq_ignore_ascii_case(&head.sha) {
        row.status = status::UP_TO_DATE.into();
        row.detail = "À jour.".into();
        return row;
    }

    match commits_since(gitea, &gitea_repo, branch, Some(&anchor)) {
        Ok(pending) => {
            row.status = status::BEHIND.into();
            row.pending = pending.len();
            row.detail = format!("{} commit(s) à rapatrier.", pending.len());
        }
        Err(e) => row.detail = e.to_string(),
    }
    row
}

/// Full read-only comparison of both organisations.
pub fn compare() -> Result<SyncReport> {
    tracing::info!("org sync compare: démarrage ({GITEA_ORG} -> {GITHUB_ORG})");
    let settings = crate::config::load_settings();
    // The comparison reads only; no rewriting happens here, so the host the
    // rewriter would need is not used.
    let (gitea, _host) = gitea_for(&settings)?;
    let gh = github_for(&settings)?;

    let sources = gitea.list_org_repos(GITEA_ORG)?;
    // Kept only to report orphans; existence is decided per repo by
    // `repo_exists`, never by presence in this listing.
    let targets = gh.list_org_repos(GITHUB_ORG)?;

    let mut repos = Vec::with_capacity(sources.len());
    let mut matched: Vec<String> = Vec::new();

    for src in &sources {
        let target = target_repo_name(&src.name);
        let exists = match repo_exists(&gh, &target) {
            Ok(v) => v,
            Err(e) => {
                repos.push(RepoComparison {
                    source: src.name.clone(),
                    target,
                    branch: src.default_branch.clone(),
                    status: status::ERROR.into(),
                    pending: 0,
                    detail: format!("État GitHub indéterminable : {e}"),
                    head_sha: String::new(),
                    anchor_sha: String::new(),
                });
                continue;
            }
        };
        if exists {
            matched.push(target.to_lowercase());
        }
        if src.empty {
            repos.push(RepoComparison {
                source: src.name.clone(),
                target,
                branch: src.default_branch.clone(),
                status: status::EMPTY.into(),
                pending: 0,
                detail: "Dépôt vide côté Gitea.".into(),
                head_sha: String::new(),
                anchor_sha: String::new(),
            });
            continue;
        }
        let branch = if src.default_branch.is_empty() {
            "main"
        } else {
            &src.default_branch
        };
        repos.push(compare_one(&gitea, &gh, &src.name, branch, exists));
    }

    let orphans = targets
        .iter()
        .filter(|r| !matched.contains(&r.name.to_lowercase()))
        .map(|r| r.name.clone())
        .collect();

    for r in &repos {
        tracing::info!(
            "org sync compare: {} -> {} [{}] {}",
            r.source,
            r.target,
            r.status,
            r.detail
        );
    }
    let behind: usize = repos
        .iter()
        .filter(|r| r.status == status::BEHIND || r.status == status::NEW)
        .count();
    tracing::info!(
        "org sync compare: terminé — {} dépôt(s) Gitea, {} cible(s) GitHub, {behind} à rapatrier",
        sources.len(),
        targets.len()
    );
    Ok(SyncReport {
        // Taken from the client rather than re-read from settings: `gitea_for`
        // may have picked an instance other than the first registered one, and
        // reporting a different URL than the one actually queried would be a
        // lie the user has no way to spot.
        gitea_url: gitea.base_url(),
        gitea_org: GITEA_ORG.into(),
        github_org: GITHUB_ORG.into(),
        repos,
        orphans,
    })
}

// -------------------------------------------------------------------- replay --

/// Replay `commits` (oldest first) from Gitea onto GitHub, returning the sha of
/// the last commit created.
///
/// The branch ref is **not** moved here — see [`pull`]. Objects are written
/// first and the ref repointed once at the end, so a failure part-way leaves
/// unreferenced objects GitHub collects on its own, and the branch untouched.
#[allow(clippy::too_many_arguments)]
fn replay(
    gitea: &GitHubClient,
    gh: &GitHubClient,
    src_repo: &str,
    dst_repo: &str,
    commits: &[CommitInfo],
    mut parent: Option<String>,
    rw: &Rewriter,
    blob_map: &mut HashMap<String, String>,
    label: &str,
    progress: ProgressFn<'_>,
) -> Result<String> {
    let total = commits.len();
    let mut last = parent.clone().unwrap_or_default();

    for (idx, commit) in commits.iter().enumerate() {
        check_cancelled()?;
        let subject = first_line(&commit.message);
        tracing::debug!("{src_repo} -> {dst_repo}: rejeu {}/{total} {}", idx + 1, commit.sha);

        let entries = with_retry(&format!("lecture de l'arbre {}", commit.sha), || {
            gitea.list_tree_at_commit(src_repo, &commit.sha)
        })?;

        let blobs: Vec<_> = entries.iter().filter(|e| e.kind == "blob").collect();
        let skipped_submodules = entries.iter().filter(|e| e.kind == "commit").count();
        let step_total = blobs.len();
        let mut tree: Vec<TreeEntry> = Vec::with_capacity(step_total);

        for (n, e) in blobs.into_iter().enumerate() {
            check_cancelled()?;
            progress(SyncProgress {
                repo: label.to_string(),
                phase: "replay".into(),
                done: idx,
                total,
                step: n,
                step_total,
                detail: subject.clone(),
            });

            let target_sha = match blob_map.get(&e.sha) {
                Some(s) => s.clone(),
                None => {
                    let raw = with_retry(&format!("lecture de {}", e.path), || {
                        gitea.get_blob_bytes(src_repo, &e.sha)
                    })?;
                    let rewritten = rw.content(&raw);
                    let sha = with_retry(&format!("écriture de {}", e.path), || {
                        gh.create_blob(dst_repo, &rewritten)
                    })?;
                    blob_map.insert(e.sha.clone(), sha.clone());
                    sha
                }
            };
            tree.push(TreeEntry {
                path: rw.path(&e.path),
                kind: "blob".into(),
                sha: target_sha,
                mode: if e.mode.is_empty() {
                    "100644".into()
                } else {
                    e.mode.clone()
                },
            });
        }

        if skipped_submodules > 0 {
            tracing::warn!(
                "{src_repo}@{}: {skipped_submodules} sous-module(s) ignoré(s)",
                commit.sha
            );
        }

        let tree_sha = with_retry("création de l'arbre", || gh.create_tree(dst_repo, &tree))?;
        let message = with_trailer(&rw.text(&commit.message), &commit.sha);
        let parents: Vec<String> = parent.iter().cloned().collect();
        let new_sha = with_retry("création du commit", || {
            gh.create_commit(
                dst_repo,
                &message,
                &tree_sha,
                &parents,
                &commit.author,
                &pick_committer(commit),
            )
        })?;
        tracing::debug!("{dst_repo}: commit {new_sha} créé depuis {}", commit.sha);
        parent = Some(new_sha.clone());
        last = new_sha;
    }

    progress(SyncProgress {
        repo: label.to_string(),
        phase: "replay".into(),
        done: total,
        total,
        step: 0,
        step_total: 0,
        detail: String::new(),
    });
    Ok(last)
}

/// Gitea leaves `committer` empty on some commits; falling back to the author
/// keeps GitHub from rejecting the object for a nameless committer.
fn pick_committer(c: &CommitInfo) -> CommitAuthor {
    if c.committer.name.trim().is_empty() || c.committer.email.trim().is_empty() {
        c.author.clone()
    } else {
        c.committer.clone()
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or_default().trim().to_string()
}

/// Bring the selected repositories up to date. `sources` holds Gitea names.
pub fn pull(sources: &[String], progress: ProgressFn<'_>) -> Result<Vec<RepoOutcome>> {
    let lock = PULL_LOCK.get_or_init(|| Mutex::new(()));
    let Some(_guard) = lock.try_lock() else {
        return Err(Error::Invalid(
            "Une synchronisation est déjà en cours.".into(),
        ));
    };

    // A cancellation asked for during the *previous* run must not kill this one
    // before it starts.
    CANCEL.store(false, Ordering::Relaxed);
    tracing::info!(
        "org sync pull: démarrage sur {} dépôt(s) : {}",
        sources.len(),
        sources.join(", ")
    );

    let settings = crate::config::load_settings();
    let (gitea, host) = gitea_for(&settings)?;
    let gh = github_for(&settings)?;
    let rw = Rewriter::new(&host);

    let available = gitea.list_org_repos(GITEA_ORG)?;

    let mut out = Vec::new();
    for source in sources {
        let Some(src) = available.iter().find(|r| &r.name == source) else {
            out.push(RepoOutcome {
                source: source.clone(),
                target: target_repo_name(source),
                status: "error".into(),
                replayed: 0,
                detail: "Dépôt absent de l'organisation Gitea.".into(),
            });
            continue;
        };

        let target = target_repo_name(&src.name);
        let branch = if src.default_branch.is_empty() {
            "main".to_string()
        } else {
            src.default_branch.clone()
        };
        let exists = match repo_exists(&gh, &target) {
            Ok(v) => v,
            Err(e) => {
                out.push(RepoOutcome {
                    source: src.name.clone(),
                    target,
                    status: "error".into(),
                    replayed: 0,
                    detail: format!("État GitHub indéterminable : {e}"),
                });
                continue;
            }
        };

        // Re-compare rather than trusting the report the UI was built from: it
        // may be minutes old, and this is the last moment before we write.
        let cmp = compare_one(&gitea, &gh, &src.name, &branch, exists);
        let mut outcome = RepoOutcome {
            source: src.name.clone(),
            target: target.clone(),
            status: "skipped".into(),
            replayed: 0,
            detail: cmp.detail.clone(),
        };

        match cmp.status.as_str() {
            status::UP_TO_DATE | status::EMPTY | status::DIVERGED | status::ERROR => {
                tracing::info!(
                    "org sync: {} -> {target} ignoré ({}) : {}",
                    src.name,
                    cmp.status,
                    cmp.detail
                );
                out.push(outcome);
                continue;
            }
            _ => {}
        }

        if check_cancelled().is_err() {
            outcome.status = "cancelled".into();
            outcome.detail = CANCEL_MSG.into();
            tracing::info!("org sync: {} -> {target} non traité (annulé)", src.name);
            out.push(outcome);
            continue;
        }

        tracing::info!(
            "org sync: {} -> {target} démarre ({}, {} commit(s))",
            src.name,
            cmp.status,
            cmp.pending
        );
        let result = pull_one(
            &gitea, &gh, src, &target, &branch, &cmp, &rw, exists, progress,
        );
        match result {
            Ok(n) => {
                outcome.replayed = n;
                outcome.status = if cmp.status == status::NEW {
                    "created".into()
                } else {
                    "synced".into()
                };
                outcome.detail = format!("{n} commit(s) rapatrié(s).");
                tracing::info!("org sync: {} -> {target} OK, {n} commit(s)", src.name);
            }
            Err(e) if is_cancellation(&e) => {
                outcome.status = "cancelled".into();
                outcome.detail = format!(
                    "{CANCEL_MSG} Rien n'a été publié sur GitHub : la branche n'est \
                     déplacée qu'en fin de rejeu."
                );
                tracing::info!("org sync: {} -> {target} annulé en cours de rejeu", src.name);
            }
            Err(e) => {
                outcome.status = "error".into();
                // The dialog gets the chain too: "error sending request" alone
                // is not something a user can act on.
                outcome.detail = e.chain();
                tracing::error!("org sync: {} -> {target} a ÉCHOUÉ — {}", src.name, e.chain());
            }
        }
        out.push(outcome);
    }

    let ok = out
        .iter()
        .filter(|o| o.status == "synced" || o.status == "created")
        .count();
    let failed = out.iter().filter(|o| o.status == "error").count();
    let commits: usize = out.iter().map(|o| o.replayed).sum();
    tracing::info!(
        "org sync pull: terminé — {ok} rapatrié(s) ({commits} commit(s)), {failed} en échec, \
         {} ignoré(s)",
        out.len() - ok - failed
    );

    progress(SyncProgress {
        repo: String::new(),
        phase: "done".into(),
        done: sources.len(),
        total: sources.len(),
        step: 0,
        step_total: 0,
        detail: String::new(),
    });
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn pull_one(
    gitea: &GitHubClient,
    gh: &GitHubClient,
    src: &crate::github_client::OrgRepo,
    target: &str,
    branch: &str,
    cmp: &RepoComparison,
    rw: &Rewriter,
    exists: bool,
    progress: ProgressFn<'_>,
) -> Result<usize> {
    let src_repo = format!("{GITEA_ORG}/{}", src.name);
    let dst_repo = format!("{GITHUB_ORG}/{target}");

    if !exists {
        progress(SyncProgress {
            repo: target.to_string(),
            phase: "create".into(),
            done: 0,
            total: 0,
            step: 0,
            step_total: 0,
            detail: format!("Création de {dst_repo}"),
        });
        gh.create_org_repo(
            GITHUB_ORG,
            target,
            &rw.text(&src.description),
            CREATE_PRIVATE,
        )?;
    }

    let anchor = if cmp.anchor_sha.is_empty() {
        None
    } else {
        Some(cmp.anchor_sha.as_str())
    };
    let commits = commits_since(gitea, &src_repo, branch, anchor)?;
    if commits.is_empty() {
        return Ok(0);
    }

    // Build on GitHub's current head when there is one; a repo we just created
    // has no ref at all and its first commit is a root commit.
    let parent = if exists && anchor.is_some() {
        gh.list_commits(&dst_repo, branch, 1, 1)?
            .into_iter()
            .next()
            .map(|c| c.sha)
    } else {
        None
    };

    let mut blob_map = HashMap::new();
    let head = replay(
        gitea,
        gh,
        &src_repo,
        &dst_repo,
        &commits,
        parent,
        rw,
        &mut blob_map,
        target,
        progress,
    )?;

    progress(SyncProgress {
        repo: target.to_string(),
        phase: "ref".into(),
        done: commits.len(),
        total: commits.len(),
        step: 0,
        step_total: 0,
        detail: format!("Mise à jour de {branch}"),
    });
    // Last write of the whole repository, and the only one that makes any of
    // the preceding work visible: everything above this line is safely
    // abandonable, which is what makes cancelling harmless.
    with_retry("mise à jour de la référence", || {
        gh.set_branch_ref(&dst_repo, branch, &head, false)
    })?;
    if !exists && branch != "main" {
        // A repo created empty defaults to `main`; point it at what we pushed.
        let _ = gh.set_default_branch(&dst_repo, branch);
    }
    Ok(commits.len())
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn target_name_drops_the_acx_prefix() {
        assert_eq!(target_repo_name("acx-cl-salesforce"), "cl-salesforce");
        assert_eq!(target_repo_name("acx-library"), "library");
        assert_eq!(target_repo_name("cl-salesforce"), "cl-salesforce");
        // Only a leading occurrence counts.
        assert_eq!(target_repo_name("my-acx-tool"), "my-acx-tool");
    }

    #[test]
    fn rewrites_content_and_forge_references() {
        let rw = Rewriter::new("git.almaviacx.local");
        let src = br#"{"repo":"Claude/acx-cl-library","url":"https://git.almaviacx.local/Claude/acx-cl-library"}"#;
        let got = String::from_utf8(rw.content(src)).unwrap();
        assert_eq!(
            got,
            r#"{"repo":"sforge-labs/cl-library","url":"https://github.com/sforge-labs/cl-library"}"#
        );
    }

    #[test]
    fn leaves_claude_config_paths_alone() {
        let rw = Rewriter::new("git.almaviacx.local");
        let src = b"cache lives in ~/.claude/plugins/ and Claude Code reads it";
        assert_eq!(rw.content(src), src.to_vec());
    }

    #[test]
    fn binary_content_is_passed_through() {
        let rw = Rewriter::new("git.almaviacx.local");
        let src = b"\x89PNG\x00\x00acx-cl";
        assert_eq!(rw.content(src), src.to_vec());
    }

    #[test]
    fn rewrite_preserves_crlf_and_bom() {
        let rw = Rewriter::new("git.almaviacx.local");
        let src = b"\xEF\xBB\xBFname: acx-cl-library\r\nother\r\n";
        let got = rw.content(src);
        assert_eq!(got, b"\xEF\xBB\xBFname: cl-library\r\nother\r\n".to_vec());
    }

    /// Regression: GitHub returns `description: null` for a repository with no
    /// description, and `#[serde(default)]` alone rejects an explicit null. Six
    /// of seven repositories were silently dropped from the org listing, which
    /// made them look absent and had the sync try to *recreate* them.
    #[test]
    fn org_repo_tolerates_null_fields() {
        let json = serde_json::json!({
            "name": "cl-marketplace",
            "description": null,
            "default_branch": "main",
            "private": true,
        });
        let r: crate::github_client::OrgRepo = serde_json::from_value(json).unwrap();
        assert_eq!(r.name, "cl-marketplace");
        assert_eq!(r.description, "");
        assert_eq!(r.default_branch, "main");
        assert!(r.private);
        assert!(!r.archived);
    }

    #[test]
    fn reads_the_trailer_anchor() {
        let msg = "feat: x\n\nGitea-Source-Sha: 5d4dea517728fea0ee06b9ab0a01929847442604\n";
        assert_eq!(
            anchor_from_message(msg).as_deref(),
            Some("5d4dea517728fea0ee06b9ab0a01929847442604")
        );
    }

    #[test]
    fn falls_back_to_the_migration_scripts_wording() {
        let msg = "chore: initial import from Claude/acx-cl-salesforce\n\nImported from \
                   https://git.almaviacx.local/Claude/acx-cl-salesforce at \
                   5d4dea517728fea0ee06b9ab0a01929847442604.\nHistory was not carried over.";
        assert_eq!(
            anchor_from_message(msg).as_deref(),
            Some("5d4dea517728fea0ee06b9ab0a01929847442604")
        );
    }

    #[test]
    fn an_ordinary_commit_is_not_an_anchor() {
        assert!(anchor_from_message("fix: typo").is_none());
        // A stray 40-hex token without the import wording must not qualify.
        assert!(
            anchor_from_message("see 5d4dea517728fea0ee06b9ab0a01929847442604 for context")
                .is_none()
        );
    }
}

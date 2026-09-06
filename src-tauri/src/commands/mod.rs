//! All `#[tauri::command]` handlers exposed to the frontend.
//!
//! Each command is a thin wrapper around the corresponding domain module —
//! the heavy lifting stays in installer/marketplace_*/admin/etc. so it can
//! be unit-tested without spinning up Tauri.

use crate::admin::{self, FileChange, UploadResult};
use crate::admin_drafts::{
    self, AdminDraft, BulkUploadArgs, BumpSuggestion, LocalSkill, RemoteSkillInfo, UploadSkillArgs,
};
use crate::app_uninstaller::{self, UninstallInfo};
use crate::app_updater::{self, AppUpdateInfo, StagedUpdate};
use crate::config::{self, GiteaInstance, LoggingConfig, MarketplaceConfig, Settings, UiPrefs};
use crate::logger;
use crate::error::Result;
use crate::frontmatter::parse_frontmatter;
use crate::github_client::{host_of, GitHubClient, Provider};
use crate::installer;
use crate::local_scanner;
use crate::marketplace_installer;
use crate::marketplace_remote;
use crate::models::{Marketplace, Plugin, Skill, SkillSync};
use crate::org_sync;
use crate::pending_prs::{self, PendingPR};
use crate::plugin_state;
use crate::notification_history;
use crate::pr_history::{self, PRRecord};
use crate::token_store;
use crate::skill_watch::{MissingLocal, SkillInput, SkillState, SkillWatch};
use crate::update_poller;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

fn gh() -> Result<GitHubClient> {
    let token = config::load_settings().github_token;
    GitHubClient::new(&token)
}

/// Build a client for a self-hosted Gitea instance: token from the credential
/// vault (keyed by host), TLS mode from the registered [`GiteaInstance`].
pub(crate) fn gitea_client(s: &Settings, base_url: &str) -> Result<GitHubClient> {
    let insecure = s
        .get_gitea_instance(base_url)
        .map(|i| i.insecure_tls)
        .unwrap_or(false);
    let host = host_of(base_url);
    let token = token_store::load_host(&host)?.unwrap_or_default();
    GitHubClient::for_provider(Provider::Gitea, base_url, &token, insecure)
}

/// Resolve the right client for a marketplace config: Gitea → its instance,
/// anything else (or absent) → GitHub with the stored PAT.
fn client_for_cfg(s: &Settings, cfg: Option<&MarketplaceConfig>) -> Result<GitHubClient> {
    match cfg {
        Some(c) if c.provider == Provider::Gitea => gitea_client(s, &c.base_url),
        _ => GitHubClient::new(&s.github_token),
    }
}

/// Resolve the client for a marketplace by name (looks up app settings).
fn client_for_marketplace(name: &str) -> Result<GitHubClient> {
    let s = config::load_settings();
    client_for_cfg(&s, s.get_marketplace(name))
}

/// Pick the client for installing a *plugin* based on the plugin's own source
/// host — not the marketplace's. A Gitea marketplace may list a GitHub-hosted
/// plugin (or vice-versa); installing it has to hit the forge the plugin's
/// `source.url` actually points at. Falls back to the marketplace's client when
/// the source carries no usable host (e.g. a classic `{source:"github",repo}`
/// entry with no url in a GitHub marketplace).
/// Pick a client for a source identified by `url` (+ optional source `kind`):
/// `github.com` → GitHub; a url whose host matches a registered Gitea instance
/// → that instance; a classic `kind == "github"` with no usable url → GitHub.
/// Returns `None` when the source gives no host hint, so the caller can fall
/// back to the marketplace's own client.
fn client_for_source_url(s: &Settings, url: &str, kind: &str) -> Option<Result<GitHubClient>> {
    if !url.is_empty() {
        let host = host_of(url);
        if !host.is_empty() {
            if matches!(
                host.to_ascii_lowercase().as_str(),
                "github.com" | "www.github.com" | "api.github.com"
            ) {
                return Some(GitHubClient::new(&s.github_token));
            }
            if let Some(inst) = s
                .gitea_instances
                .iter()
                .find(|i| host_of(&i.base_url).eq_ignore_ascii_case(&host))
            {
                return Some(gitea_client(s, &inst.base_url));
            }
        }
    }
    if kind.eq_ignore_ascii_case("github") {
        return Some(GitHubClient::new(&s.github_token));
    }
    None
}

fn client_for_source(
    s: &Settings,
    source: Option<&crate::models::PluginSource>,
    marketplace_name: &str,
) -> Result<GitHubClient> {
    if let Some(src) = source {
        if let Some(client) = client_for_source_url(s, &src.url, &src.kind) {
            return client;
        }
    }
    client_for_cfg(s, s.get_marketplace(marketplace_name))
}

/// Run an admin operation, logging the error to the rolling log file when it
/// fails. Admin `prepare_*` failures were previously invisible (the error only
/// reached the frontend toast), which made forge-side issues — auth, wrong
/// branch, missing registry — impossible to diagnose from a shipped log.
fn logged_admin<T>(op: &str, ctx: String, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let r = f();
    if let Err(e) = &r {
        tracing::warn!("{op} {ctx} failed: {e}");
    }
    r
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub marketplaces: Vec<Marketplace>,
    pub local_only: Marketplace,
}

#[tauri::command]
pub async fn load_app_settings() -> Settings {
    config::load_settings()
}

#[tauri::command]
pub async fn save_app_settings(settings: Settings) -> Result<()> {
    config::save_settings(&settings)
}

/// The last sweep's result, so a burst of triggers costs one pass.
///
/// The catalogue poller finishes a sweep and emits `catalog-changed`; the
/// frontend answers by invalidating its refresh query, which runs a second,
/// identical sweep seconds later. The same happens when the sweep's own
/// marketplace auto-update rewrites `~/.claude/plugins/`, which `claude_watch`
/// then reports. The mutex below only ever serialised those — it never stopped
/// them being duplicates.
static LAST_SWEEP: std::sync::Mutex<Option<(std::time::Instant, RefreshResult)>> =
    std::sync::Mutex::new(None);

/// How long a sweep's result stands in for the next one. Short enough that a
/// genuine change is never held back by more than a poll, long enough to absorb
/// the event storm one sweep sets off.
const SWEEP_REUSE_SECS: u64 = 45;

/// Store a sweep result for [`SWEEP_REUSE_SECS`].
fn remember_sweep(result: &RefreshResult) {
    let mut slot = LAST_SWEEP.lock().unwrap_or_else(|e| e.into_inner());
    *slot = Some((std::time::Instant::now(), result.clone()));
}

/// The stored result, if it is still young enough to answer with.
fn recent_sweep() -> Option<RefreshResult> {
    let slot = LAST_SWEEP.lock().unwrap_or_else(|e| e.into_inner());
    slot.as_ref().and_then(|(at, r)| {
        (at.elapsed() < std::time::Duration::from_secs(SWEEP_REUSE_SECS)).then(|| r.clone())
    })
}

/// Run a sweep unless one finished moments ago, in which case reuse it.
///
/// The catalogue poller has its own timer and the frontend has its own query;
/// left to themselves they both swept, seconds apart, for the same answer. This
/// is the door both of them come through.
pub(crate) fn sweep_or_reuse(app: &AppHandle) -> Result<RefreshResult> {
    if let Some(cached) = recent_sweep() {
        tracing::debug!("sweep: reusing the result from the last {SWEEP_REUSE_SECS}s");
        return Ok(cached);
    }
    sweep_remote(app)
}

/// Why a sweep was asked for. The three answers cost very different amounts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefreshMode {
    /// A background trigger (a timer, a filesystem event). Answerable from the
    /// reuse window.
    #[default]
    Auto,
    /// This app just changed the install state on disk and wants the view that
    /// follows it. Never reused — a result from before the change is exactly
    /// the wrong answer — but also never *expensive*: see
    /// [`SweepScope::LocalChange`].
    Local,
    /// The user pressed Rafraîchir. Skips the reuse window *and* clears every
    /// host's failure tally, so "reconnect the VPN, press Rafraîchir" works
    /// there and then rather than after the circuit breaker's cooldown.
    User,
}

/// How many *not installed* plugins may have their manifest probed in one full
/// sweep.
///
/// Reading a plugin's own manifest is what turns a registry entry into a
/// version number, and it is worth a request for something on disk that might
/// be out of date. For a plugin nobody installed it only decides whether the
/// catalogue row reads "1.2.0" or "version inconnue" — at one to three requests
/// each, that is several hundred round trips per sweep for a large catalogue,
/// repeated every half hour. Installed plugins are never capped; the rest are
/// served first-come and keep whatever the registry said beyond it.
const MAX_UNINSTALLED_MANIFEST_PROBES: usize = 40;

/// How much remote work one sweep may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SweepScope {
    /// Everything, including manifest probes for plugins nobody installed.
    Full,
    /// The local install state and the remote reads that describe it — but no
    /// version probing for *not installed* plugins.
    ///
    /// Those probes are the bulk of a sweep's wall clock (measured: 22 s out of
    /// a 24 s sweep, 40 sequential reads against a 246-plugin catalogue) and
    /// they only decide whether a catalogue row reads "1.2.0" or "version
    /// inconnue". Nobody waits on that label; the user who just clicked
    /// Installer waits on everything else. Versions already learnt are still
    /// served from the memo, so this drops nothing the previous sweep knew — it
    /// only declines to acquire more, which the next poller pass does anyway.
    LocalChange,
}

impl SweepScope {
    /// How many not-installed plugins may have their manifest probed.
    fn uninstalled_probe_cap(self) -> usize {
        match self {
            SweepScope::Full => MAX_UNINSTALLED_MANIFEST_PROBES,
            SweepScope::LocalChange => 0,
        }
    }
}

/// Whether anyone is waiting on this sweep's result.
///
/// Only one sweep runs at a time, and the loser of that race used to wait out
/// the winner in full — up to the whole 75 s budget. That is fine between two
/// timers and wrong when a click is behind one of them, so a `Foreground` sweep
/// makes a `Background` one give up its remote half early.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SweepPriority {
    /// A timer: `catalog_poller`, or the frontend's safety-net interval. Its
    /// result is disposable — the next tick redoes it.
    Background,
    /// A gesture is waiting on it: a click, or the refresh that follows one.
    Foreground,
}

/// Rebuild the whole view. See [`RefreshMode`] for what each mode costs.
#[tauri::command]
pub async fn refresh_all(app: AppHandle, mode: Option<RefreshMode>) -> Result<RefreshResult> {
    match mode.unwrap_or_default() {
        RefreshMode::Auto => sweep_or_reuse(&app),
        RefreshMode::Local => {
            sweep_scoped(&app, SweepScope::LocalChange, SweepPriority::Foreground)
        }
        RefreshMode::User => {
            // The user is present: give a host written off by the circuit
            // breaker another go before sweeping.
            crate::github_client::reset_host_health();
            sweep_scoped(&app, SweepScope::Full, SweepPriority::Foreground)
        }
    }
}

/// The full remote sweep: auto-update marketplaces, rebuild the local view,
/// merge each registry and each plugin's skills, reconcile open PRs, and settle
/// every skill folder's sync status.
///
/// Extracted from the `refresh_all` command so `catalog_poller` can run exactly
/// the same pass on a timer — the UI is destroyed in tray mode, so anything that
/// only ran from a frontend query effectively stopped running at all.
pub(crate) fn sweep_remote(app: &AppHandle) -> Result<RefreshResult> {
    sweep_scoped(app, SweepScope::Full, SweepPriority::Background)
}

/// [`sweep_remote`], with an explicit budget for the optional remote work.
pub(crate) fn sweep_scoped(
    app: &AppHandle,
    scope: SweepScope,
    priority: SweepPriority,
) -> Result<RefreshResult> {
    // One sweep at a time. Two callers now reach this — the frontend command and
    // `catalog_poller` — and step 1 re-extracts marketplace directories in place
    // (`rmtree_robust` then unzip). A concurrent sweep reading that directory
    // mid-rewrite would see a half-empty marketplace and report every plugin in
    // it as gone. Serializing costs nothing: the loser simply runs right after.
    //
    // "Right after" was the problem, though: the poller's pass may have a
    // 75 s budget's worth of remote work left, and a click that lands mid-pass
    // waited it out before starting its own. So a foreground sweep announces
    // itself *before* queueing, and a background one holding the lock reads that
    // and stops making new remote calls — the same exit as running out of
    // budget, a path that already returns a usable partial view. The waiting
    // sweep then gets the lock in seconds instead of a minute.
    static SWEEP: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static WAITING_FOREGROUND: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);
    use std::sync::atomic::Ordering::SeqCst;

    if priority == SweepPriority::Foreground {
        WAITING_FOREGROUND.fetch_add(1, SeqCst);
    }
    let _guard = SWEEP.lock().unwrap_or_else(|e| e.into_inner());
    if priority == SweepPriority::Foreground {
        WAITING_FOREGROUND.fetch_sub(1, SeqCst);
    }

    // The wait itself may have produced the answer. A background sweep that
    // queued behind another one is asking a question that was just answered, so
    // it takes that answer rather than repeating the pass — the reuse window is
    // tested before queueing, and this is the same test on the other side of the
    // wait. A foreground sweep never does this: it follows a change on disk that
    // the finished sweep predates.
    if priority == SweepPriority::Background {
        if let Some(cached) = recent_sweep() {
            tracing::debug!("sweep: another pass answered this one while it waited");
            return Ok(cached);
        }
    }

    // Only a background pass yields, and only to a sweep someone is waiting on.
    // Two foreground sweeps still serialise in full: both describe a change the
    // user made, and neither is disposable.
    let preempted = move || {
        priority == SweepPriority::Background && WAITING_FOREGROUND.load(SeqCst) > 0
    };

    // Hard ceiling on how long the remote half of a sweep may take.
    //
    // The sweep is an N+1 across the forge and it is *unbounded*: a catalogue
    // like `claude-plugins-official` lists 168 plugins, and step 3 probes a
    // manifest (and, on failure, the tags) for every one of them that carries a
    // source. Each read that has to time out costs seconds, so an offline or
    // rate-limited machine turned one refresh into hours — with the UI spinner
    // spinning the whole time, because a finished sweep is its only end
    // condition. The circuit breaker in `github_client` handles the common case;
    // this is the backstop for everything else (a host that accepts the
    // connection then stalls, a catalogue big enough to be slow while online).
    // Passing the budget does not fail the refresh: it stops making *new*
    // remote calls and returns what is already known, which leaves every
    // `remote_ok` false for the untouched marketplaces — a failed read, never
    // an empty one.
    const SWEEP_BUDGET_SECS: u64 = 75;
    let started = std::time::Instant::now();
    // "No more remote calls": the budget ran out, or a foreground sweep is
    // queued behind this one. Both leave the local view in place for whatever
    // was not reached, which is a *failed* read rather than an empty one.
    let over_budget = move || {
        started.elapsed() > std::time::Duration::from_secs(SWEEP_BUDGET_SECS) || preempted()
    };
    // Which of the two stopped the remote half - worth distinguishing in the
    // log, since one is a machine that cannot keep up and the other is the app
    // getting out of the user's way.
    let stop_reason = move || {
        if preempted() {
            "yielding to a refresh someone is waiting on"
        } else {
            "sweep budget spent"
        }
    };

    // Deafen the skill watcher for the whole pass. The sweep walks every plugin
    // directory and the user's `skills/`, and reads every file it compares — on
    // Windows all of that is reported straight back as a change, which had the
    // frontend asking for another refresh the moment this one landed.
    let _quiet_skills = crate::skill_watch::quiet_guard();

    tracing::info!("refresh_all started");
    let settings = config::load_settings();

    // 1) Auto-update marketplaces flagged with `autoUpdate=true`.
    //
    // Each marketplace gets a client matching its provider (GitHub or its Gitea
    // instance). Failures here are non-fatal: the local install stays usable
    // even if the network is down. We surface them via `tracing::warn!` so they
    // show up in the log file users can attach to a bug report.
    for cfg in &settings.marketplaces {
        if !cfg.github_repo.is_empty() {
            let info = marketplace_installer::get_install_info(&cfg.name);
            let auto = info
                .get("autoUpdate")
                .and_then(|v| v.as_bool())
                .unwrap_or(cfg.auto_update);
            if auto && marketplace_installer::is_marketplace_installed(&cfg.name) {
                if over_budget() {
                    tracing::warn!(
                        "{} before auto-updating {} \u{2014} skipping the rest",
                        stop_reason(),
                        cfg.name
                    );
                    break;
                }
                if let Err(e) =
                    app.emit("refresh-progress", &format!("auto-update: {}", cfg.name))
                {
                    tracing::debug!("emit refresh-progress failed (ignored): {}", e);
                }
                let gh = match client_for_cfg(&settings, Some(cfg)) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!("client init failed for {}: {}", cfg.name, e);
                        continue;
                    }
                };
                // Re-extracting the marketplace rewrites `~/.claude/plugins/`,
                // which `claude_watch` reports as "the install state moved" —
                // the frontend then asks for another sweep, and the sweep it
                // was reacting to is the one that made the change. Deafen the
                // watcher for the duration plus a moment, since the events land
                // after the writes.
                let _quiet = crate::claude_watch::quiet_guard();
                let (updated, msg) = marketplace_installer::auto_update_if_changed(
                    &gh,
                    &cfg.name,
                    &cfg.github_repo,
                    &cfg.default_branch,
                );
                if !updated && msg != "up to date" {
                    tracing::warn!("auto-update {} skipped: {}", cfg.name, msg);
                }
            }
        }
    }

    // 2) Build local marketplace list.
    let mut marketplaces = local_scanner::build_marketplaces_from_settings(&settings.marketplaces);

    // Per-plugin remote skill details (blob SHAs), kept aside for step 5. They
    // are what the sync status is decided against and would be noise on the wire
    // if they travelled to the frontend inside `Skill`.
    let mut remote_by_plugin: std::collections::HashMap<
        String,
        Vec<marketplace_remote::RemoteSkill>,
    > = std::collections::HashMap::new();

    // 3) For each marketplace with a github source, fetch the registry and merge.
    //
    // `fetch_marketplace_plugins` returns an empty vector on network/parse
    // failure rather than propagating — that's intentional: a stale-but-usable
    // local view beats a hard error in the refresh pipeline. We still log when
    // the merge yields zero remote plugins for a known GitHub source so a
    // diagnostic trail exists.
    let mut budget_spent = false;
    // Sweep the marketplaces the user actually installed from first.
    //
    // The order otherwise comes from `marketplaces.json`, and a catalogue with
    // nothing installed from it can be enormous: `claude-plugins-official`
    // lists 168 plugins. Sitting first in the file, it spent the whole budget
    // (and, before the budget existed, the whole afternoon) before the two
    // marketplaces the user works from were looked at even once.
    let mut order: Vec<usize> = (0..marketplaces.len()).collect();
    order.sort_by_key(|&i| {
        let installed = marketplaces[i]
            .plugins
            .iter()
            .any(|p| p.installed_version.is_some());
        (!installed, i)
    });

    // How many *not installed* plugins may have their manifest probed in this
    // sweep — [`SweepScope::Full`]'s cap, or none at all for a sweep that only
    // has to describe a local change.
    let probe_cap = scope.uninstalled_probe_cap();
    let mut uninstalled_probes = 0usize;
    let mut probes_skipped = 0usize;
    let mut probes_from_memo = 0usize;

    for idx in order {
        let mp = &mut marketplaces[idx];
        if mp.source_repo.is_empty() {
            continue;
        }
        if over_budget() {
            if !budget_spent {
                budget_spent = true;
                tracing::warn!(
                    "{} \u{2014} keeping the local view for the remaining marketplace(s)",
                    stop_reason()
                );
            }
            continue;
        }
        if let Err(e) = app.emit("refresh-progress", &format!("fetching: {}", mp.name)) {
            tracing::debug!("emit refresh-progress failed (ignored): {}", e);
        }
        let cfg = settings.get_marketplace(&mp.name);
        let r#ref = cfg.map(|c| c.default_branch.as_str()).unwrap_or("");
        let gh = match client_for_cfg(&settings, cfg) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("client init failed for {}: {}", mp.name, e);
                continue;
            }
        };
        let (remote, remote_ok) =
            marketplace_remote::fetch_marketplace_plugins(&gh, &mp.source_repo, r#ref, &mp.name);
        if !remote_ok {
            tracing::warn!(
                "could not fetch remote registry for marketplace {} ({}@{}) — keeping local view",
                mp.name,
                mp.source_repo,
                if r#ref.is_empty() { "default" } else { r#ref }
            );
        }
        let local = std::mem::take(&mut mp.plugins);
        // `remote_ok` lets the merge drop not-installed plugins the catalogue no
        // longer lists (a real upstream removal) without nuking the local view
        // when the fetch merely failed.
        mp.plugins = marketplace_remote::merge_local_remote(local, remote, remote_ok);

        // Editable flag = current token has push rights on the source repo.
        // Drives whether the Admin → Distant tab lists this marketplace.
        mp.editable = gh.can_push(&mp.source_repo);

        // Merge remote-only skills for installed plugins with a github source.
        // Errors are non-fatal: we want the rest of the refresh to complete.
        for plugin in mp.plugins.iter_mut() {
            let Some(src) = plugin.source.clone() else {
                continue;
            };
            if src.repo.is_empty() {
                continue;
            }
            if over_budget() {
                if !budget_spent {
                    budget_spent = true;
                    tracing::warn!(
                        "{} while reading {} \u{2014} keeping the local view for the rest",
                        stop_reason(),
                        mp.name
                    );
                }
                continue;
            }
            // Authoritative latest version = the plugin repo's own manifest
            // `version` on its tracked ref. The version is bumped inside each PR,
            // so it lands on the default branch the moment the PR merges — no git
            // tag needed (we stopped cutting them). Falls back to the highest
            // semver git tag for third-party plugins that still publish via tags.
            // The registry no longer pins a per-release version, so derive it from
            // the repo and re-compute the install state — for EVERY plugin with a
            // source, not just installed ones (otherwise a not-installed plugin
            // shows "version inconnue"). Best-effort: a failed read (offline /
            // VPN-gated Gitea) leaves latest_version as-is.
            let installed = plugin.installed_version.is_some();
            if !installed {
                // A version already learnt this half-day is reused rather than
                // re-read: for a plugin nobody installed it only feeds a
                // catalogue label, and the alternative is paying the same 40
                // probes on every sweep, forever.
                if let Some(memo) = uninstalled_version_memo(&gh, &src) {
                    probes_from_memo += 1;
                    if let Some(ver) = memo {
                        plugin.latest_version = Some(ver);
                        marketplace_remote::recompute_state(plugin);
                    }
                    continue;
                }
                if uninstalled_probes >= probe_cap {
                    probes_skipped += 1;
                    continue;
                }
                uninstalled_probes += 1;
            }
            let probed = marketplace_remote::fetch_plugin_manifest_version(&gh, &src)
                .or_else(|| marketplace_remote::fetch_latest_tag_version(&gh, &src.repo));
            if !installed {
                remember_uninstalled_version(&gh, &src, probed.clone());
            }
            if let Some(ver) = probed {
                if plugin.latest_version.as_deref() != Some(ver.as_str()) {
                    tracing::debug!(
                        "latest version for {}@{}: {} (was {:?})",
                        plugin.name,
                        mp.name,
                        ver,
                        plugin.latest_version
                    );
                }
                plugin.latest_version = Some(ver);
                marketplace_remote::recompute_state(plugin);
            }
            // Remote-only skills are only merged for installed plugins — they
            // drive the "upgrade this skill" affordances and aren't worth a
            // per-plugin API call for plugins that aren't even installed.
            if plugin.installed_version.is_none() {
                continue;
            }

            let remote =
                marketplace_remote::fetch_plugin_skills(&gh, &src, &plugin.name, &mp.name);

            // Has the tracked ref moved since we installed this version? The
            // manifest version is the *declared* truth, but nothing forces a bump
            // on every push — so a plugin whose repo changed without one used to
            // look perfectly up to date. The commit comes back with the tree
            // above, so this costs no extra request.
            if let (Some(installed), Some(head)) =
                (plugin.git_commit_sha.as_deref(), remote.head_sha.as_deref())
            {
                if !installed.is_empty() && head != installed {
                    plugin.remote_content_changed = true;
                    tracing::debug!(
                        "remote content moved for {}@{}: {} → {}",
                        plugin.name,
                        mp.name,
                        installed,
                        head
                    );
                }
            }

            plugin.skills_remote_known = remote.known;
            if remote.known {
                let local = std::mem::take(&mut plugin.skills);
                plugin.skills = marketplace_remote::merge_skills(local, remote.models);
                remote_by_plugin.insert(plugin_key(&mp.name, &plugin.name), remote.details);
            }
        }
    }

    // Persist whatever versions this pass learnt, so the next launch starts from
    // them instead of re-probing under the same cap.
    flush_uninstalled_versions();

    if probes_skipped > 0 || probes_from_memo > 0 {
        tracing::info!(
            "sweep: not-installed plugins - {probes_from_memo} from cache, {uninstalled_probes} probed, {probes_skipped} left for a later pass (cap: {probe_cap})"
        );
    }

    // 4) Reconcile in-flight PR statuses so "in review" badges clear once a PR
    // merges/closes. The dedicated PR-history tab used to drive this; the
    // regular refresh now does it. Best-effort, provider-aware.
    // `pr_poller` owns PR status when it is running: it checks the same records
    // on its own timer, so doing it here too is one extra request per open PR on
    // every sweep for an answer nothing was waiting on.
    if !settings.ui.pr_polling_enabled && !over_budget() {
        reconcile_open_prs(&settings);
    }

    let local_only = local_scanner::build_local_only_marketplace();

    // 5) Settle every skill folder's sync status. This is the only point where
    // both halves are in hand — what is on disk and what the remote holds — so
    // it is the only place that can tell an edit from an addition from a
    // deletion. The filesystem watcher keeps it live until the next sweep.
    feed_skill_watch(app, &mut marketplaces, &remote_by_plugin);

    tracing::info!(
        "refresh_all done: {} marketplace(s), {} local-only skill(s)",
        marketplaces.len(),
        local_only.plugins.iter().map(|p| p.skills.len()).sum::<usize>()
    );
    let result = RefreshResult {
        marketplaces,
        local_only,
    };
    remember_sweep(&result);
    Ok(result)
}

/// How long a not-installed plugin's version stands without being re-read.
///
/// It only decides what a catalogue row says. Re-reading it every half hour for
/// a 168-plugin catalogue is hundreds of requests to keep a label honest that
/// nothing acts on; installed plugins — the ones whose version drives the
/// "obsolète" badge — are never served from here.
const UNINSTALLED_VERSION_TTL_SECS: u64 = 6 * 3600;

/// One remembered probe. `version: None` is a remembered *miss* — the probe ran
/// and found no version — and is as worth keeping as a hit.
#[derive(Clone, Serialize, Deserialize)]
struct VersionMemoEntry {
    version: Option<String>,
    /// Unix seconds. A wall clock rather than an `Instant`, because this
    /// outlives the process now.
    at: u64,
}

#[derive(Default)]
struct VersionMemo {
    entries: std::collections::HashMap<String, VersionMemoEntry>,
    /// Set by every insert, cleared by [`flush_uninstalled_versions`]; the file
    /// is only rewritten when something actually changed.
    dirty: bool,
}

static UNINSTALLED_VERSIONS: std::sync::Mutex<Option<VersionMemo>> = std::sync::Mutex::new(None);

/// `<exe_dir>/config/plugin_versions.json`.
fn version_memo_path() -> PathBuf {
    config::app_settings_dir().join("plugin_versions.json")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Read the memo back from disk, dropping whatever has expired.
///
/// Without this the memo was per-session, so the first sweep after every launch
/// paid the full probe cap again — and a cap of 40 against a 246-plugin
/// catalogue means the versions were never all learnt in the first place.
fn load_version_memo() -> VersionMemo {
    let path = version_memo_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return VersionMemo::default();
    };
    let parsed: std::collections::HashMap<String, VersionMemoEntry> =
        match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("plugin_versions.json unreadable ({e}) — starting empty");
                return VersionMemo::default();
            }
        };
    let now = now_secs();
    let entries: std::collections::HashMap<_, _> = parsed
        .into_iter()
        .filter(|(_, e)| now.saturating_sub(e.at) < UNINSTALLED_VERSION_TTL_SECS)
        .collect();
    tracing::debug!("plugin version memo: {} entry(ies) restored", entries.len());
    VersionMemo {
        entries,
        dirty: false,
    }
}

fn uninstalled_memo_key(gh: &GitHubClient, src: &crate::models::PluginSource) -> String {
    format!("{}|{}|{}", gh.host(), src.repo, src.r#ref)
}

/// The remembered version for a not-installed plugin, if it is still fresh.
fn uninstalled_version_memo(
    gh: &GitHubClient,
    src: &crate::models::PluginSource,
) -> Option<Option<String>> {
    let key = uninstalled_memo_key(gh, src);
    let mut guard = UNINSTALLED_VERSIONS.lock().unwrap_or_else(|e| e.into_inner());
    let memo = guard.get_or_insert_with(load_version_memo);
    let entry = memo.entries.get(&key)?;
    (now_secs().saturating_sub(entry.at) < UNINSTALLED_VERSION_TTL_SECS)
        .then(|| entry.version.clone())
}

fn remember_uninstalled_version(
    gh: &GitHubClient,
    src: &crate::models::PluginSource,
    version: Option<String>,
) {
    let key = uninstalled_memo_key(gh, src);
    let mut guard = UNINSTALLED_VERSIONS.lock().unwrap_or_else(|e| e.into_inner());
    let memo = guard.get_or_insert_with(load_version_memo);
    // Blown wholesale rather than evicted by age: it is a cache for catalogue
    // labels, and the cap only bounds a pathological catalogue.
    if memo.entries.len() >= 2000 {
        memo.entries.clear();
    }
    memo.entries.insert(key, VersionMemoEntry { version, at: now_secs() });
    memo.dirty = true;
}

/// Write the memo out, once, at the end of a sweep that learnt something.
///
/// `atomic_write_json` skips a byte-identical rewrite, and `dirty` keeps a sweep
/// that probed nothing from even serializing.
fn flush_uninstalled_versions() {
    let payload = {
        let mut guard = UNINSTALLED_VERSIONS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(memo) = guard.as_mut() else {
            return;
        };
        if !memo.dirty {
            return;
        }
        memo.dirty = false;
        let now = now_secs();
        memo.entries
            .retain(|_, e| now.saturating_sub(e.at) < UNINSTALLED_VERSION_TTL_SECS);
        serde_json::to_value(&memo.entries)
    };
    match payload {
        Ok(v) => {
            if let Err(e) = installer::atomic_write_json(&version_memo_path(), &v) {
                tracing::warn!("could not persist the plugin version memo: {e}");
            }
        }
        Err(e) => tracing::warn!("could not serialize the plugin version memo: {e}"),
    }
}

fn plugin_key(marketplace: &str, plugin: &str) -> String {
    format!("{plugin}@{marketplace}")
}

/// Hand the watcher what the sweep learned: one [`SkillInput`] per installed
/// skill folder, the remote skills that have no local folder (candidate
/// deletions), and the plugin directories to watch recursively.
///
/// Watching plugin *roots* rather than individual skill folders is what makes a
/// newly created skill visible: `<plugin>/skills/<new>/` is an event in
/// `<plugin>/skills/`, which nothing was listening to before.
///
/// Note there is no `editable` filter here. Detection is local and free; whether
/// the user may *push* the result is a separate question, answered in the UI by
/// the marketplace's push rights. Gating detection on it meant the watch set
/// collapsed to empty whenever the forge was unreachable — precisely when local
/// edits pile up unnoticed.
fn feed_skill_watch(
    app: &AppHandle,
    marketplaces: &mut [Marketplace],
    remote_by_plugin: &std::collections::HashMap<String, Vec<marketplace_remote::RemoteSkill>>,
) {
    let mut inputs: Vec<SkillInput> = Vec::new();
    let mut missing: Vec<MissingLocal> = Vec::new();
    let mut plugin_roots: Vec<String> = Vec::new();
    // Plugin roots whose remote listing was actually read this pass — the
    // watcher needs them to tell "the forge says this skill is gone upstream"
    // from "the forge could not be reached".
    let mut remote_known_roots: Vec<String> = Vec::new();
    // (plugin root, marketplace index, plugin index) — lets the pass below find
    // which plugin a deleted folder belongs to without walking the tree again.
    let mut roots_by_plugin: Vec<(PathBuf, usize, usize)> = Vec::new();

    for (mp_idx, mp) in marketplaces.iter_mut().enumerate() {
        for (pl_idx, plugin) in mp.plugins.iter_mut().enumerate() {
            let Some(install_path) = plugin.install_path.clone() else {
                continue;
            };
            let root = local_scanner::resolve_plugin_root(&install_path);
            plugin_roots.push(root.to_string_lossy().into_owned());
            roots_by_plugin.push((root.clone(), mp_idx, pl_idx));

            let remote = remote_by_plugin.get(&plugin_key(&mp.name, &plugin.name));
            let blobs_by_key: std::collections::HashMap<&str, &Vec<(String, String)>> = remote
                .map(|rs| rs.iter().map(|r| (r.key.as_str(), &r.blobs)).collect())
                .unwrap_or_default();

            let remote_known = plugin.skills_remote_known;
            if remote_known {
                remote_known_roots.push(root.to_string_lossy().into_owned());
            }
            let mut local_keys: std::collections::HashSet<String> =
                std::collections::HashSet::new();
            for skill in plugin.skills.iter_mut() {
                let Some(folder) = skill.folder.clone() else {
                    continue;
                };
                let key = marketplace_remote::skill_key(&skill.relative_path);
                local_keys.insert(key.clone());
                skill.watch_folder = Some(folder.clone());
                inputs.push(SkillInput {
                    folder: folder.to_string_lossy().into_owned(),
                    remote_known,
                    remote_present: skill.remote_present,
                    remote_blobs: blobs_by_key.get(key.as_str()).map(|b| (*b).clone()),
                });
            }

            // Remote skills with nothing on disk. Whether that means "deleted" or
            // "never installed here" is the watcher's call — it holds the only
            // evidence that settles it, a baseline for that exact folder. Either
            // way the entry needs a `watch_folder`, since `folder` is `None` by
            // definition and the UI has to key the badge on something.
            if let Some(rs) = remote {
                for r in rs {
                    if local_keys.contains(&r.key) {
                        continue;
                    }
                    let folder =
                        root.join(r.relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                    let as_str = folder.to_string_lossy().into_owned();
                    for skill in plugin.skills.iter_mut() {
                        if skill.folder.is_none()
                            && marketplace_remote::skill_key(&skill.relative_path) == r.key
                        {
                            skill.watch_folder = Some(folder.clone());
                        }
                    }
                    missing.push(MissingLocal { folder: as_str });
                }
            }
        }
    }

    // The user's standalone skills carry no upstream, so they get no sync status
    // — but the directory is still watched so creating one refreshes the tree.
    let user_skills = config::claude_user_skills_dir();
    if user_skills.is_dir() {
        plugin_roots.push(user_skills.to_string_lossy().into_owned());
    }

    let watch = app.state::<SkillWatch>();
    let states = watch.sync(app, inputs, missing, plugin_roots, remote_known_roots);

    // Re-attach deletions the forge could not confirm. `merge_skills` only runs
    // when the plugin's listing was read, so with the forge unreachable nothing
    // in `plugin.skills` represents a folder the user deleted — no tree row, no
    // entry in the Changes tab, no sidebar badge — even though the watcher still
    // holds the pending removal. Rebuild the row from the watcher's verdict.
    for st in states.iter() {
        if st.status != SkillSync::Deleted {
            continue;
        }
        let folder = PathBuf::from(&st.folder);
        // Longest matching root wins: plugin directories never nest today, but
        // picking by first match would be a silent mis-assignment if they did.
        let owner = roots_by_plugin
            .iter()
            .filter(|(root, _, _)| folder.starts_with(root))
            .max_by_key(|(root, _, _)| root.components().count());
        let Some((root, mp_idx, pl_idx)) = owner else {
            continue;
        };
        let plugin = &mut marketplaces[*mp_idx].plugins[*pl_idx];
        if plugin
            .skills
            .iter()
            .any(|s| s.watch_folder.as_deref() == Some(folder.as_path()))
        {
            continue;
        }
        let rel = folder
            .strip_prefix(root)
            .unwrap_or(&folder)
            .to_string_lossy()
            .replace('\\', "/");
        let name = folder
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| rel.clone());
        plugin.skills.push(Skill {
            name,
            folder: None,
            watch_folder: Some(folder),
            relative_path: rel,
            plugin_name: Some(plugin.name.clone()),
            marketplace_name: Some(marketplaces[*mp_idx].name.clone()),
            // The removal is pushable, which is the whole reason to show it.
            remote_present: true,
            ..Default::default()
        });
    }

    let actionable = states
        .iter()
        .filter(|s| s.status.is_actionable())
        .count();
    tracing::info!(
        "skill sync: {} folder(s), {} needing action",
        states.len(),
        actionable
    );
}

#[tauri::command]
pub async fn install_plugin_cmd(plugin: Plugin, watch: State<'_, SkillWatch>) -> Result<PathBuf> {
    let s = config::load_settings();
    let gh = client_for_source(&s, plugin.source.as_ref(), &plugin.marketplace_name)?;
    let name = plugin.name.clone();
    let mp = plugin.marketplace_name.clone();
    match installer::install_plugin(&gh, &plugin) {
        Ok(p) => {
            tracing::info!("install_plugin ok: {}@{}", name, mp);
            // The freshly-extracted content is the new baseline — clear any stale
            // one from a previous install so the plugin isn't flagged "modified".
            watch.forget_under(&p);
            Ok(p)
        }
        Err(e) => {
            tracing::error!("install_plugin failed: {}@{}: {}", name, mp, e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn uninstall_plugin_cmd(plugin: Plugin, watch: State<'_, SkillWatch>) -> Result<()> {
    let name = plugin.name.clone();
    let mp = plugin.marketplace_name.clone();
    let path = plugin.install_path.clone();
    match installer::uninstall(&plugin) {
        Ok(()) => {
            tracing::info!("uninstall_plugin ok: {}@{}", name, mp);
            // Drop the removed plugin's baselines so a later reinstall starts
            // clean instead of diffing against a now-deleted folder's hash.
            if let Some(p) = &path {
                watch.forget_under(p);
            }
            Ok(())
        }
        Err(e) => {
            tracing::error!("uninstall_plugin failed: {}@{}: {}", name, mp, e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn install_marketplace_cmd(
    name: String,
    repo: String,
    r#ref: String,
    auto_update: Option<bool>,
    provider: Option<Provider>,
    base_url: Option<String>,
) -> Result<PathBuf> {
    // Build the client from the explicit provider/base_url passed by the
    // frontend so install doesn't depend on the marketplace config having been
    // saved first.
    let provider = provider.unwrap_or(Provider::Github);
    let base_url = base_url.unwrap_or_default();
    let gh = match provider {
        Provider::Gitea => gitea_client(&config::load_settings(), &base_url)?,
        Provider::Github => gh()?,
    };
    let label = name.clone();
    let repo_label = repo.clone();
    match marketplace_installer::install_marketplace(&gh, &name, &repo, &r#ref, auto_update) {
        Ok(p) => {
            tracing::info!("install_marketplace ok: {} from {}", label, repo_label);
            Ok(p)
        }
        Err(e) => {
            tracing::error!(
                "install_marketplace failed: {} from {}: {}",
                label,
                repo_label,
                e
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn uninstall_marketplace_cmd(name: String) -> Result<()> {
    let label = name.clone();
    match marketplace_installer::uninstall_marketplace(&name) {
        Ok(()) => {
            tracing::info!("uninstall_marketplace ok: {}", label);
            Ok(())
        }
        Err(e) => {
            tracing::error!("uninstall_marketplace failed: {}: {}", label, e);
            Err(e)
        }
    }
}

/// Full removal of a marketplace from the app's view.
///
/// `uninstall_marketplace` only touches `known_marketplaces.json` and the
/// marketplace folder — `installed_plugins.json` still has `"<plugin>@<mp>"`
/// keys, and the orphan-detection in `build_marketplaces_from_settings` would
/// resurrect the marketplace from those keys alone. So a real "delete"
/// cascades: uninstall every plugin recorded under this marketplace, then the
/// marketplace itself, then forget it from the app's settings.
///
/// Per-plugin failures are non-fatal — we always continue and report them in
/// the log, because partial cleanup is still better than nothing.
#[tauri::command]
pub async fn delete_marketplace_completely(name: String) -> Result<Settings> {
    tracing::info!("delete_marketplace_completely: {}", name);
    let plugins = local_scanner::installed_plugins_by_marketplace()
        .remove(&name)
        .unwrap_or_default();
    for plugin in plugins {
        if let Err(e) = installer::uninstall(&plugin) {
            tracing::warn!(
                "delete_marketplace_completely: failed to uninstall plugin '{}' from '{}': {}",
                plugin.name,
                name,
                e
            );
        }
    }
    if let Err(e) = marketplace_installer::uninstall_marketplace(&name) {
        tracing::warn!(
            "delete_marketplace_completely: uninstall_marketplace('{}') failed: {}",
            name,
            e
        );
    }
    let mut s = config::load_settings();
    s.marketplaces.retain(|m| m.name != name);
    config::save_settings(&s)?;
    Ok(s)
}

/// Uninstall a marketplace AND every plugin installed from it, while keeping it
/// registered in the app's settings so it stays available to re-install. This is
/// the Skills-page "Désinstaller" affordance — distinct from
/// [`delete_marketplace_completely`], which additionally forgets the marketplace
/// from settings.
///
/// Per-plugin failures are non-fatal (logged, then we continue) so partial
/// cleanup still happens; a failure removing the marketplace folder itself is
/// surfaced to the caller.
#[tauri::command]
pub async fn uninstall_marketplace_cascade(name: String) -> Result<()> {
    tracing::info!("uninstall_marketplace_cascade: {}", name);
    let plugins = local_scanner::installed_plugins_by_marketplace()
        .remove(&name)
        .unwrap_or_default();
    for plugin in plugins {
        if let Err(e) = installer::uninstall(&plugin) {
            tracing::warn!(
                "uninstall_marketplace_cascade: failed to uninstall plugin '{}' from '{}': {}",
                plugin.name,
                name,
                e
            );
        }
    }
    marketplace_installer::uninstall_marketplace(&name)?;
    tracing::info!("uninstall_marketplace_cascade ok: {}", name);
    Ok(())
}

#[tauri::command]
pub async fn set_marketplace_auto_update(name: String, value: bool) -> Result<bool> {
    tracing::info!("set_marketplace_auto_update: {} -> {}", name, value);
    marketplace_installer::set_auto_update(&name, value)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub name: String,
    pub updated: bool,
    pub message: String,
}

#[tauri::command]
pub async fn check_marketplace_updates(only: Option<String>) -> Vec<UpdateCheckResult> {
    let settings = config::load_settings();
    let mut out = Vec::new();
    for cfg in &settings.marketplaces {
        if cfg.github_repo.is_empty() {
            continue;
        }
        if !marketplace_installer::is_marketplace_installed(&cfg.name) {
            continue;
        }
        if only.as_deref().is_some_and(|n| n != cfg.name) {
            continue;
        }
        let Ok(gh) = client_for_cfg(&settings, Some(cfg)) else {
            continue;
        };
        let r#ref = if cfg.default_branch.is_empty() {
            "main"
        } else {
            &cfg.default_branch
        };
        let (updated, msg) =
            marketplace_installer::auto_update_if_changed(&gh, &cfg.name, &cfg.github_repo, r#ref);
        out.push(UpdateCheckResult {
            name: cfg.name.clone(),
            updated,
            message: msg,
        });
    }
    out
}

#[tauri::command]
pub fn parse_marketplace_url(url: String) -> Option<String> {
    crate::registry::parse_github_marketplace_url(&url)
}

/// Which forge a marketplace URL points at, and which Gitea instance if any.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeGuess {
    pub provider: Provider,
    /// Instance root for Gitea, empty for GitHub.
    pub base_url: String,
    /// `owner/repo`, or empty when the URL does not carry one.
    pub repo: String,
    /// Bare host, for the message when nothing matched.
    pub host: String,
    /// False when the host is neither github.com nor a registered Gitea
    /// instance — the caller has to ask rather than guess.
    pub known: bool,
}

/// Work out which forge a pasted marketplace URL belongs to.
///
/// The add-marketplace dialog used to take the forge from a toggle whose
/// default was Gitea, so pasting a `github.com` URL without touching it
/// registered the marketplace against the internal Gitea instance and tried to
/// download the repo from there. The URL already says which forge it is; ask it.
#[tauri::command]
pub async fn guess_forge_for_url(url: String) -> ForgeGuess {
    let s = config::load_settings();
    let host = host_of(&url);
    let repo = crate::registry::parse_github_marketplace_url(&url).unwrap_or_default();
    let is_github = matches!(
        host.to_ascii_lowercase().as_str(),
        "github.com" | "www.github.com" | "api.github.com"
    );
    if is_github {
        return ForgeGuess {
            provider: Provider::Github,
            base_url: String::new(),
            repo,
            host,
            known: true,
        };
    }
    if let Some(inst) = s
        .gitea_instances
        .iter()
        .find(|i| host_of(&i.base_url).eq_ignore_ascii_case(&host))
    {
        return ForgeGuess {
            provider: Provider::Gitea,
            base_url: inst.base_url.clone(),
            repo,
            host,
            known: true,
        };
    }
    ForgeGuess {
        provider: Provider::Gitea,
        base_url: String::new(),
        repo,
        host,
        known: false,
    }
}

/// The repository's own default branch, so a marketplace is not registered
/// against a hard-coded `main` it may not have. Falls back to `main` when the
/// forge cannot be read — the install then resolves it again for real.
#[tauri::command]
pub async fn resolve_default_branch(
    repo: String,
    provider: Option<Provider>,
    base_url: Option<String>,
) -> String {
    let s = config::load_settings();
    let client = match provider.unwrap_or(Provider::Github) {
        Provider::Gitea => gitea_client(&s, &base_url.unwrap_or_default()),
        Provider::Github => GitHubClient::new(&s.github_token),
    };
    match client.and_then(|c| c.get_default_branch(&repo)) {
        Ok(b) if !b.trim().is_empty() => b,
        Ok(_) => "main".to_string(),
        Err(e) => {
            tracing::debug!("resolve_default_branch({repo}) failed, assuming main: {e}");
            "main".to_string()
        }
    }
}

#[tauri::command]
pub async fn set_plugin_enabled(plugin: String, marketplace: String, value: bool) -> Result<()> {
    tracing::info!(
        "set_plugin_enabled: {}@{} -> {}",
        plugin,
        marketplace,
        value
    );
    plugin_state::set_enabled(&plugin, &marketplace, value)
}

#[tauri::command]
pub async fn list_skill_files(folder: PathBuf) -> Result<Vec<String>> {
    let mut out = Vec::new();
    if !folder.is_dir() {
        return Ok(out);
    }
    for entry in walkdir::WalkDir::new(&folder).max_depth(3).sort_by_file_name() {
        let Ok(entry) = entry else { continue };
        if entry.path() == folder {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(&folder) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn read_text_file(path: PathBuf) -> Result<String> {
    std::fs::read_to_string(&path).map_err(crate::error::Error::from)
}

/// Open a URL or filesystem path through the Windows shell (or platform
/// equivalent). Bypasses `tauri-plugin-opener`'s scope system, which silently
/// drops unscoped `file://` and `https://` targets in v2.
#[tauri::command]
pub async fn open_in_shell(target: String) -> Result<()> {
    let t = target.trim();
    if t.is_empty() {
        return Err(crate::error::Error::Invalid("empty target".into()));
    }
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        let target_wide: Vec<u16> = OsStr::new(t)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let verb_wide: Vec<u16> = OsStr::new("open")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(
                hwnd: *mut core::ffi::c_void,
                lp_operation: *const u16,
                lp_file: *const u16,
                lp_parameters: *const u16,
                lp_directory: *const u16,
                n_show_cmd: i32,
            ) -> isize;
        }
        const SW_SHOWNORMAL: i32 = 1;
        // ShellExecuteW returns >32 on success; any value <=32 is an error
        // code in the legacy HINSTANCE convention.
        let rc = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb_wide.as_ptr(),
                target_wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if rc > 32 {
            tracing::debug!("ShellExecuteW opened: {}", t);
            Ok(())
        } else {
            tracing::warn!(
                "ShellExecuteW failed for '{}' (code={})",
                t,
                rc
            );
            Err(crate::error::Error::Invalid(format!(
                "ShellExecuteW failed (code {rc})"
            )))
        }
    }
    #[cfg(not(windows))]
    {
        Err(crate::error::Error::Invalid(format!(
            "open_in_shell not implemented on this platform for: {t}"
        )))
    }
}

/// Launches VS Code with the given path opened as a folder/file.
///
/// Goes through `cmd /C code` on Windows because the VS Code launcher is
/// `code.cmd`, which Rust's `Command::new` won't pick up from PATH directly
/// (it searches for `.exe` only). `CREATE_NO_WINDOW` keeps the helper console
/// from flashing on screen. On other OSes we just call `code` directly.
///
/// We *don't* wait for the child — VS Code keeps running after this returns.
#[tauri::command]
pub async fn open_in_vscode(path: String) -> Result<()> {
    let p = path.trim();
    if p.is_empty() {
        return Err(crate::error::Error::Invalid("empty path".into()));
    }
    if !std::path::Path::new(p).exists() {
        return Err(crate::error::Error::Invalid(format!(
            "path does not exist: {p}"
        )));
    }
    tracing::info!("open_in_vscode: {}", p);

    let spawn_result = {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            std::process::Command::new("cmd")
                .args(["/C", "code", p])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
        }
        #[cfg(not(windows))]
        {
            std::process::Command::new("code").arg(p).spawn()
        }
    };

    spawn_result.map(|_| ()).map_err(|e| {
        tracing::warn!("open_in_vscode failed for '{}': {}", p, e);
        crate::error::Error::Invalid(format!(
            "Failed to launch VS Code: {e}. Make sure the `code` CLI is on \
             your PATH — in VS Code run the command 'Shell Command: Install \
             code command in PATH'."
        ))
    })
}

/// Last-modified timestamp for a file or directory, as an RFC3339 UTC string.
/// Returns `None` when the path doesn't exist or the FS doesn't expose mtime.
#[tauri::command]
pub async fn file_mtime(path: PathBuf) -> Option<String> {
    let meta = std::fs::metadata(&path).ok()?;
    let modified = meta.modified().ok()?;
    let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    let secs = dur.as_secs() as i64;
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, dur.subsec_nanos())
        .map(|dt| dt.to_rfc3339())
}

#[tauri::command]
pub async fn write_text_file(path: PathBuf, content: String) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content).map_err(crate::error::Error::from)
}

#[tauri::command]
pub async fn parse_skill_md(text: String) -> Value {
    let (fields, body) = parse_frontmatter(&text);
    serde_json::json!({ "fields": fields, "body": body })
}

#[tauri::command]
pub async fn github_auth_check() -> (bool, String) {
    match gh() {
        Ok(g) => g.auth_check(),
        Err(e) => (false, e.to_string()),
    }
}

#[tauri::command]
pub async fn github_rate_limit() -> (i64, i64) {
    match gh() {
        Ok(g) => g.get_rate_limit(),
        Err(_) => (-1, -1),
    }
}

#[tauri::command]
pub async fn github_can_push(repo: String) -> bool {
    match gh() {
        Ok(g) => g.can_push(&repo),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn github_token_scopes() -> Vec<String> {
    match gh() {
        Ok(g) => g.get_token_scopes(),
        Err(_) => Vec::new(),
    }
}

// ---------- Gitea instance commands ----------

#[tauri::command]
pub async fn gitea_auth_check(base_url: String) -> (bool, String) {
    let s = config::load_settings();
    match gitea_client(&s, &base_url) {
        Ok(g) => g.auth_check(),
        Err(e) => (false, e.to_string()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiteaStatus {
    pub base_url: String,
    pub host: String,
    pub has_token: bool,
    pub insecure_tls: bool,
    pub ok: bool,
    /// Login when authenticated, otherwise a short error/status message.
    pub user: String,
}

/// Connection status for every registered Gitea instance — the multi-host
/// analogue of [`github_auth_check`], so the dashboard and sidebar can show
/// each instance's auth state next to GitHub's. One network call per instance;
/// the frontend caches the result like the GitHub checks.
#[tauri::command]
pub async fn gitea_status_all() -> Vec<GiteaStatus> {
    let s = config::load_settings();
    let mut out = Vec::new();
    for inst in &s.gitea_instances {
        let (ok, user) = match gitea_client(&s, &inst.base_url) {
            Ok(g) => g.auth_check(),
            Err(e) => (false, e.to_string()),
        };
        out.push(GiteaStatus {
            host: host_of(&inst.base_url),
            base_url: inst.base_url.clone(),
            has_token: inst.has_token,
            insecure_tls: inst.insecure_tls,
            ok,
            user,
        });
    }
    out
}

/// Turn a `spawn_blocking` join failure into an `AppError`.
fn joined<T>(r: std::result::Result<T, tauri::Error>) -> Result<T> {
    r.map_err(|e| crate::error::Error::Other(format!("tâche interrompue : {e}")))
}

/// Read-only comparison of the Gitea `Claude` organisation against the GitHub
/// `sforge-labs` one. Writes nothing; safe to run at any time.
///
/// Runs on a blocking thread, **not** on the async runtime: everything under it
/// goes through `reqwest::blocking`, which owns an internal tokio runtime.
/// Building or dropping that from an async context is a documented misuse —
/// tokio panics with "Cannot drop a runtime in a context where blocking is not
/// allowed" — and when the client happens to come from the pool instead, the
/// misuse degrades into requests that simply never complete.
#[tauri::command]
pub async fn org_sync_compare() -> Result<org_sync::SyncReport> {
    joined(tauri::async_runtime::spawn_blocking(org_sync::compare).await)?
}

/// Replay the selected Gitea repositories onto GitHub, applying the same
/// rewrite rules the initial migration used.
///
/// Progress is emitted rather than returned as it goes: a full-history replay
/// runs for a while, and the dialog needs to show where it is. The final
/// per-repository outcome comes back as the return value.
#[tauri::command]
pub async fn org_sync_pull(
    app: AppHandle,
    sources: Vec<String>,
) -> Result<Vec<org_sync::RepoOutcome>> {
    tracing::info!("org_sync_pull: {} dépôt(s) demandé(s)", sources.len());
    // Blocking thread, for the reason spelled out on `org_sync_compare` — and
    // all the more so here: a replay makes hundreds of sequential blocking
    // calls, so parking an async worker for the whole run is not a detail.
    joined(
        tauri::async_runtime::spawn_blocking(move || {
            let mut on_progress = |p: org_sync::SyncProgress| {
                if let Err(e) = app.emit(org_sync::EVENT_PROGRESS, &p) {
                    tracing::debug!("emit {} failed (ignored): {}", org_sync::EVENT_PROGRESS, e);
                }
            };
            org_sync::pull(&sources, &mut on_progress)
        })
        .await,
    )?
}

/// Ask a running [`org_sync_pull`] to stop at its next checkpoint.
///
/// Cannot corrupt anything: a repository's branch is moved only once every
/// object it needs exists, so stopping short leaves GitHub untouched.
#[tauri::command]
pub async fn org_sync_cancel() {
    org_sync::request_cancel();
}

/// Register or update a Gitea instance (host + TLS mode). The token is set
/// separately via [`settings_set_gitea_token`].
#[tauri::command]
pub async fn settings_upsert_gitea_instance(
    base_url: String,
    insecure_tls: bool,
) -> Result<Settings> {
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() {
        return Err(crate::error::Error::Invalid(
            "Gitea instance URL is required.".into(),
        ));
    }
    let mut s = config::load_settings();
    let host = host_of(&base_url);
    match s
        .gitea_instances
        .iter_mut()
        .find(|i| host_of(&i.base_url) == host)
    {
        Some(existing) => {
            existing.base_url = base_url.clone();
            existing.insecure_tls = insecure_tls;
        }
        None => s.gitea_instances.push(GiteaInstance {
            base_url: base_url.clone(),
            insecure_tls,
            has_token: false,
        }),
    }
    config::save_settings(&s)?;
    tracing::info!("gitea instance upserted: {} (insecureTls={})", base_url, insecure_tls);
    Ok(config::load_settings())
}

/// Remove a Gitea instance and clear its stored token.
#[tauri::command]
pub async fn settings_remove_gitea_instance(base_url: String) -> Result<Settings> {
    let host = host_of(&base_url);
    let mut s = config::load_settings();
    s.gitea_instances.retain(|i| host_of(&i.base_url) != host);
    config::save_settings(&s)?;
    if let Err(e) = token_store::save_host(&host, "") {
        tracing::warn!("could not clear gitea token for {}: {}", host, e);
    }
    tracing::info!("gitea instance removed: {}", base_url);
    Ok(config::load_settings())
}

#[tauri::command]
pub async fn settings_set_gitea_token(base_url: String, token: String) -> Result<Settings> {
    let host = host_of(&base_url);
    tracing::info!("gitea token updated for {} (len={})", host, token.len());
    token_store::save_host(&host, &token)?;
    Ok(config::load_settings())
}

/// Read back the stored Gitea token for an instance so the Settings input can be
/// pre-filled, mirroring how the GitHub token is surfaced via `Settings`. Returns
/// an empty string when no token is stored. Like the GitHub token, this exposes
/// the credential to the frontend on request — consistent with the existing model.
#[tauri::command]
pub async fn gitea_get_token(base_url: String) -> Result<String> {
    let host = host_of(&base_url);
    Ok(token_store::load_host(&host)?.unwrap_or_default())
}

// ---------- Admin commands ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitChangesArgs {
    pub repo: String,
    pub base_branch: String,
    pub changes: Vec<FileChange>,
    #[serde(default)]
    pub deletions: Vec<String>,
    pub pr_title: String,
    #[serde(default)]
    pub pr_body: String,
    pub branch_prefix: String,
}

#[tauri::command]
pub async fn admin_submit_changes(args: SubmitChangesArgs) -> Result<UploadResult> {
    let gh = gh()?;
    let title = args.pr_title.clone();
    match admin::submit_changes(
        &gh,
        &args.repo,
        &args.base_branch,
        &args.changes,
        &args.pr_title,
        &args.pr_body,
        &args.branch_prefix,
        &args.deletions,
    ) {
        Ok(r) => Ok(r),
        Err(e) => {
            tracing::error!("admin.submit_changes failed: {}: {}", title, e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn admin_collect_skill_folder(
    folder: PathBuf,
    target_subpath: String,
) -> Result<Vec<FileChange>> {
    admin::collect_skill_folder_changes(&folder, &target_subpath)
}

#[tauri::command]
pub async fn admin_fetch_registry(repo: String, r#ref: String) -> Result<Value> {
    let gh = gh()?;
    let (data, path, _sha) = admin::fetch_marketplace_registry(&gh, &repo, &r#ref)?;
    Ok(serde_json::json!({ "data": data, "path": path }))
}

#[tauri::command]
pub async fn admin_validate_registry(registry: Value) -> Vec<String> {
    admin::validate_marketplace_registry(&registry)
}

#[tauri::command]
pub async fn admin_diff(old: String, new: String, path: String) -> String {
    admin::unified_diff(&old, &new, &path)
}

#[tauri::command]
pub async fn admin_bump_version(version: String, level: String) -> String {
    admin::bump_version(&version, &level)
}

#[tauri::command]
pub async fn admin_build_skill_md(name: String, description: String, body: String) -> Vec<u8> {
    admin::build_skill_md(&name, &description, &body)
}

// ---------- Notification history (the status bar's bell) ----------

#[tauri::command]
pub async fn notifications_list() -> Vec<notification_history::StoredNotification> {
    notification_history::load_all()
}

/// Record a notification the frontend just raised.
///
/// Called for its side effect only, and the frontend does not await it: failing
/// to persist a toast must never break the operation that raised it, which is
/// usually the one the user actually asked for.
#[tauri::command]
pub async fn notifications_push(
    entry: notification_history::StoredNotification,
) -> Result<()> {
    notification_history::add(entry)
}

#[tauri::command]
pub async fn notifications_remove(id: String) -> Result<()> {
    notification_history::remove(&id)
}

#[tauri::command]
pub async fn notifications_clear() -> Result<()> {
    notification_history::clear_all()
}

// ---------- PR history & pending ----------

#[tauri::command]
pub async fn pr_history_list() -> Vec<PRRecord> {
    pr_history::load_all()
}

#[tauri::command]
pub async fn pr_history_remove(repo: String, number: i64) -> Result<()> {
    pr_history::remove(&repo, number)
}

#[tauri::command]
pub async fn pr_history_clear() -> Result<()> {
    pr_history::clear_all()
}

/// Derive a PR's lifecycle status ("merged" | "closed" | "open") from a forge
/// PR JSON object. GitHub and Gitea share these fields.
pub(crate) fn pr_status_of(pr: &Value) -> &'static str {
    if pr.get("merged_at").and_then(|v| v.as_str()).is_some() {
        "merged"
    } else if pr
        .get("state")
        .and_then(|v| v.as_str())
        .map(|s| s.eq_ignore_ascii_case("closed"))
        .unwrap_or(false)
    {
        "closed"
    } else {
        "open"
    }
}

/// The commit a merge produced on the base branch. GitHub exposes
/// `merge_commit_sha`; Gitea exposes `merged_commit_id`. Empty when neither is
/// present (the caller then falls back to the repo's default-branch HEAD).
fn merge_commit_sha_of(pr: &Value) -> String {
    pr.get("merge_commit_sha")
        .and_then(|v| v.as_str())
        .or_else(|| pr.get("merged_commit_id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string()
}

/// Settle a tracked PR that left the "open" state. On a merge, create any
/// tags/releases the PR deferred at submit time (cut from the merge commit, so
/// they point at content that actually landed). On a plain close, nothing is
/// tagged — by design. Either way the pending record is dropped so the Admin tab
/// stops showing the PR as "in review".
pub(crate) fn finalize_pr_outcome(
    client: &GitHubClient,
    repo: &str,
    number: i64,
    pr: &Value,
    status: &str,
) {
    if status == "merged" {
        let merge_sha = merge_commit_sha_of(pr);
        for rec in pending_prs::find_by_pr(repo, number) {
            if rec.deferred_tags.is_empty() {
                continue;
            }
            tracing::info!(
                "PR {}#{} merged → creating {} deferred tag(s)",
                repo,
                number,
                rec.deferred_tags.len()
            );
            admin_drafts::create_deferred_tags_on_merge(
                client,
                &rec.deferred_tags,
                &rec.plugin_name,
                &merge_sha,
                number,
                &rec.pr_url,
            );
        }
    }
    let _ = pending_prs::remove_by_pr(repo, number);
}

/// Re-check every PR still marked "open" in `pr_history` against its forge and,
/// when it has merged/closed, update the history record and drop any matching
/// `pending_prs` entry — so the Admin "in review" badges clear automatically.
///
/// This used to be driven by the (now removed) PR-history tab; it now runs as
/// part of the regular refresh. Provider-aware via each record's own
/// `provider`/`base_url`. Best-effort: per-PR failures are logged, never fatal.
fn reconcile_open_prs(s: &Settings) {
    for rec in pr_history::load_all()
        .into_iter()
        .filter(|r| r.status == "open")
    {
        let client = match rec.provider {
            Provider::Gitea => gitea_client(s, &rec.base_url),
            _ => GitHubClient::new(&s.github_token),
        };
        let client = match client {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    "reconcile_open_prs: client init for {}#{} failed: {}",
                    rec.repo, rec.number, e
                );
                continue;
            }
        };
        let pr = match client.get_pull_request(&rec.repo, rec.number) {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(
                    "reconcile_open_prs: get PR {}#{} failed: {}",
                    rec.repo, rec.number, e
                );
                continue;
            }
        };
        let status = pr_status_of(&pr);
        if status != "open" {
            let _ = pr_history::update_status(&rec.repo, rec.number, status);
            finalize_pr_outcome(&client, &rec.repo, rec.number, &pr, status);
            tracing::info!("reconcile_open_prs: PR {}#{} → {}", rec.repo, rec.number, status);
        }
    }
}

#[tauri::command]
pub async fn pr_history_refresh_status(repo: String, number: i64) -> Result<String> {
    // Target the forge the PR actually lives on (recorded at creation time).
    let rec = pr_history::load_all()
        .into_iter()
        .find(|r| r.repo == repo && r.number == number);
    let gh = match rec {
        Some(r) if r.provider == Provider::Gitea => {
            gitea_client(&config::load_settings(), &r.base_url)?
        }
        _ => gh()?,
    };
    let pr = gh.get_pull_request(&repo, number)?;
    let status = pr_status_of(&pr);
    pr_history::update_status(&repo, number, status)?;
    // Once a PR leaves the "open" state, create any tags it deferred (on merge)
    // and drop the pending record so the Admin tab stops showing it "in review".
    if status != "open" {
        finalize_pr_outcome(&gh, &repo, number, &pr, status);
    }
    Ok(status.to_string())
}

#[tauri::command]
pub async fn pending_prs_list() -> Vec<PendingPR> {
    pending_prs::load_all()
}

#[tauri::command]
pub async fn pending_prs_upsert(item: PendingPR) -> Result<()> {
    pending_prs::upsert(item)
}

#[tauri::command]
pub async fn pending_prs_remove(
    marketplace: String,
    plugin: String,
    action: String,
) -> Result<()> {
    pending_prs::remove(&marketplace, &plugin, &action)
}

// ---------- Marketplace PR tracking ("Suivi Marketplace") ----------

/// One open PR surfaced by the marketplace tracker. Unlike [`PRRecord`] (only
/// PRs this app opened), these are *all* open PRs on a tracked marketplace's
/// repo and its plugins' repos, regardless of author.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedPr {
    pub marketplace_name: String,
    /// "marketplace" | "plugin"
    pub scope: String,
    /// Plugin name for plugin-scoped PRs; empty for marketplace-scoped.
    pub plugin_name: String,
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub author: String,
    /// True when the PR's author is this client's authenticated user — drives
    /// the "Mes demandes" section. Forge-specific, computed per fetching client.
    pub mine: bool,
    /// Whether the current user may approve this PR, per the hybrid policy in
    /// [`GitHubClient::can_approve`] — drives the "Demandes à valider" section.
    pub can_approve: bool,
    /// PR target branch (`base.ref`); used to resolve the branch-protection rule.
    pub base_branch: String,
    pub created_at: String,
    pub provider: Provider,
    pub base_url: String,
}

/// Map a forge PR JSON object (GitHub or Gitea — same shape for these fields)
/// into a [`TrackedPr`]. Returns `None` when the entry has no PR number.
#[allow(clippy::too_many_arguments)]
fn tracked_pr_from_value(
    v: &Value,
    marketplace_name: &str,
    scope: &str,
    plugin_name: &str,
    repo: &str,
    provider: Provider,
    base_url: &str,
) -> Option<TrackedPr> {
    let number = v.get("number").and_then(|x| x.as_i64())?;
    Some(TrackedPr {
        marketplace_name: marketplace_name.to_string(),
        scope: scope.to_string(),
        plugin_name: plugin_name.to_string(),
        repo: repo.to_string(),
        number,
        title: v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        url: v.get("html_url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        author: v
            .get("user")
            .and_then(|u| u.get("login"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        // `mine` / `can_approve` are stamped afterwards by `enrich_tracked_pr`,
        // which needs the fetching client and its authenticated login.
        mine: false,
        can_approve: false,
        base_branch: v
            .get("base")
            .and_then(|b| b.get("ref"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        created_at: v.get("created_at").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        provider,
        base_url: base_url.to_string(),
    })
}

/// Stamp `mine` / `can_approve` on a freshly-mapped [`TrackedPr`]. `login` is
/// the fetching client's authenticated user (forge-specific); `approve_cache`
/// memoizes the per-(repo, branch) approval decision so repeated PRs on the
/// same branch don't re-query the forge.
fn enrich_tracked_pr(
    pr: &mut TrackedPr,
    client: &GitHubClient,
    login: Option<&str>,
    approve_cache: &mut std::collections::HashMap<String, bool>,
) {
    pr.mine = match login {
        Some(l) => !l.is_empty() && !pr.author.is_empty() && l.eq_ignore_ascii_case(&pr.author),
        None => false,
    };
    let key = format!("{}@{}", pr.repo, pr.base_branch);
    pr.can_approve = *approve_cache
        .entry(key)
        .or_insert_with(|| client.can_approve(&pr.repo, &pr.base_branch, login.unwrap_or("")));
}

/// Fetch open PRs for every marketplace we maintain (forge push rights) or that
/// is explicitly flagged `track_prs` — optionally narrowed to `only` — plus each
/// of their plugins' source repos we can push to. Tracking thus turns itself on
/// for the repos you maintain, no manual toggle needed; the `track_prs` flag
/// stays a manual override for repos you don't own but still want to watch.
/// Network-heavy and provider-aware; per-repo failures are logged and skipped,
/// never fatal.
///
/// Runs the blocking forge calls inline (same pattern as `refresh_all`): it's a
/// user-triggered fetch, not a hot path.
#[tauri::command]
pub async fn track_marketplace_prs(only: Option<String>) -> Result<Vec<TrackedPr>> {
    let s = config::load_settings();
    let mut out: Vec<TrackedPr> = Vec::new();
    // Avoid re-querying the same plugin repo twice within one marketplace.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Authenticated login per forge (keyed by base_url) so we resolve `/user`
    // once per instance instead of once per repo.
    let mut login_cache: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    // Per-(repo@branch) approval decision, shared across all PRs in this run.
    let mut approve_cache: std::collections::HashMap<String, bool> =
        std::collections::HashMap::new();

    for cfg in &s.marketplaces {
        if cfg.github_repo.is_empty() {
            continue;
        }
        if let Some(name) = &only {
            if &cfg.name != name {
                continue;
            }
        }

        let gh = match client_for_cfg(&s, Some(cfg)) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("track_marketplace_prs: client init failed for {}: {}", cfg.name, e);
                continue;
            }
        };

        // Auto-enable: track this marketplace when we can push to its repo (same
        // `can_push` gate that drives `editable`), or when the user opted in via
        // the `track_prs` override. Otherwise skip it entirely.
        let track = cfg.track_prs || gh.can_push(&cfg.github_repo);
        if !track {
            tracing::debug!(
                "track_marketplace_prs: skipping {} (no push rights, track_prs off)",
                cfg.name
            );
            continue;
        }

        let gh_login = login_cache
            .entry(gh.base_url())
            .or_insert_with(|| gh.current_login())
            .clone();

        match gh.list_open_prs(&cfg.github_repo) {
            Ok(prs) => {
                for v in &prs {
                    if let Some(mut pr) = tracked_pr_from_value(
                        v, &cfg.name, "marketplace", "", &cfg.github_repo, cfg.provider, &cfg.base_url,
                    ) {
                        enrich_tracked_pr(&mut pr, &gh, gh_login.as_deref(), &mut approve_cache);
                        out.push(pr);
                    }
                }
            }
            Err(e) => tracing::warn!(
                "track_marketplace_prs: list PRs failed for marketplace {} ({}): {}",
                cfg.name, cfg.github_repo, e
            ),
        }

        // Plugin-level PRs: resolve each plugin's own source repo/forge, and
        // track it when we can push to that plugin repo (or the marketplace was
        // explicitly opted in). So you see PRs on the plugins you maintain, not
        // noise from plugins you only consume.
        let (plugins, _) = marketplace_remote::fetch_marketplace_plugins(
            &gh, &cfg.github_repo, &cfg.default_branch, &cfg.name,
        );
        for p in &plugins {
            let Some(src) = p.source.as_ref() else { continue };
            if src.repo.is_empty() {
                continue;
            }
            if !seen.insert(format!("{}::{}", cfg.name, src.repo)) {
                continue;
            }
            let pclient = match client_for_source(&s, p.source.as_ref(), &cfg.name) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(
                        "track_marketplace_prs: plugin client init failed for {} ({}): {}",
                        p.name, src.repo, e
                    );
                    continue;
                }
            };
            if !(cfg.track_prs || pclient.can_push(&src.repo)) {
                tracing::debug!(
                    "track_marketplace_prs: skipping plugin {} ({}) — no push rights",
                    p.name, src.repo
                );
                continue;
            }
            let provider = pclient.provider();
            let base_url = pclient.base_url();
            let p_login = login_cache
                .entry(pclient.base_url())
                .or_insert_with(|| pclient.current_login())
                .clone();
            match pclient.list_open_prs(&src.repo) {
                Ok(prs) => {
                    for v in &prs {
                        if let Some(mut pr) = tracked_pr_from_value(
                            v, &cfg.name, "plugin", &p.name, &src.repo, provider, &base_url,
                        ) {
                            enrich_tracked_pr(&mut pr, &pclient, p_login.as_deref(), &mut approve_cache);
                            out.push(pr);
                        }
                    }
                }
                Err(e) => tracing::warn!(
                    "track_marketplace_prs: list PRs failed for plugin {} ({}): {}",
                    p.name, src.repo, e
                ),
            }
        }
    }
    // Only surface PRs the user has a stake in: their own (`mine`) or ones they
    // may approve (`can_approve`). Others' PRs on a merely-watched repo (no merge
    // rights) are dropped here so they never reach the "Suivi Marketplace" list —
    // without approval rights you see only your own requests.
    out.retain(|pr| pr.mine || pr.can_approve);
    Ok(out)
}

// ---------- App settings sub-commands ----------

#[tauri::command]
pub async fn settings_upsert_marketplace(cfg: MarketplaceConfig) -> Result<Settings> {
    let mut s = config::load_settings();
    if let Some(idx) = s.marketplaces.iter().position(|m| m.name == cfg.name) {
        s.marketplaces[idx] = cfg;
    } else {
        s.marketplaces.push(cfg);
    }
    config::save_settings(&s)?;
    Ok(s)
}

#[tauri::command]
pub async fn settings_remove_marketplace(name: String) -> Result<Settings> {
    let mut s = config::load_settings();
    s.marketplaces.retain(|m| m.name != name);
    config::save_settings(&s)?;
    Ok(s)
}

#[tauri::command]
pub async fn settings_set_token(token: String) -> Result<Settings> {
    tracing::info!("github token updated (len={})", token.len());
    token_store::save(&token)?;
    // Reload so the returned Settings reflects what's actually stored.
    Ok(config::load_settings())
}

#[tauri::command]
pub async fn settings_set_ui(ui: UiPrefs) -> Result<Settings> {
    let mut s = config::load_settings();
    s.ui = ui;
    config::save_settings(&s)?;
    Ok(s)
}

#[tauri::command]
pub async fn settings_export() -> Result<String> {
    // Never include the GitHub token in an export blob — it stays in the OS
    // credential vault. Users re-enter it after importing on another machine.
    let mut s = config::load_settings();
    s.github_token.clear();
    serde_json::to_string_pretty(&s).map_err(crate::error::Error::from)
}

#[tauri::command]
pub async fn settings_import(payload: String) -> Result<Settings> {
    let s: Settings =
        serde_json::from_str(&payload).map_err(crate::error::Error::from)?;
    // Back-compat: an export from an older build may still carry a token.
    // Lift it into the credential vault rather than dropping it on disk.
    if !s.github_token.is_empty() {
        if let Err(e) = token_store::save(&s.github_token) {
            tracing::warn!("could not store imported token in credential vault: {e}");
        }
    }
    let mut to_save = s.clone();
    to_save.github_token.clear();
    config::save_settings(&to_save)?;
    tracing::info!(
        "imported settings: {} marketplace(s)",
        s.marketplaces.len()
    );
    Ok(config::load_settings())
}

#[tauri::command]
pub async fn settings_paths() -> serde_json::Value {
    serde_json::json!({
        "exeDir": config::exe_dir(),
        "configDir": config::app_settings_dir(),
        "logsDir": config::logs_dir(),
        "configFile": config::config_properties_file(),
        "marketplacesFile": config::marketplaces_file(),
        "loggingFile": config::logging_properties_file(),
    })
}

// ---------- Logging commands ----------

#[tauri::command]
pub async fn logging_get_config() -> LoggingConfig {
    config::load_logging_config()
}

#[tauri::command]
pub async fn logging_set_config(cfg: LoggingConfig) -> Result<LoggingConfig> {
    config::save_logging_config(&cfg)?;
    tracing::info!(
        "logging config updated: enabled={} level={}",
        cfg.enabled,
        cfg.level
    );
    Ok(cfg)
}

#[tauri::command]
pub async fn logging_purge() -> Result<u32> {
    let removed = logger::purge().map_err(crate::error::Error::from)?;
    Ok(removed as u32)
}

#[tauri::command]
pub async fn logging_tail(max_bytes: Option<usize>) -> Result<String> {
    logger::tail(max_bytes.unwrap_or(64 * 1024))
        .map_err(crate::error::Error::from)
}

#[tauri::command]
pub async fn logging_log(level: String, target: Option<String>, message: String) {
    let target = target.unwrap_or_else(|| "frontend".to_string());
    match level.to_ascii_uppercase().as_str() {
        "ERROR" => tracing::error!(target: "frontend", "[{}] {}", target, message),
        "WARN" => tracing::warn!(target: "frontend", "[{}] {}", target, message),
        "DEBUG" => tracing::debug!(target: "frontend", "[{}] {}", target, message),
        "TRACE" => tracing::trace!(target: "frontend", "[{}] {}", target, message),
        _ => tracing::info!(target: "frontend", "[{}] {}", target, message),
    }
}

// ---------- Admin draft commands ----------

#[tauri::command]
pub async fn admin_prepare_add_plugin(
    marketplace: String,
    source_url: String,
    bump_level: Option<String>,
    version_description: Option<String>,
) -> Result<AdminDraft> {
    let bump_level = bump_level.unwrap_or_default();
    let version_description = version_description.unwrap_or_default();
    if version_description.trim().is_empty() {
        return Err(crate::error::Error::Invalid(
            "La description de version est obligatoire.".into(),
        ));
    }
    logged_admin("admin_prepare_add_plugin", format!("{source_url} -> {marketplace}"), || {
        let gh = client_for_marketplace(&marketplace)?;
        admin_drafts::prepare_add_plugin(
            &gh,
            &marketplace,
            &source_url,
            &bump_level,
            &version_description,
        )
    })
}

#[tauri::command]
pub async fn admin_prepare_bump_plugin(
    marketplace: String,
    plugin_name: String,
    new_version: String,
    version_description: Option<String>,
) -> Result<AdminDraft> {
    let version_description = version_description.unwrap_or_default();
    if version_description.trim().is_empty() {
        return Err(crate::error::Error::Invalid(
            "La description de version est obligatoire.".into(),
        ));
    }
    logged_admin("admin_prepare_bump_plugin", format!("{plugin_name}@{marketplace} -> {new_version}"), || {
        let gh = client_for_marketplace(&marketplace)?;
        admin_drafts::prepare_bump_plugin(
            &gh,
            &marketplace,
            &plugin_name,
            &new_version,
            &version_description,
        )
    })
}

#[tauri::command]
pub async fn admin_prepare_remove_plugin(
    marketplace: String,
    plugin_name: String,
) -> Result<AdminDraft> {
    logged_admin("admin_prepare_remove_plugin", format!("{plugin_name}@{marketplace}"), || {
        let gh = client_for_marketplace(&marketplace)?;
        admin_drafts::prepare_remove_plugin(&gh, &marketplace, &plugin_name)
    })
}

#[tauri::command]
pub async fn admin_prepare_upload_skill(args: UploadSkillArgs) -> Result<AdminDraft> {
    if args.version_description.trim().is_empty() {
        return Err(crate::error::Error::Invalid(
            "La description de version est obligatoire.".into(),
        ));
    }
    logged_admin("admin_prepare_upload_skill", format!("{}@{}", args.plugin_name, args.marketplace), || {
        let gh = client_for_marketplace(&args.marketplace)?;
        admin_drafts::prepare_upload_skill(&gh, &args)
    })
}

/// Bulk upload: several skills → ONE PR against the plugin's repo (single manifest
/// bump). The frontend groups dirty skills by plugin and calls this once per
/// group. Same "description de version obligatoire" rule as the single flow.
#[tauri::command]
pub async fn admin_prepare_upload_skills(args: BulkUploadArgs) -> Result<AdminDraft> {
    if args.version_description.trim().is_empty() {
        return Err(crate::error::Error::Invalid(
            "La description de version est obligatoire.".into(),
        ));
    }
    logged_admin(
        "admin_prepare_upload_skills",
        format!("{} ({} skills)", args.plugin_name, args.items.len()),
        || {
            let gh = client_for_marketplace(&args.marketplace)?;
            admin_drafts::prepare_upload_skills(&gh, &args)
        },
    )
}

#[tauri::command]
pub async fn admin_prepare_delete_skill(
    marketplace: String,
    plugin_name: String,
    skill_name: String,
) -> Result<AdminDraft> {
    logged_admin("admin_prepare_delete_skill", format!("{skill_name} ({plugin_name}@{marketplace})"), || {
        let gh = client_for_marketplace(&marketplace)?;
        admin_drafts::prepare_delete_skill(&gh, &marketplace, &plugin_name, &skill_name)
    })
}

#[tauri::command]
pub async fn admin_submit_draft(draft: AdminDraft) -> Result<UploadResult> {
    // Resolve the client from the draft's marketplace so PRs land on the right
    // forge (the plugin source repo is on the same host as its marketplace).
    let marketplace = draft
        .pending_meta
        .as_ref()
        .map(|m| m.marketplace_name.clone())
        .unwrap_or_default();
    let gh = client_for_marketplace(&marketplace)?;
    let title = draft.pr_title.clone();
    match admin_drafts::submit_draft(&gh, &draft) {
        Ok(r) => Ok(r),
        Err(e) => {
            tracing::error!("admin.submit_changes failed: {}: {}", title, e);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn admin_create_tag(repo: String, tag: String, marketplace: Option<String>) -> Result<String> {
    let gh = match marketplace {
        Some(m) if !m.is_empty() => client_for_marketplace(&m)?,
        _ => gh()?,
    };
    admin_drafts::create_tag_if_missing(&gh, &repo, &tag)
}

#[tauri::command]
pub async fn admin_list_user_skills() -> Vec<LocalSkill> {
    admin_drafts::list_user_skills()
}

#[tauri::command]
pub async fn admin_list_remote_skills(
    marketplace: String,
    plugin_name: String,
) -> Result<Vec<RemoteSkillInfo>> {
    let s = config::load_settings();
    let result = (|| {
        // The registry lives on the marketplace's own repo → marketplace client.
        let mp_gh = client_for_cfg(&s, s.get_marketplace(&marketplace))?;
        let (plugin_repo, plugin_url) =
            admin_drafts::resolve_plugin_source(&mp_gh, &marketplace, &plugin_name)?;
        // The plugin may live on a different forge than its marketplace — read
        // its skills with a client targeting the plugin's own host, falling back
        // to the marketplace client when the source carries no host hint.
        let plugin_gh = match client_for_source_url(&s, &plugin_url, "") {
            Some(c) => c?,
            None => mp_gh.clone(),
        };
        admin_drafts::list_skills_in_repo(&plugin_gh, &plugin_repo)
    })();
    if let Err(e) = &result {
        tracing::warn!(
            "admin_list_remote_skills {}@{} failed: {}",
            plugin_name,
            marketplace,
            e
        );
    }
    result
}

#[tauri::command]
pub async fn admin_suggest_bumps(version: String) -> BumpSuggestion {
    admin_drafts::suggest_bumps(&version)
}

// Type alias kept so the commands file is the single source of truth for
// the `Skill` struct re-exports the frontend may want.
pub type _SkillExport = Skill;

// ---------- Duplicate-skill detection ----------

#[tauri::command]
pub async fn list_duplicate_skills() -> Vec<local_scanner::DuplicateSkill> {
    local_scanner::find_duplicate_skills()
}

#[tauri::command]
pub async fn archive_user_skill(folder: PathBuf) -> Result<PathBuf> {
    tracing::info!("archive_user_skill: {}", folder.display());
    local_scanner::archive_user_skill_folder(&folder)
}

/// Delete a skill folder from disk.
///
/// Returns `true` when the removal is something to push: a plugin skill still
/// exists on the remote, so it lands as `Deleted` and the user opens a PR for
/// it. A standalone user skill has no upstream — it is simply gone, which is why
/// the reversible `archive_user_skill` stays the gentler option there.
///
/// The baseline is captured *before* the bytes go: it is the only evidence that
/// turns "the remote has it, the disk does not" into a deletion rather than a
/// skill this install never had.
#[tauri::command]
pub async fn delete_skill_local(
    app: AppHandle,
    watch: State<'_, SkillWatch>,
    folder: String,
) -> Result<bool> {
    tracing::info!("delete_skill_local: {folder}");
    let path = PathBuf::from(&folder);
    let kind = local_scanner::classify_skill_folder(&path)?;
    // A skill still flagged `New` was never pushed, so the plugin repo has no
    // folder to remove and there is nothing to publish. Deleting it undoes the
    // creation rather than starting a removal: reported as untracked, so the
    // row simply leaves the tree instead of turning red and queueing a PR that
    // would delete files the repo never had.
    let never_pushed = watch.status_of(&folder) == Some(SkillSync::New);
    let tracked = kind == local_scanner::SkillFolderKind::Plugin && !never_pushed;
    if tracked {
        watch.ensure_baseline(&folder);
    }
    local_scanner::delete_skill_folder(&path)?;
    if tracked {
        // Key on the string the caller passed, never a canonicalized form: the
        // baseline map is keyed on exactly what the sweep handed us.
        watch.mark_deleted(&app, &folder);
    } else {
        watch.forget(&app, &folder);
    }
    Ok(tracked)
}

#[tauri::command]
pub async fn list_archived_skills() -> Vec<local_scanner::ArchivedSkill> {
    local_scanner::list_archived_skills()
}

#[tauri::command]
pub async fn restore_archived_skill(folder: PathBuf) -> Result<PathBuf> {
    tracing::info!("restore_archived_skill: {}", folder.display());
    local_scanner::restore_archived_skill_folder(&folder)
}

// ---------- App self-update ----------

#[tauri::command]
pub async fn app_check_update() -> Result<AppUpdateInfo> {
    app_updater::check_for_update()
}

/// The update already swapped onto disk this session, if any. The UI asks on
/// mount so a window opened *after* the background updater ran still shows the
/// "restart to finish" affordance.
#[tauri::command]
pub async fn app_update_staged() -> Option<StagedUpdate> {
    app_updater::staged()
}

/// The release the background poller found and has not seen installed yet.
/// Same reason as `app_update_staged`: in tray mode the window is destroyed,
/// and the announcement that raised the banner may be hours old.
#[tauri::command]
pub async fn app_update_available() -> Option<update_poller::UpdateEvent> {
    update_poller::last_available()
}

/// The user closed the update banner. Recorded in the process rather than in
/// the store, which dies with the webview on a tray close — otherwise reopening
/// the window would put the dismissed banner straight back.
#[tauri::command]
pub async fn app_update_dismiss(version: String) {
    update_poller::dismiss(&version);
}

/// The published releases, newest first — feeds the "Notes de mise à jour"
/// panel. Separate from `app_check_update`, which only ever sees the latest
/// release and so could never show the notes of the version you are running.
#[tauri::command]
pub async fn app_release_notes(limit: Option<u32>) -> Result<Vec<app_updater::ReleaseNote>> {
    app_updater::fetch_releases(limit.unwrap_or(15))
}

/// How often the download may push an event to the frontend. A 10 MB asset
/// arrives in ~160 chunks of 64 KB; emitting each one would spam the bus for a
/// bar that only moves a pixel. One every 120 ms is smooth and cheap.
const PROGRESS_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(120);

/// Build a progress sink that emits `app-update-progress`, throttled.
///
/// The final call of each phase is always let through (`downloaded == total`),
/// so the bar reliably lands on 100 % instead of stopping at whatever the last
/// tick happened to be.
fn progress_emitter(
    app: AppHandle,
    version: String,
) -> impl FnMut(app_updater::UpdatePhase, u64, u64) {
    let mut last = std::time::Instant::now() - PROGRESS_MIN_INTERVAL;
    let mut last_phase: Option<app_updater::UpdatePhase> = None;
    move |phase, downloaded, total| {
        let complete = total > 0 && downloaded >= total;
        let new_phase = last_phase != Some(phase);
        if !complete && !new_phase && last.elapsed() < PROGRESS_MIN_INTERVAL {
            return;
        }
        last = std::time::Instant::now();
        last_phase = Some(phase);
        let payload = update_poller::UpdateProgress {
            version: version.clone(),
            phase,
            downloaded,
            total,
        };
        if let Err(e) = app.emit(update_poller::EVENT_PROGRESS, &payload) {
            tracing::debug!("app update: emit progress failed: {}", e);
        }
    }
}

/// Update in place: download the release's portable binary and swap it onto
/// `skillmanager.exe`. Nothing is uninstalled, no installer window appears, and
/// this session keeps running the old build until the user restarts.
///
/// Only ever called from a user gesture ("Installer") — the background poller
/// detects and announces, it never downloads.
#[tauri::command]
pub async fn app_apply_update(app: AppHandle, info: AppUpdateInfo) -> Result<StagedUpdate> {
    tracing::info!(
        "app_apply_update: {} -> {}",
        info.current_version,
        info.latest_version.as_deref().unwrap_or("?")
    );
    let version = info.latest_version.clone().unwrap_or_default();
    let mut on_progress = progress_emitter(app.clone(), version.clone());
    // Logged, not just returned: the dashboard's "Activité récente" is built by
    // reading the log file back, and a version bump that failed is exactly the
    // kind of thing someone comes looking for there. The success side is
    // `app_updater`'s own "applied in place" line.
    let staged = app_updater::apply_update(&info, &mut on_progress).inspect_err(|e| {
        tracing::error!(
            "app_apply_update failed: {} -> {}: {}",
            info.current_version,
            if version.is_empty() { "?" } else { &version },
            e
        );
    })?;
    // The pending release is no longer pending; a window rebuilt after this
    // must not be handed an offer that has already been taken.
    update_poller::clear_available();
    // One event for every consumer (banner, sidebar pill, Settings card) rather
    // than each of them reacting to the command's return value.
    let payload = update_poller::UpdateEvent {
        version: staged.version.clone(),
        running_version: staged.running_version.clone(),
        release_notes: staged.release_notes.clone(),
        release_url: staged.release_url.clone(),
        staged: true,
        can_self_update: true,
    };
    if let Err(e) = app.emit(update_poller::EVENT_READY, &payload) {
        tracing::debug!("app_apply_update: emit ready failed: {}", e);
    }
    // The download outlives the window: closing to tray destroys the webview,
    // so the in-app toast may have nobody to reach. `notify_staged` checks that
    // itself and stays quiet when a window is up.
    update_poller::notify_staged(&app, &payload);
    Ok(staged)
}

/// Restart into whatever `skillmanager.exe` now holds — the new build after an
/// in-place update. The relaunched process waits for this one to exit before it
/// arms the single-instance guard.
#[tauri::command]
pub async fn app_restart(app: AppHandle) -> Result<()> {
    app_updater::relaunch()?;
    tracing::info!("app_restart: successor spawned, exiting");
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        app.exit(0);
    });
    Ok(())
}

/// Fallback for installs the in-place swap can't touch (read-only directory, or
/// a release that ships no portable binary): download the NSIS installer to
/// %TEMP%, spawn it silently, then exit so it can replace files. The user may
/// still see a UAC prompt when the install location needs elevation.
#[tauri::command]
pub async fn app_install_update(
    app: AppHandle,
    asset_url: String,
    asset_name: String,
) -> Result<()> {
    let mut on_progress = progress_emitter(app.clone(), asset_name.clone());
    let path = app_updater::download_installer(&asset_url, &asset_name, &mut on_progress)?;
    app_updater::launch_installer(&path)?;
    tracing::info!("app_install_update: installer launched, exiting app");
    // Tiny delay so the spawned process is fully detached, then quit. Without
    // this the installer occasionally fails to grab the file lock on the
    // running .exe before we exit and Windows blocks it.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        app.exit(0);
    });
    Ok(())
}

#[tauri::command]
pub async fn app_detect_uninstaller() -> UninstallInfo {
    app_uninstaller::detect()
}

/// Spawn the registered uninstaller and exit. Errors when the install is
/// portable (no uninstall.exe + no registry entry); the front-end is expected
/// to surface that case with a "delete the folder manually" message.
#[tauri::command]
pub async fn app_uninstall(app: AppHandle) -> Result<()> {
    let info = app_uninstaller::detect();
    if info.kind == "none" {
        tracing::warn!("app_uninstall: no uninstaller registered (portable install)");
        return Err(crate::error::Error::Invalid(
            "No uninstaller found. This looks like a portable install — \
             close SkillManager and delete the folder manually."
                .into(),
        ));
    }
    app_uninstaller::launch(&info)?;
    tracing::info!(
        "app_uninstall: uninstaller spawned ({}), exiting app",
        info.kind
    );
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        app.exit(0);
    });
    Ok(())
}

// ============================================================
// Skill change detection (filesystem watcher)
// ============================================================

/// Accept a skill folder's current contents as the synced reference. Called once
/// a PR has been opened for that skill so the badge stops nudging.
#[tauri::command]
pub async fn skill_mark_synced(state: State<'_, SkillWatch>, folder: String) -> Result<()> {
    state.mark_synced(&folder);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSkillArgs {
    /// The target plugin (only `install_path` is used, to locate its folder).
    pub plugin: Plugin,
    /// "blank" (scaffold a SKILL.md) or "copy" (import `source_folder`).
    pub mode: String,
    /// Skill name → both the frontmatter `name:` and the (slugged) folder name.
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub body: String,
    /// Source folder to copy in, for `mode == "copy"`.
    #[serde(default)]
    pub source_folder: String,
}

/// Create a new skill inside an installed plugin's folder (`skills/<slug>/`) and
/// flag it "modifié" so it surfaces the push nudge / bulk selection. `blank`
/// scaffolds a SKILL.md from name+description(+body); `copy` imports an existing
/// local skill folder wholesale.
#[tauri::command]
pub async fn add_skill_to_plugin(
    app: AppHandle,
    watch: State<'_, SkillWatch>,
    args: AddSkillArgs,
) -> Result<PathBuf> {
    let install_path = args.plugin.install_path.clone().ok_or_else(|| {
        crate::error::Error::Invalid(
            "Ce plugin n'est pas installé localement — impossible d'y ajouter un skill.".into(),
        )
    })?;
    let mode = match args.mode.as_str() {
        "copy" => {
            if args.source_folder.trim().is_empty() {
                return Err(crate::error::Error::Invalid(
                    "Aucun dossier source fourni pour l'import.".into(),
                ));
            }
            local_scanner::NewSkillMode::Copy {
                source: PathBuf::from(args.source_folder.trim()),
            }
        }
        _ => local_scanner::NewSkillMode::Blank {
            description: args.description.clone(),
            body: args.body.clone(),
        },
    };
    let dest = local_scanner::create_skill_in_plugin(&install_path, &args.name, mode)?;
    tracing::info!(
        "add_skill_to_plugin: {}@{} -> {}",
        args.plugin.name,
        args.plugin.marketplace_name,
        dest.display()
    );
    // Flag it as "new, not yet pushed" so the badge lights up immediately.
    watch.mark_new(&app, &dest.to_string_lossy());
    Ok(dest)
}

/// Re-seed the UI's sync map from the watcher's in-memory state (no rescan).
/// The statuses themselves are settled by the refresh sweep, not here.
#[tauri::command]
pub async fn skill_sync_list(state: State<'_, SkillWatch>) -> Result<Vec<SkillState>> {
    Ok(state.states())
}

// ---------- Usage audit ----------

/// Build the usage-audit report for the `[from, to]` window (ISO datetimes;
/// empty = unbounded). Parsing ~130 MB of transcripts is CPU-bound, so it runs
/// on a blocking thread; only transcripts whose stamp changed are re-parsed.
#[tauri::command]
pub async fn usage_audit(from: String, to: String) -> Result<crate::usage_audit::UsageReport> {
    tokio::task::spawn_blocking(move || crate::usage_audit::build_report(&from, &to))
        .await
        .map_err(|e| crate::error::Error::Other(format!("join: {e}")))?
}

/// Build the report for `[from, to]` and write it as a multi-sheet `.xlsx` to
/// `path`. Returns the written path.
#[tauri::command]
pub async fn usage_export_xlsx(path: String, from: String, to: String) -> Result<String> {
    tokio::task::spawn_blocking(move || crate::usage_audit::export_xlsx(&path, &from, &to))
        .await
        .map_err(|e| crate::error::Error::Other(format!("join: {e}")))?
}

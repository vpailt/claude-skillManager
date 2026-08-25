//! Fetch a marketplace registry from a GitHub repo and merge with local install
//! state — port of src/marketplace_remote.py.

use crate::github_client::GitHubClient;
use crate::models::{InstallState, Plugin, PluginSource, Skill};
use crate::registry::parse_marketplace_json;

pub const REGISTRY_PATH: &str = ".claude-plugin/marketplace.json";

/// Fetch a marketplace's plugin list from its registry. Returns
/// `(plugins, remote_ok)` where `remote_ok` is `true` only when the registry
/// file was actually read and parsed — distinct from "read it and it listed
/// zero plugins". Callers use the flag to tell "the catalogue dropped this
/// plugin" (drop it) apart from "we couldn't reach the catalogue" (keep the
/// stale local view); see [`merge_local_remote`].
pub fn fetch_marketplace_plugins(
    gh: &GitHubClient,
    repo: &str,
    r#ref: &str,
    marketplace_name: &str,
) -> (Vec<Plugin>, bool) {
    let r#ref = if r#ref.is_empty() {
        gh.get_default_branch(repo).unwrap_or_else(|_| "main".into())
    } else {
        r#ref.to_string()
    };
    // Keep the underlying read error so an empty result is diagnosable — a
    // self-hosted Gitea behind a VPN or missing its per-host token fails here
    // and the caller otherwise only sees "no remote plugins".
    let mut last_err = None;
    for path in [REGISTRY_PATH, "marketplace.json"] {
        match gh.get_file(repo, path, &r#ref) {
            Ok((text, _)) => return (parse_marketplace_json(&text, marketplace_name), true),
            Err(e) => last_err = Some(e),
        }
    }
    if let Some(e) = last_err {
        tracing::warn!(
            "fetch_marketplace_plugins: could not read registry for {repo}@{r}: {e}",
            r = r#ref
        );
    }
    (Vec::new(), false)
}

pub fn merge_local_remote(
    mut local_plugins: Vec<Plugin>,
    remote_plugins: Vec<Plugin>,
    remote_ok: bool,
) -> Vec<Plugin> {
    use std::collections::HashSet;
    let mut by_name = std::collections::HashMap::new();
    for p in local_plugins.drain(..) {
        by_name.insert(p.name.clone(), p);
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut merged = Vec::new();
    for r in remote_plugins {
        seen.insert(r.name.clone());
        if let Some(mut l) = by_name.remove(&r.name) {
            l.latest_version = r.latest_version;
            l.remote_present = true;
            if l.description.is_empty() {
                l.description = r.description;
            }
            l.source = r.source.or(l.source);
            l.install_state = compute_state(&l);
            merged.push(l);
        } else {
            let mut r = r;
            r.install_state = InstallState::NotInstalled;
            merged.push(r);
        }
    }
    for (_, mut l) in by_name {
        // Plugins the remote fetch didn't return.
        if l.installed_version.is_some() {
            if remote_ok {
                // The catalogue WAS read and doesn't list it, yet it's on disk
                // → genuine LocalOnly.
                l.install_state = InstallState::LocalOnly;
            }
            // Remote read failed: keep the state the local scan computed
            // (Installed / Outdated). A registry we couldn't reach is not
            // evidence the plugin left the catalogue — flipping every installed
            // plugin to "local uniquement" on a transient failure (VPN-gated
            // Gitea, timeout, rate limit) is exactly the flicker this avoids.
            merged.push(l);
            continue;
        }
        if remote_ok {
            // The catalogue WAS read and doesn't list this not-installed plugin
            // → it was removed upstream. Drop it instead of resurrecting a stale
            // local-directory copy (which the directory scan keeps re-injecting
            // until the marketplace is re-pulled). Only safe because the remote
            // read succeeded.
            continue;
        }
        // Remote read failed: keep the stale-but-usable local view. A plugin we
        // still know from a registry (`remote_present` — e.g. the directory scan
        // of an installed marketplace whose remote re-fetch just failed, common
        // for self-hosted Gitea behind a VPN or without a token) stays
        // installable; otherwise it's Unknown.
        l.install_state = if l.remote_present {
            InstallState::NotInstalled
        } else {
            InstallState::Unknown
        };
        merged.push(l);
    }
    merged
}

/// Read a plugin's authoritative current version from its **own** repo manifest
/// (`manifest.json`, falling back to `.claude-plugin/plugin.json`) on
/// `source.ref`. This is the "main always published" model: the marketplace
/// registry no longer pins a per-release version — the plugin repo's manifest on
/// its tracked branch is the source of truth. Returns `None` if the repo is
/// unset or no readable manifest carries a non-empty `version`.
///
/// Reads on `source.ref` (not the default branch) so detection stays consistent
/// with what `installer::install_plugin` actually pulls — reporting "outdated"
/// against a ref we wouldn't install from would loop forever.
pub fn fetch_plugin_manifest_version(
    gh: &GitHubClient,
    source: &PluginSource,
) -> Option<String> {
    if source.repo.is_empty() {
        return None;
    }
    for path in ["manifest.json", ".claude-plugin/plugin.json"] {
        let Ok((text, _)) = gh.get_file(&source.repo, path, &source.r#ref) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if let Some(v) = json.get("version").and_then(|v| v.as_str()) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Authoritative latest version from the plugin repo's **git tags**: the
/// highest semver-looking tag on `repo`. This is the source of truth now that
/// marketplace registries no longer pin a per-release `version` — releases are
/// cut as tags on the plugin repo. Tags are compared numerically on their
/// dotted release head (a leading `v`/`V` and any `-prerelease`/`+build` suffix
/// are ignored); non-numeric tags (e.g. `nightly`) are skipped. The chosen tag
/// is returned with any leading `v`/`V` stripped so it lines up with
/// `installed_version` formatting (the UI renders `v{latest_version}`).
///
/// Returns `None` when the repo is unset, has no tags, or none parse as semver
/// — callers then fall back to [`fetch_plugin_manifest_version`].
pub fn fetch_latest_tag_version(gh: &GitHubClient, repo: &str) -> Option<String> {
    if repo.is_empty() {
        return None;
    }
    let tags = gh.list_tags(repo).ok()?;
    tags.into_iter()
        .filter_map(|t| {
            let key = norm(&t);
            // `norm` returns the i64::MIN sentinel for non-numeric versions.
            if key == [i64::MIN] {
                None
            } else {
                Some((key, t))
            }
        })
        // Vec<i64> orders lexicographically, which matches numeric semver
        // precedence here (e.g. [1,2,0] < [1,10,0]).
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, t)| t.trim().trim_start_matches(['v', 'V']).to_string())
}

/// Re-derive `install_state` after `latest_version` was replaced out-of-band
/// (e.g. by a live manifest read at refresh, after `merge_local_remote` already
/// ran its semver compare against the registry seed).
pub fn recompute_state(p: &mut Plugin) {
    p.install_state = compute_state(p);
}

fn compute_state(p: &Plugin) -> InstallState {
    install_state_for(
        p.installed_version.as_deref(),
        p.latest_version.as_deref(),
        p.remote_present,
    )
}

/// Derive a plugin's [`InstallState`] from its installed vs latest version.
/// Shared by the remote merge ([`compute_state`]) and the local directory merge
/// (`local_scanner::merge_directory_plugins`) so both agree on what "outdated"
/// means.
///
/// Crucially, an UNKNOWN latest version is **not** "outdated": a plugin can't be
/// behind a version we don't know. Registries no longer pin a `version`
/// (Anthropic's official marketplace omits it, and user registries dropped it),
/// so an empty `latest` is the norm — treating it as outdated would pin every
/// installed plugin to a permanent, unfixable "Mettre à jour" button.
/// `remote_present` separates a plugin still listed in a registry (Installed)
/// from one we've lost all remote knowledge of (LocalOnly).
pub fn install_state_for(
    installed: Option<&str>,
    latest: Option<&str>,
    remote_present: bool,
) -> InstallState {
    let installed = installed.unwrap_or("").trim();
    if installed.is_empty() {
        return InstallState::NotInstalled;
    }
    let latest = latest.unwrap_or("").trim();
    if latest.is_empty() {
        return if remote_present {
            InstallState::Installed
        } else {
            InstallState::LocalOnly
        };
    }
    if semver_eq(installed, latest) {
        InstallState::Installed
    } else {
        InstallState::Outdated
    }
}

fn semver_eq(a: &str, b: &str) -> bool {
    norm(a) == norm(b)
}

fn norm(v: &str) -> Vec<i64> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let head = v.split('-').next().unwrap_or("");
    let mut out = Vec::new();
    for part in head.split('.') {
        match part.parse::<i64>() {
            Ok(n) => out.push(n),
            Err(_) => return vec![i64::MIN], // sentinel: invalid → only equal to itself
        }
    }
    out
}

/// One skill as it exists on the plugin's remote repo.
pub struct RemoteSkill {
    /// Identity key: the folder path under `skills/`, posix, lowercased.
    pub key: String,
    /// Folder basename — the name the upload/delete operations address.
    pub name: String,
    /// Path relative to the plugin root, e.g. `skills/foo`.
    pub relative_path: String,
    /// Every file under the skill folder: path relative to the *skill folder*
    /// (posix) → git blob SHA. Lets a local folder be compared byte-exactly
    /// without downloading anything.
    pub blobs: Vec<(String, String)>,
}

/// List a plugin repo's skills from a single recursive git-tree read.
///
/// Returns `(skills, remote_known)`. `remote_known` is `false` **only** when the
/// listing genuinely failed; a repo with no `skills/` directory returns
/// `(vec![], true)`. That distinction is the whole point: this function used to
/// swallow every error into an empty vector, so "the VPN is down" and "this
/// plugin ships no skills" were the same answer — and downstream, every locally
/// installed skill then looked like an unpushed local addition.
///
/// Three things the old Contents-API walk got wrong, fixed here by construction:
/// skills nested one level deeper (`skills/<group>/<skill>/`) were invisible;
/// `source.path` (a plugin living in a subdirectory of its repo) was ignored, so
/// the listing looked at the wrong `skills/`; and identity was the folder
/// basename, which does not survive being compared against a local frontmatter
/// `name:`.
/// What one plugin repo's skill listing yielded.
#[derive(Default)]
pub struct RemoteSkills {
    /// Skills as domain models, for merging into the plugin's skill list.
    pub models: Vec<Skill>,
    /// The same skills with their blob SHAs, for the sync comparison.
    pub details: Vec<RemoteSkill>,
    /// `true` only when the listing actually succeeded — never for a failure.
    pub known: bool,
    /// The commit the tracked ref points at. Saves the caller resolving the ref
    /// again to answer "did the repo move since we installed it?", and keeps
    /// both answers describing the same commit.
    pub head_sha: Option<String>,
}

pub fn fetch_plugin_skills(
    gh: &GitHubClient,
    source: &PluginSource,
    plugin_name: &str,
    marketplace_name: &str,
) -> RemoteSkills {
    if source.repo.is_empty() {
        return RemoteSkills::default();
    }
    let (head_sha, tree) = match gh.list_tree(&source.repo, &source.r#ref) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(
                "fetch_plugin_skills: git tree read failed for {}@{}: {e}",
                source.repo,
                if source.r#ref.is_empty() { "default" } else { &source.r#ref }
            );
            return RemoteSkills::default();
        }
    };

    // Everything lives under `<source.path>/skills/` — `source.path` is the
    // plugin's own root inside its repo (empty for the usual case).
    let prefix = {
        let p = source.path.trim_matches('/');
        if p.is_empty() {
            "skills/".to_string()
        } else {
            format!("{p}/skills/")
        }
    };

    // A skill folder is any directory directly holding a SKILL.md, at any depth.
    // Collect those first, then attribute every blob to the deepest one that
    // contains it, so a group folder never swallows its children's files.
    let mut roots: Vec<String> = Vec::new();
    for e in &tree {
        if e.kind != "blob" {
            continue;
        }
        let Some(rest) = e.path.strip_prefix(&prefix) else {
            continue;
        };
        let Some((dir, file)) = rest.rsplit_once('/') else {
            continue;
        };
        if file.eq_ignore_ascii_case("SKILL.md") && !dir.is_empty() {
            roots.push(dir.to_string());
        }
    }
    // Deepest first so the attribution below picks the most specific owner.
    // Deduped because a folder holding both `SKILL.md` and `skill.md` would
    // otherwise become two roots — the second collecting no blobs (attribution
    // stops at the first match) and surfacing as a phantom empty skill.
    roots.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    roots.dedup();

    let mut skills: Vec<RemoteSkill> = roots
        .iter()
        .map(|dir| RemoteSkill {
            key: dir.to_lowercase(),
            name: dir.rsplit('/').next().unwrap_or(dir).to_string(),
            relative_path: format!("skills/{dir}"),
            blobs: Vec::new(),
        })
        .collect();

    for e in &tree {
        if e.kind != "blob" {
            continue;
        }
        let Some(rest) = e.path.strip_prefix(&prefix) else {
            continue;
        };
        if let Some(idx) = roots
            .iter()
            .position(|r| rest.len() > r.len() + 1 && rest.starts_with(r) && rest.as_bytes()[r.len()] == b'/')
        {
            let within = &rest[roots[idx].len() + 1..];
            // Same exclusions the local walk applies, or the two signatures
            // could never match for a repo that commits one of those files.
            if crate::skill_watch::is_skipped(within) {
                continue;
            }
            skills[idx].blobs.push((within.to_string(), e.sha.clone()));
        }
    }
    for s in skills.iter_mut() {
        s.blobs.sort();
    }
    skills.sort_by(|a, b| a.key.cmp(&b.key));

    let models = skills
        .iter()
        .map(|s| Skill {
            name: s.name.clone(),
            relative_path: s.relative_path.clone(),
            plugin_name: Some(plugin_name.to_string()),
            marketplace_name: Some(marketplace_name.to_string()),
            remote_present: true,
            ..Default::default()
        })
        .collect();
    RemoteSkills {
        models,
        details: skills,
        known: true,
        head_sha: Some(head_sha),
    }
}

/// The identity a local and a remote skill are matched on: the folder path under
/// the plugin's `skills/` directory, posix, lowercased.
///
/// Matching used to be on [`Skill::name`], which is the frontmatter `name:`
/// locally and the folder basename remotely. Whenever those two differ — a
/// namespaced `name:`, a rename, a case difference — the same skill appeared
/// twice: once as a local copy "missing from the remote", once as a remote-only
/// phantom. Any "is this a local addition?" signal built on that is noise.
pub fn skill_key(relative_path: &str) -> String {
    relative_path
        .replace('\\', "/")
        .trim_start_matches('/')
        .strip_prefix("skills/")
        .unwrap_or(relative_path)
        .trim_matches('/')
        .to_lowercase()
}

pub fn merge_skills(local_skills: Vec<Skill>, remote_skills: Vec<Skill>) -> Vec<Skill> {
    let mut merged = local_skills;
    let mut local_keys: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for (i, s) in merged.iter().enumerate() {
        local_keys.insert(skill_key(&s.relative_path), i);
    }
    for r in remote_skills {
        match local_keys.get(&skill_key(&r.relative_path)) {
            Some(&i) => merged[i].remote_present = true,
            None => merged.push(r),
        }
    }
    merged
}

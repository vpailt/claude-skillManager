//! Fetch a marketplace registry from a GitHub repo and merge with local install
//! state — port of src/marketplace_remote.py.

use crate::error::Result;
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
            // Still installed on this machine → genuine LocalOnly (it's on disk
            // even if the catalogue no longer lists it).
            l.install_state = InstallState::LocalOnly;
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

pub fn fetch_plugin_skills(
    gh: &GitHubClient,
    source: &PluginSource,
    plugin_name: &str,
    marketplace_name: &str,
) -> Result<Vec<Skill>> {
    if source.repo.is_empty() {
        return Ok(Vec::new());
    }
    let entries = match gh.list_dir(&source.repo, "skills", &source.r#ref) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for entry in entries {
        if entry.r#type != "dir" {
            continue;
        }
        let name = entry.path.rsplit('/').next().unwrap_or(&entry.path).to_string();
        out.push(Skill {
            name,
            relative_path: entry.path,
            plugin_name: Some(plugin_name.to_string()),
            marketplace_name: Some(marketplace_name.to_string()),
            remote_present: true,
            ..Default::default()
        });
    }
    Ok(out)
}

pub fn merge_skills(local_skills: Vec<Skill>, remote_skills: Vec<Skill>) -> Vec<Skill> {
    let mut merged = local_skills;
    let names: std::collections::HashSet<String> =
        merged.iter().map(|s| s.name.clone()).collect();
    for r in remote_skills {
        if names.contains(&r.name) {
            for s in merged.iter_mut() {
                if s.name == r.name {
                    s.remote_present = true;
                }
            }
        } else {
            merged.push(r);
        }
    }
    merged
}

//! Fetch a marketplace registry from a GitHub repo and merge with local install
//! state — port of src/marketplace_remote.py.

use crate::error::Result;
use crate::github_client::GitHubClient;
use crate::models::{InstallState, Plugin, PluginSource, Skill};
use crate::registry::parse_marketplace_json;

pub const REGISTRY_PATH: &str = ".claude-plugin/marketplace.json";

pub fn fetch_marketplace_plugins(
    gh: &GitHubClient,
    repo: &str,
    r#ref: &str,
    marketplace_name: &str,
) -> Vec<Plugin> {
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
            Ok((text, _)) => return parse_marketplace_json(&text, marketplace_name),
            Err(e) => last_err = Some(e),
        }
    }
    if let Some(e) = last_err {
        tracing::warn!(
            "fetch_marketplace_plugins: could not read registry for {repo}@{r}: {e}",
            r = r#ref
        );
    }
    Vec::new()
}

pub fn merge_local_remote(
    mut local_plugins: Vec<Plugin>,
    remote_plugins: Vec<Plugin>,
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
        // Plugins the remote fetch didn't return. An installed one is a genuine
        // LocalOnly (we've lost remote knowledge of it). But a plugin we still
        // know from a marketplace registry (`remote_present` — e.g. the local
        // directory scan of an installed marketplace whose remote re-fetch just
        // failed, common for self-hosted Gitea behind a VPN or without a token)
        // is still installable. Keep it NotInstalled so the Install button shows
        // rather than hiding it behind Unknown.
        l.install_state = if l.installed_version.is_some() {
            InstallState::LocalOnly
        } else if l.remote_present {
            InstallState::NotInstalled
        } else {
            InstallState::Unknown
        };
        merged.push(l);
    }
    merged
}

fn compute_state(p: &Plugin) -> InstallState {
    let installed = p.installed_version.as_deref().unwrap_or("");
    if installed.is_empty() {
        return InstallState::NotInstalled;
    }
    let latest = p.latest_version.as_deref().unwrap_or("");
    if latest.is_empty() {
        // The remote registry doesn't pin a version (Anthropic's official
        // marketplace omits `version` on most entries). If we successfully
        // matched against a remote entry, the plugin is fully tracked —
        // LocalOnly is reserved for installs with no remote knowledge at all.
        return if p.remote_present {
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

//! Parse `.claude-plugin/marketplace.json` — port of src/registry.py.

use crate::models::{InstallState, Plugin, PluginSource};
use serde_json::Value;
use std::path::Path;

/// Extract `owner/repo` from a clone/web URL on **any** host (github.com or a
/// self-hosted Gitea instance like `https://git.almaviacx.local`).
///
/// Handles `https://host/owner/repo[.git][/tree/…][?…][#…]` and the SSH form
/// `git@host:owner/repo[.git]`. Takes the first two path segments as
/// owner/repo, which is correct for both forges' web and clone URLs.
pub fn parse_repo_from_url(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    // SSH form: git@host:owner/repo(.git)
    if let Some(rest) = url.strip_prefix("git@") {
        if let Some((_host, path)) = rest.split_once(':') {
            return owner_repo_from_path(path);
        }
    }
    let no_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let no_scheme = no_scheme.strip_prefix("www.").unwrap_or(no_scheme);
    // Drop the host; keep the path.
    let (_host, path) = no_scheme.split_once('/')?;
    owner_repo_from_path(path)
}

fn owner_repo_from_path(path: &str) -> Option<String> {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() < 2 {
        return None;
    }
    let owner = segs[0];
    let repo = segs[1].trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

pub fn parse_marketplace_json(text: &str, marketplace_name: &str) -> Vec<Plugin> {
    let data: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(obj) = data.as_object() else {
        return Vec::new();
    };
    let name = if !marketplace_name.is_empty() {
        marketplace_name.to_string()
    } else {
        obj.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let raw_plugins = obj
        .get("plugins")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in raw_plugins {
        let Some(o) = entry.as_object() else { continue };
        let src = parse_source(o.get("source").cloned().unwrap_or(Value::Null));
        out.push(Plugin {
            name: o
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            marketplace_name: name.clone(),
            latest_version: o
                .get("version")
                .and_then(|v| v.as_str())
                .map(String::from),
            description: o
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            manifest: None,
            source: Some(src),
            install_state: InstallState::NotInstalled,
            remote_present: true,
            ..Default::default()
        });
    }
    out
}

fn parse_source(raw: Value) -> PluginSource {
    if let Some(s) = raw.as_str() {
        return PluginSource {
            kind: "path".to_string(),
            path: s.to_string(),
            ..Default::default()
        };
    }
    let Some(obj) = raw.as_object() else {
        return PluginSource::default();
    };
    let kind = obj
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let url = obj
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut repo = obj
        .get("repo")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let r#ref = obj
        .get("ref")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let path = obj
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if repo.is_empty() && !url.is_empty() {
        if let Some(parsed) = parse_repo_from_url(&url) {
            repo = parsed;
        }
    }
    PluginSource {
        kind,
        repo,
        url,
        r#ref,
        path,
    }
}

/// Back-compat alias. Historically GitHub-only; now resolves owner/repo from
/// any forge host via [`parse_repo_from_url`]. Kept under the old name because
/// admin/command call sites import it.
pub fn parse_github_marketplace_url(url: &str) -> Option<String> {
    parse_repo_from_url(url)
}

pub fn read_git_remote_origin(repo_dir: &Path) -> Option<String> {
    let cfg = repo_dir.join(".git/config");
    let text = std::fs::read_to_string(cfg).ok()?;
    let mut in_origin = false;
    for line in text.lines() {
        let s = line.trim();
        if s.starts_with('[') && s.ends_with(']') {
            in_origin = s == "[remote \"origin\"]";
            continue;
        }
        if in_origin && s.starts_with("url") {
            if let Some((_, v)) = s.split_once('=') {
                let v = v.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

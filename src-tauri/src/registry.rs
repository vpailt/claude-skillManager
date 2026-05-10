//! Parse `.claude-plugin/marketplace.json` — port of src/registry.py.

use crate::models::{InstallState, Plugin, PluginSource};
use regex::Regex;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

fn github_url_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"^(?:https?://(?:www\.)?github\.com/|git@github\.com:|github\.com/)(?P<owner>[^/\s]+)/(?P<repo>[^/\s\.]+?)(?:\.git)?(?:/(?:tree|blob|commits?|releases|pulls?|issues|wiki|actions)(?:/[^\s]*)?)?/?(?:\?[^\s]*)?(?:\#[^\s]*)?$",
        )
        .unwrap()
    })
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
        if let Some(caps) = github_url_re().captures(url.trim()) {
            repo = format!("{}/{}", &caps["owner"], &caps["repo"]);
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

pub fn parse_github_marketplace_url(url: &str) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    github_url_re()
        .captures(url.trim())
        .map(|c| format!("{}/{}", &c["owner"], &c["repo"]))
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

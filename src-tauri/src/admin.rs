//! Admin: upload skills, register/remove/bump plugins via GitHub branch + PR.
//! Port of src/admin.py.

use crate::error::{Error, Result};
use crate::github_client::GitHubClient;
use crate::pr_history::{self, PRRecord};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use walkdir::WalkDir;

pub const REGISTRY_PATH: &str = ".claude-plugin/marketplace.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub content: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub branch: String,
    pub pr_url: String,
    pub pr_number: i64,
}

fn safe_slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
            out.push(c);
        } else {
            out.push('-');
        }
    }
    out.trim_matches('-').to_lowercase()
}

pub fn submit_changes(
    gh: &GitHubClient,
    repo: &str,
    base_branch: &str,
    changes: &[FileChange],
    pr_title: &str,
    pr_body: &str,
    branch_prefix: &str,
    deletions: &[String],
) -> Result<UploadResult> {
    tracing::info!(
        "admin.submit_changes: repo={} base={} prefix={} files={} deletions={} title={:?}",
        repo,
        base_branch,
        branch_prefix,
        changes.len(),
        deletions.len(),
        pr_title
    );
    if changes.is_empty() && deletions.is_empty() {
        tracing::warn!("submit_changes called with no file changes");
        return Err(Error::Invalid("No file changes provided".into()));
    }
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let title_slug: String = safe_slug(pr_title).chars().take(40).collect();
    let new_branch = format!("{branch_prefix}/{title_slug}-{timestamp}");
    gh.create_branch(repo, &new_branch, base_branch)?;
    tracing::info!("created branch {} on {}", new_branch, repo);

    for change in changes {
        let existing = gh.get_file_sha_or_none(repo, &change.path, &new_branch);
        gh.put_file(
            repo,
            &new_branch,
            &change.path,
            &change.content,
            &format!("{pr_title}: update {}", change.path),
            existing.as_deref(),
        )?;
    }

    for path in deletions {
        let sha = match gh.get_file_sha_or_none(repo, path, &new_branch) {
            Some(s) => s,
            None => continue,
        };
        gh.delete_file(
            repo,
            &new_branch,
            path,
            &format!("{pr_title}: delete {path}"),
            &sha,
        )?;
    }

    let pr = gh.open_pull_request(repo, &new_branch, base_branch, pr_title, pr_body)?;
    let result = UploadResult {
        branch: new_branch,
        pr_url: pr
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        pr_number: pr.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
    };

    let _ = pr_history::add(PRRecord {
        repo: repo.to_string(),
        number: result.pr_number,
        title: pr_title.to_string(),
        branch: result.branch.clone(),
        url: result.pr_url.clone(),
        created_at: String::new(),
        status: "open".to_string(),
        kind: branch_prefix.to_string(),
        provider: gh.provider(),
        base_url: gh.base_url(),
    });

    tracing::info!(
        "admin.submit_changes ok: PR #{} {} (branch={})",
        result.pr_number,
        result.pr_url,
        result.branch
    );
    Ok(result)
}

pub fn build_skill_md(name: &str, description: &str, body: &str) -> Vec<u8> {
    let desc = description.replace('\n', " ").trim().to_string();
    let text = format!(
        "---\nname: {name}\ndescription: {desc}\n---\n\n{}\n",
        body.trim_end()
    );
    text.into_bytes()
}

pub fn build_manifest_bump(existing_manifest: &Value, new_version: &str) -> Vec<u8> {
    let mut out = existing_manifest
        .as_object()
        .cloned()
        .unwrap_or_default();
    out.insert("version".to_string(), json!(new_version));
    let mut s = serde_json::to_string_pretty(&Value::Object(out)).unwrap_or_default();
    s.push('\n');
    s.into_bytes()
}

const DEFAULT_MAX_BYTES: u64 = 5_000_000;
const DEFAULT_SKIP: &[&str] = &[".git", "__pycache__", ".DS_Store"];

pub fn collect_skill_folder_changes(
    local_folder: &Path,
    target_subpath: &str,
) -> Result<Vec<FileChange>> {
    if !local_folder.is_dir() {
        return Err(Error::NotFound(format!(
            "Skill folder not found: {}",
            local_folder.display()
        )));
    }
    let target = target_subpath.trim_matches('/');
    let mut out = Vec::new();
    for entry in WalkDir::new(local_folder).sort_by_file_name() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().is_dir() {
            continue;
        }
        let rel = match entry.path().strip_prefix(local_folder) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let parts: Vec<String> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        if parts.is_empty() {
            continue;
        }
        let (last, rest) = parts.split_last().unwrap();
        if rest.iter().any(|p| DEFAULT_SKIP.contains(&p.as_str())) {
            continue;
        }
        if DEFAULT_SKIP.contains(&last.as_str()) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > DEFAULT_MAX_BYTES {
            continue;
        }
        let data = match std::fs::read(entry.path()) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let rel_posix = parts.join("/");
        let path = if target.is_empty() {
            rel_posix
        } else {
            format!("{target}/{rel_posix}")
        };
        out.push(FileChange { path, content: data });
    }
    Ok(out)
}

// ---------- marketplace.json edits ----------

pub fn fetch_marketplace_registry(
    gh: &GitHubClient,
    repo: &str,
    r#ref: &str,
) -> Result<(Value, String, String)> {
    let mut last_err: Option<Error> = None;
    for path in [REGISTRY_PATH, "marketplace.json"] {
        match gh.get_file(repo, path, r#ref) {
            Ok((text, sha)) => {
                let data: Value = serde_json::from_str(&text)
                    .map_err(|e| Error::GitHub(format!("{path} is not valid JSON: {e}")))?;
                if !data.is_object() {
                    return Err(Error::GitHub(format!("{path} root must be an object")));
                }
                return Ok((data, path.to_string(), sha));
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(Error::GitHub(format!(
        "No marketplace.json found in {repo}: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    )))
}

pub fn serialize_registry(data: &Value) -> Vec<u8> {
    let mut s = serde_json::to_string_pretty(data).unwrap_or_default();
    s.push('\n');
    s.into_bytes()
}

pub fn add_plugin_to_registry(
    registry: &Value,
    name: &str,
    version: &str,
    description: &str,
    source: Value,
) -> Result<Value> {
    let mut new_reg = registry.as_object().cloned().unwrap_or_default();
    let mut plugins = new_reg
        .get("plugins")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for entry in &plugins {
        if let Some(o) = entry.as_object() {
            if o.get("name").and_then(|v| v.as_str()).unwrap_or("") == name {
                return Err(Error::Invalid(format!(
                    "Plugin '{name}' already exists in this marketplace."
                )));
            }
        }
    }
    plugins.push(json!({
        "name": name,
        "version": version,
        "description": description,
        "source": source,
    }));
    new_reg.insert("plugins".to_string(), Value::Array(plugins));
    Ok(Value::Object(new_reg))
}

pub fn remove_plugin_from_registry(registry: &Value, name: &str) -> Value {
    let mut new_reg = registry.as_object().cloned().unwrap_or_default();
    let plugins = new_reg
        .get("plugins")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let kept: Vec<Value> = plugins
        .into_iter()
        .filter(|e| {
            e.as_object()
                .and_then(|o| o.get("name").and_then(|v| v.as_str()))
                .unwrap_or("")
                != name
        })
        .collect();
    new_reg.insert("plugins".to_string(), Value::Array(kept));
    Value::Object(new_reg)
}

pub fn update_plugin_in_registry(
    registry: &Value,
    name: &str,
    version: Option<&str>,
    description: Option<&str>,
    source: Option<Value>,
) -> Result<Value> {
    let mut new_reg = registry.as_object().cloned().unwrap_or_default();
    let mut plugins = new_reg
        .get("plugins")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut found = false;
    for entry in plugins.iter_mut() {
        let Some(o) = entry.as_object_mut() else { continue };
        if o.get("name").and_then(|v| v.as_str()).unwrap_or("") != name {
            continue;
        }
        if let Some(v) = version {
            o.insert("version".to_string(), json!(v));
        }
        if let Some(d) = description {
            o.insert("description".to_string(), json!(d));
        }
        if let Some(s) = source {
            o.insert("source".to_string(), s);
        }
        found = true;
        break;
    }
    if !found {
        return Err(Error::Invalid(format!(
            "Plugin '{name}' not found in this marketplace."
        )));
    }
    new_reg.insert("plugins".to_string(), Value::Array(plugins));
    Ok(Value::Object(new_reg))
}

/// Updates only the `source.ref` field of the named plugin's source object,
/// preserving every other key (kind/url/repo/path). Used when bumping a plugin
/// version: the registry's source.ref must follow the new tag, but anything
/// else in the source object should stay untouched.
pub fn bump_plugin_source_ref(registry: &Value, name: &str, new_ref: &str) -> Result<Value> {
    let mut new_reg = registry.as_object().cloned().unwrap_or_default();
    let mut plugins = new_reg
        .get("plugins")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut updated = false;
    for entry in plugins.iter_mut() {
        let Some(o) = entry.as_object_mut() else { continue };
        if o.get("name").and_then(|v| v.as_str()).unwrap_or("") != name {
            continue;
        }
        let mut src_obj = o
            .get("source")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        src_obj.insert("ref".to_string(), json!(new_ref));
        o.insert("source".to_string(), Value::Object(src_obj));
        updated = true;
        break;
    }
    if !updated {
        return Err(Error::Invalid(format!(
            "Plugin '{name}' not found in this marketplace."
        )));
    }
    new_reg.insert("plugins".to_string(), Value::Array(plugins));
    Ok(Value::Object(new_reg))
}

// ---------- helpers ----------

pub fn make_branch_name(prefix: &str, parts: &[&str]) -> String {
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let body: String = parts
        .iter()
        .filter(|p| !p.is_empty())
        .map(|p| safe_slug(p))
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let body: String = body.chars().take(60).collect();
    if body.is_empty() {
        format!("{prefix}/{timestamp}")
    } else {
        format!("{prefix}/{body}-{timestamp}")
    }
}

pub fn validate_marketplace_registry(registry: &Value) -> Vec<String> {
    let mut problems = Vec::new();
    let Some(obj) = registry.as_object() else {
        return vec!["Root must be a JSON object.".into()];
    };
    let plugins = obj.get("plugins");
    match plugins {
        None => {
            problems.push("Missing required key `plugins` (must be a list).".into());
        }
        Some(v) if !v.is_array() => {
            problems.push("`plugins` must be a list.".into());
        }
        Some(v) => {
            let arr = v.as_array().unwrap();
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for (i, entry) in arr.iter().enumerate() {
                let Some(o) = entry.as_object() else {
                    problems.push(format!("plugins[{i}] is not a JSON object."));
                    continue;
                };
                let name = o
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if name.is_empty() {
                    problems.push(format!("plugins[{i}] is missing required `name`."));
                } else if !seen.insert(name.clone()) {
                    problems.push(format!("plugins[{i}] duplicate name `{name}`."));
                }
                let version = o.get("version").and_then(|v| v.as_str()).unwrap_or("").trim();
                if version.is_empty() {
                    problems.push(format!(
                        "plugins[{i}] (`{}`) is missing `version`.",
                        if name.is_empty() { "?" } else { &name }
                    ));
                }
                let src = o.get("source");
                match src {
                    None => problems.push(format!(
                        "plugins[{i}] (`{}`) is missing `source`.",
                        if name.is_empty() { "?" } else { &name }
                    )),
                    Some(Value::Object(s)) => {
                        let has_any = ["repo", "url", "path"]
                            .iter()
                            .any(|k| s.get(*k).and_then(|v| v.as_str()).is_some_and(|v| !v.is_empty()));
                        if !has_any {
                            problems.push(format!(
                                "plugins[{i}] (`{}`) source has no repo/url/path.",
                                if name.is_empty() { "?" } else { &name }
                            ));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    problems
}

pub fn validate_skill_frontmatter(fields: &std::collections::BTreeMap<String, String>) -> Vec<String> {
    let mut problems = Vec::new();
    let name = fields.get("name").map(String::as_str).unwrap_or("").trim();
    if name.is_empty() {
        problems.push("Missing required `name` in SKILL.md frontmatter.".into());
    }
    let desc = fields
        .get("description")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    if desc.is_empty() {
        problems.push("Missing required `description` in SKILL.md frontmatter.".into());
    }
    problems
}

pub fn unified_diff(old: &str, new: &str, path: &str) -> String {
    use similar::TextDiff;
    let label = if path.is_empty() { "file" } else { path };
    let diff = TextDiff::from_lines(old, new);
    let mut out = String::new();
    out.push_str(&diff.unified_diff().header(&format!("a/{label}"), &format!("b/{label}")).to_string());
    out
}

pub fn suggest_semver_bump(old_text: &str, new_text: &str, kind: &str) -> &'static str {
    if old_text == new_text {
        return "patch";
    }
    if kind == "frontmatter" || kind == "manifest" {
        return "minor";
    }
    "patch"
}

pub fn bump_version(version: &str, level: &str) -> String {
    let v = version.trim().trim_start_matches(['v', 'V']);
    let parts: Vec<&str> = v.split('.').collect();
    let mut nums = Vec::new();
    for p in &parts {
        let head = p.split('-').next().unwrap_or("");
        match head.parse::<i64>() {
            Ok(n) => nums.push(n),
            Err(_) => {
                return if v.is_empty() {
                    "0.1.0".into()
                } else {
                    format!("{v}.1")
                }
            }
        }
    }
    while nums.len() < 3 {
        nums.push(0);
    }
    match level {
        "major" => {
            nums[0] += 1;
            nums[1] = 0;
            nums[2] = 0;
        }
        "minor" => {
            nums[1] += 1;
            nums[2] = 0;
        }
        _ => {
            nums[2] += 1;
        }
    }
    format!("{}.{}.{}", nums[0], nums[1], nums[2])
}

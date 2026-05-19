//! "Draft" abstraction for admin PR workflows.
//!
//! Each wizard (add/bump/remove plugin, upload/delete skill) builds an
//! [`AdminDraft`]. The frontend renders the diff/conflicts/validation, and
//! the user clicks "Open PR" → backend calls [`submit_draft`].
//!
//! This collapses what used to be a sprawling Qt dialog into one round-trip
//! per wizard. All GitHub I/O happens inside the prepare/submit functions —
//! React only deals with serializable data.

use crate::admin::{
    add_plugin_to_registry, bump_plugin_source_ref, bump_version, build_manifest_bump,
    collect_skill_folder_changes, fetch_marketplace_registry, make_branch_name,
    remove_plugin_from_registry, serialize_registry, submit_changes, unified_diff,
    update_plugin_in_registry, validate_marketplace_registry, validate_skill_frontmatter,
    FileChange, UploadResult,
};
use crate::config;
use crate::error::{Error, Result};
use crate::frontmatter::{parse_frontmatter, update_frontmatter, Fields};

/// Pulls the skill version from frontmatter, accepting either a top-level
/// `version:` (acx-library style) or a nested `metadata.version:` (afv-library
/// style). Returns "" when neither is present.
fn skill_version_from_fm(fm: &Fields) -> String {
    fm.get("version")
        .or_else(|| fm.get("metadata.version"))
        .cloned()
        .unwrap_or_default()
}

/// The two locations Claude Code looks at for the plugin's own metadata. Older
/// plugins ship `manifest.json` at the root; newer ones use
/// `.claude-plugin/plugin.json`. Some are migrating and have both — keep them
/// in lockstep.
const PLUGIN_MANIFEST_PATHS: &[&str] = &["manifest.json", ".claude-plugin/plugin.json"];

/// One manifest file as fetched from the plugin repo. We hold both the parsed
/// JSON (to rewrite the `version` key) and the raw text (to compute the diff).
struct PluginManifestFile {
    path: String,
    text: String,
    json: Value,
}

/// Fetches whichever of [`PLUGIN_MANIFEST_PATHS`] exist on the target repo and
/// reports the highest declared version. Returning all present files lets the
/// caller stamp the new version into each one so the two locations never drift.
fn fetch_plugin_manifests(
    gh: &GitHubClient,
    repo: &str,
    branch: &str,
) -> (Vec<PluginManifestFile>, String) {
    let mut files: Vec<PluginManifestFile> = Vec::new();
    let mut current_version = String::new();
    for path in PLUGIN_MANIFEST_PATHS {
        let Ok((text, _)) = gh.get_file(repo, path, branch) else {
            continue;
        };
        let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if let Some(v) = json.get("version").and_then(|v| v.as_str()) {
            let v = v.trim();
            if !v.is_empty() && current_version.is_empty() {
                current_version = v.to_string();
            }
        }
        files.push(PluginManifestFile {
            path: (*path).to_string(),
            text,
            json,
        });
    }
    (files, current_version)
}
use crate::github_client::GitHubClient;
use crate::local_scanner;
use crate::pending_prs::{self, PendingPR};
use crate::registry::parse_github_marketplace_url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub path: String,
    /// "add" | "modify" | "delete"
    pub action: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    /// Pre-computed unified diff (so the frontend doesn't have to re-run it).
    pub unified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    pub pr_number: i64,
    pub title: String,
    pub url: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingMeta {
    pub marketplace_name: String,
    pub plugin_name: String,
    /// "add" | "bump" | "remove" | "add-skill" | "update-skill" | "delete-skill"
    pub action: String,
    pub new_version: String,
    pub plugin_source_repo: String,
    #[serde(default)]
    pub skill_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminDraft {
    pub target_repo: String,
    pub base_branch: String,
    pub branch_name: String,
    pub pr_title: String,
    pub pr_body: String,
    pub branch_prefix: String,
    pub changes: Vec<FileChange>,
    pub deletions: Vec<String>,
    pub entries: Vec<DiffEntry>,
    pub problems: Vec<String>,
    pub conflicts: Vec<ConflictEntry>,
    /// Optional flag: backend wants to create a tag on the plugin source repo
    /// before the PR is opened. Frontend asks the user, then calls
    /// [`create_tag_if_missing`].
    #[serde(default)]
    pub needs_tag: Option<NeedsTag>,
    /// Companion draft (used by upload-skill to also bump the marketplace).
    #[serde(default)]
    pub companion: Option<Box<AdminDraft>>,
    /// Filled when the draft results in a pending PR record.
    #[serde(default)]
    pub pending_meta: Option<PendingMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsTag {
    pub repo: String,
    pub tag: String,
}

fn repo_for(marketplace: &str) -> Result<(String, String)> {
    let cfg = config::load_settings()
        .marketplaces
        .into_iter()
        .find(|m| m.name == marketplace);
    let (repo, branch) = match cfg {
        Some(c) => (c.github_repo, c.default_branch),
        None => (String::new(), String::new()),
    };
    // Fallback: marketplaces installed via Claude's `/plugin marketplace add`
    // may not have an entry in SkillManager's app settings, but their GitHub
    // repo is recorded in `~/.claude/plugins/known_marketplaces.json`. Mirror
    // the fallback used by `local_scanner::build_marketplaces_from_settings`
    // so admin commands work for those marketplaces too.
    let repo = if repo.is_empty() {
        local_scanner::load_known_marketplaces()
            .get(marketplace)
            .and_then(|info| info.get("source"))
            .and_then(|src| src.get("repo"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    } else {
        repo
    };
    if repo.is_empty() {
        return Err(Error::Invalid(format!(
            "Marketplace '{marketplace}' has no GitHub repo configured."
        )));
    }
    let branch = if branch.is_empty() {
        "main".to_string()
    } else {
        branch
    };
    Ok((repo, branch))
}

fn diff_entry_modify(path: &str, old: &str, new: &str) -> DiffEntry {
    DiffEntry {
        path: path.to_string(),
        action: "modify".to_string(),
        old_content: Some(old.to_string()),
        new_content: Some(new.to_string()),
        unified: unified_diff(old, new, path),
    }
}

fn diff_entry_add(path: &str, new: &str) -> DiffEntry {
    DiffEntry {
        path: path.to_string(),
        action: "add".to_string(),
        old_content: None,
        new_content: Some(new.to_string()),
        unified: unified_diff("", new, path),
    }
}

fn diff_entry_delete(path: &str, old: &str) -> DiffEntry {
    DiffEntry {
        path: path.to_string(),
        action: "delete".to_string(),
        old_content: Some(old.to_string()),
        new_content: None,
        unified: unified_diff(old, "", path),
    }
}

fn detect_conflicts(
    gh: &GitHubClient,
    repo: &str,
    paths: &[String],
    base: &str,
) -> Vec<ConflictEntry> {
    let prs = gh.list_open_prs_touching(repo, paths, base);
    let mut out = Vec::new();
    for pr in prs {
        out.push(ConflictEntry {
            pr_number: pr.get("number").and_then(|v| v.as_i64()).unwrap_or(0),
            title: pr
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            url: pr
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            paths: paths.to_vec(),
        });
    }
    out
}

// ============================================================
// Add plugin
// ============================================================

pub fn prepare_add_plugin(
    gh: &GitHubClient,
    marketplace: &str,
    source_url: &str,
) -> Result<AdminDraft> {
    let (repo, branch) = repo_for(marketplace)?;
    let plugin_repo = parse_github_marketplace_url(source_url)
        .ok_or_else(|| Error::Invalid(format!("Cannot parse owner/repo from: {source_url}")))?;

    let (manifest_text, _) = gh
        .get_file(&plugin_repo, "manifest.json", "")
        .map_err(|e| Error::GitHub(format!("Could not fetch manifest.json from {plugin_repo}: {e}")))?;
    let manifest: Value = serde_json::from_str(&manifest_text)
        .map_err(|e| Error::GitHub(format!("manifest.json in {plugin_repo} is not valid JSON: {e}")))?;
    let manifest_obj = manifest
        .as_object()
        .ok_or_else(|| Error::GitHub("manifest.json root must be an object".into()))?;

    let name = manifest_obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| {
            plugin_repo
                .rsplit('/')
                .next()
                .unwrap_or("plugin")
                .to_string()
        });
    let version = manifest_obj
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| Error::Invalid(format!("manifest.json in {plugin_repo} has no version.")))?;
    let description = manifest_obj
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let needs_tag = if !gh.ref_exists(&plugin_repo, &version) {
        Some(NeedsTag {
            repo: plugin_repo.clone(),
            tag: version.clone(),
        })
    } else {
        None
    };

    let (registry, registry_path, _) = fetch_marketplace_registry(gh, &repo, &branch)?;
    let source = serde_json::json!({
        "source": "url",
        "url": source_url,
        "repo": plugin_repo,
        "ref": version,
    });
    let new_reg = add_plugin_to_registry(&registry, &name, &version, &description, source)?;
    let problems = validate_marketplace_registry(&new_reg);
    let old_text = serde_json::to_string_pretty(&registry).unwrap_or_default() + "\n";
    let new_text = serde_json::to_string_pretty(&new_reg).unwrap_or_default() + "\n";

    let conflicts = detect_conflicts(gh, &repo, &[registry_path.clone()], &branch);
    let change = FileChange {
        path: registry_path.clone(),
        content: serialize_registry(&new_reg),
    };
    let branch_name = make_branch_name("skillmanager/add-plugin", &[&name]);
    let entries = vec![diff_entry_modify(&registry_path, &old_text, &new_text)];

    Ok(AdminDraft {
        target_repo: repo,
        base_branch: branch,
        branch_name,
        pr_title: format!("Add plugin: {name}"),
        pr_body: format!("Adds plugin `{name}` v{version} to the registry.\n\n{description}"),
        branch_prefix: "skillmanager/add-plugin".to_string(),
        changes: vec![change],
        deletions: Vec::new(),
        entries,
        problems,
        conflicts,
        needs_tag,
        companion: None,
        pending_meta: Some(PendingMeta {
            marketplace_name: marketplace.to_string(),
            plugin_name: name,
            action: "add".to_string(),
            new_version: version,
            plugin_source_repo: plugin_repo,
            skill_name: String::new(),
        }),
    })
}

// ============================================================
// Bump plugin
// ============================================================

pub fn prepare_bump_plugin(
    gh: &GitHubClient,
    marketplace: &str,
    plugin_name: &str,
    new_version: &str,
) -> Result<AdminDraft> {
    let (repo, branch) = repo_for(marketplace)?;
    let new_version = new_version.trim();
    if new_version.is_empty() {
        return Err(Error::Invalid("Empty new version.".into()));
    }
    let (registry, registry_path, _) = fetch_marketplace_registry(gh, &repo, &branch)?;

    // Locate existing source.repo (if any) so we can offer to create a tag.
    let plugin_source_repo = registry
        .get("plugins")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|p| {
                let o = p.as_object()?;
                if o.get("name").and_then(|v| v.as_str())? != plugin_name {
                    return None;
                }
                let src = o.get("source")?;
                src.get("repo").and_then(|v| v.as_str()).map(String::from)
            })
        })
        .unwrap_or_default();

    let needs_tag = if !plugin_source_repo.is_empty()
        && plugin_source_repo != repo
        && !gh.ref_exists(&plugin_source_repo, new_version)
    {
        Some(NeedsTag {
            repo: plugin_source_repo.clone(),
            tag: new_version.to_string(),
        })
    } else {
        None
    };

    // Bump both `version` and `source.ref` so the marketplace points at the
    // freshly-tagged release rather than the previous tag. Skipping the second
    // step (the original bug) leaves Claude clients installing the old zipball
    // even though the registry claims the new version.
    let bumped = update_plugin_in_registry(&registry, plugin_name, Some(new_version), None, None)?;
    let new_reg = bump_plugin_source_ref(&bumped, plugin_name, new_version).unwrap_or(bumped);
    let problems = validate_marketplace_registry(&new_reg);
    let old_text = serde_json::to_string_pretty(&registry).unwrap_or_default() + "\n";
    let new_text = serde_json::to_string_pretty(&new_reg).unwrap_or_default() + "\n";

    let conflicts = detect_conflicts(gh, &repo, &[registry_path.clone()], &branch);
    let change = FileChange {
        path: registry_path.clone(),
        content: serialize_registry(&new_reg),
    };
    let branch_name = make_branch_name("skillmanager/bump-mp", &[plugin_name, new_version]);
    let entries = vec![diff_entry_modify(&registry_path, &old_text, &new_text)];

    Ok(AdminDraft {
        target_repo: repo,
        base_branch: branch,
        branch_name,
        pr_title: format!("Bump {plugin_name} to {new_version}"),
        pr_body: format!("Updates `{plugin_name}` to v`{new_version}` in the registry."),
        branch_prefix: "skillmanager/bump-mp".to_string(),
        changes: vec![change],
        deletions: Vec::new(),
        entries,
        problems,
        conflicts,
        needs_tag,
        companion: None,
        pending_meta: Some(PendingMeta {
            marketplace_name: marketplace.to_string(),
            plugin_name: plugin_name.to_string(),
            action: "bump".to_string(),
            new_version: new_version.to_string(),
            plugin_source_repo,
            skill_name: String::new(),
        }),
    })
}

// ============================================================
// Remove plugin
// ============================================================

pub fn prepare_remove_plugin(
    gh: &GitHubClient,
    marketplace: &str,
    plugin_name: &str,
) -> Result<AdminDraft> {
    let (repo, branch) = repo_for(marketplace)?;
    let (registry, registry_path, _) = fetch_marketplace_registry(gh, &repo, &branch)?;
    let new_reg = remove_plugin_from_registry(&registry, plugin_name);
    let problems = validate_marketplace_registry(&new_reg);
    let old_text = serde_json::to_string_pretty(&registry).unwrap_or_default() + "\n";
    let new_text = serde_json::to_string_pretty(&new_reg).unwrap_or_default() + "\n";

    let conflicts = detect_conflicts(gh, &repo, &[registry_path.clone()], &branch);
    let change = FileChange {
        path: registry_path.clone(),
        content: serialize_registry(&new_reg),
    };
    let branch_name = make_branch_name("skillmanager/remove-plugin", &[plugin_name]);
    let entries = vec![diff_entry_modify(&registry_path, &old_text, &new_text)];

    Ok(AdminDraft {
        target_repo: repo,
        base_branch: branch,
        branch_name,
        pr_title: format!("Remove plugin: {plugin_name}"),
        pr_body: format!("Removes `{plugin_name}` from the registry."),
        branch_prefix: "skillmanager/remove-plugin".to_string(),
        changes: vec![change],
        deletions: Vec::new(),
        entries,
        problems,
        conflicts,
        needs_tag: None,
        companion: None,
        pending_meta: Some(PendingMeta {
            marketplace_name: marketplace.to_string(),
            plugin_name: plugin_name.to_string(),
            action: "remove".to_string(),
            ..Default::default()
        }),
    })
}

// ============================================================
// Upload skill
// ============================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSkillArgs {
    pub marketplace: String,
    pub plugin_name: String,
    pub local_folder: String,
    /// Defaults to the local folder name when empty.
    #[serde(default)]
    pub target_name: String,
    /// Skill version stamped on SKILL.md. Independent from the plugin version
    /// (the plugin always bumps by `plugin_bump_level`).
    #[serde(default)]
    pub new_version: String,
    /// How to bump the plugin's own version (manifest.json +
    /// .claude-plugin/plugin.json). Accepts "patch" (default), "minor", "major".
    #[serde(default)]
    pub plugin_bump_level: String,
    /// Open a companion PR on the marketplace registry that bumps the plugin
    /// version. Only meaningful when the plugin lives in a different repo than
    /// the marketplace.
    #[serde(default)]
    pub also_bump_marketplace: bool,
}

fn plugin_source_repo_of(registry: &Value, plugin_name: &str) -> String {
    registry
        .get("plugins")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|p| {
                let o = p.as_object()?;
                if o.get("name").and_then(|v| v.as_str())? != plugin_name {
                    return None;
                }
                let src = o.get("source")?;
                if let Some(repo) = src.get("repo").and_then(|v| v.as_str()) {
                    if !repo.is_empty() {
                        return Some(repo.to_string());
                    }
                }
                // Fallback: many marketplace.json entries omit `repo` and only
                // ship `url`. Resolve the GitHub URL to owner/repo so we don't
                // miss the plugin's source repo.
                let url = src.get("url").and_then(|v| v.as_str()).unwrap_or("");
                parse_github_marketplace_url(url)
            })
        })
        .unwrap_or_default()
}

pub fn prepare_upload_skill(gh: &GitHubClient, args: &UploadSkillArgs) -> Result<AdminDraft> {
    let local_folder = Path::new(&args.local_folder);
    if !local_folder.is_dir() {
        return Err(Error::NotFound(format!(
            "Local skill folder not found: {}",
            local_folder.display()
        )));
    }
    let target_name = if args.target_name.trim().is_empty() {
        local_folder
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("skill")
            .to_string()
    } else {
        args.target_name.trim().to_string()
    };

    let (mp_repo, mp_branch) = repo_for(&args.marketplace)?;
    let (registry, _registry_path, _) = fetch_marketplace_registry(gh, &mp_repo, &mp_branch)?;
    let plugin_repo = plugin_source_repo_of(&registry, &args.plugin_name);
    let target_repo = if plugin_repo.is_empty() {
        mp_repo.clone()
    } else {
        plugin_repo.clone()
    };

    // For monorepo marketplaces (target_repo == mp_repo) we'd ideally need to
    // know the plugin's subpath inside the marketplace. We only handle the
    // common case (separate plugin repo) cleanly; for monorepos we drop files
    // at the repo root which matches the Python fallback.
    let target_subpath = format!("skills/{target_name}").trim_end_matches('/').to_string();

    let mut changes = collect_skill_folder_changes(local_folder, &target_subpath)?;
    if changes.is_empty() {
        return Err(Error::Invalid("No files in the skill folder.".into()));
    }

    // Locate SKILL.md so we can validate frontmatter + (re-)write version.
    let mut problems: Vec<String> = Vec::new();
    let mut skill_md_idx: Option<usize> = None;
    for (i, ch) in changes.iter().enumerate() {
        let last = ch.path.rsplit('/').next().unwrap_or("");
        if last == "SKILL.md" || last == "skill.md" {
            skill_md_idx = Some(i);
            break;
        }
    }
    let mut skill_existing_version = String::new();
    if let Some(idx) = skill_md_idx {
        let text = String::from_utf8_lossy(&changes[idx].content).to_string();
        let (fm, _) = parse_frontmatter(&text);
        problems.extend(validate_skill_frontmatter(&fm));
        skill_existing_version = skill_version_from_fm(&fm);
    } else {
        problems.push("No SKILL.md found in the local folder.".into());
    }

    // Skill version is stamped on SKILL.md only. Priority:
    //   1. user-supplied newVersion
    //   2. existing skill version in SKILL.md frontmatter
    //   3. "0.1.0" (auto-initialised for brand-new skills)
    let effective_skill_version = if !args.new_version.trim().is_empty() {
        args.new_version.trim().to_string()
    } else if !skill_existing_version.is_empty() {
        skill_existing_version.clone()
    } else {
        "0.1.0".to_string()
    };

    // Always stamp SKILL.md with the effective skill version. Without this,
    // an "add new skill" flow would ship a skill with no version.
    if let Some(idx) = skill_md_idx {
        let text = String::from_utf8_lossy(&changes[idx].content).to_string();
        let mut updates = Fields::new();
        updates.insert("version".to_string(), effective_skill_version.clone());
        let new_text = update_frontmatter(&text, &updates);
        changes[idx] = FileChange {
            path: changes[idx].path.clone(),
            content: new_text.into_bytes(),
        };
    }

    let base_branch = if target_repo == mp_repo {
        mp_branch.clone()
    } else {
        gh.get_default_branch(&target_repo)?
    };

    // Resolve "is this an update" via existence of SKILL.md on the target.
    let skill_md_existing = gh.get_file_sha_or_none(
        &target_repo,
        &format!("{target_subpath}/SKILL.md"),
        &base_branch,
    );
    let is_update = skill_md_existing.is_some();
    let action_word = if is_update { "Update" } else { "Add" };

    // Build per-file diff entries (bounded to 10 + summary tail).
    let mut entries: Vec<DiffEntry> = Vec::new();
    for ch in changes.iter().take(10) {
        let new_text = String::from_utf8_lossy(&ch.content).to_string();
        match gh.get_file(&target_repo, &ch.path, &base_branch) {
            Ok((old_text, _)) => entries.push(diff_entry_modify(&ch.path, &old_text, &new_text)),
            Err(_) => entries.push(diff_entry_add(&ch.path, &new_text)),
        }
    }
    if changes.len() > 10 {
        entries.push(DiffEntry {
            path: format!("... and {} more file(s)", changes.len() - 10),
            action: "modify".to_string(),
            old_content: None,
            new_content: None,
            unified: String::new(),
        });
    }

    // Plugin version is independent from the skill version: any upload bumps
    // the plugin. Otherwise Claude clients keep seeing the same version even
    // though the plugin contents changed. Bump level (patch/minor/major)
    // defaults to "patch" but the user can promote it from the upload dialog.
    let bump_level = match args.plugin_bump_level.trim().to_lowercase().as_str() {
        "major" => "major",
        "minor" => "minor",
        _ => "patch",
    };
    let (manifest_files, current_plugin_version) =
        fetch_plugin_manifests(gh, &target_repo, &base_branch);
    if manifest_files.is_empty() {
        problems.push(
            "No manifest.json or .claude-plugin/plugin.json found on the plugin repo.".into(),
        );
    }
    let current_for_bump = if current_plugin_version.is_empty() {
        "0.0.0".to_string()
    } else {
        current_plugin_version.clone()
    };
    let new_plugin_version = bump_version(&current_for_bump, bump_level);
    for mf in &manifest_files {
        if !mf.json.is_object() {
            problems.push(format!("{} root is not a JSON object.", mf.path));
        }
        let new_bytes = build_manifest_bump(&mf.json, &new_plugin_version);
        let new_text = String::from_utf8_lossy(&new_bytes).to_string();
        entries.push(diff_entry_modify(&mf.path, &mf.text, &new_text));
        changes.push(FileChange {
            path: mf.path.clone(),
            content: new_bytes,
        });
    }

    let conflict_paths: Vec<String> = changes.iter().map(|c| c.path.clone()).collect();
    let conflicts = detect_conflicts(gh, &target_repo, &conflict_paths, &base_branch);
    let branch_prefix = if is_update {
        "skillmanager/update-skill"
    } else {
        "skillmanager/add-skill"
    };
    let branch_name = make_branch_name(
        branch_prefix,
        &[&target_name, &new_plugin_version],
    );
    let pr_title = format!(
        "{action_word} skill: {target_name} (skill v{effective_skill_version}, plugin v{new_plugin_version})"
    );
    let pr_body = format!(
        "{action_word}s skill `{target_name}` (v{effective_skill_version}, {} file(s)) on plugin `{}` from local folder `{}`.\n\nBumps plugin `{}` from v{} to v{} ({} bump).",
        changes.len(),
        args.plugin_name,
        local_folder.display(),
        args.plugin_name,
        if current_plugin_version.is_empty() { "?" } else { &current_plugin_version },
        new_plugin_version,
        bump_level
    );

    // Companion PR bumps the marketplace registry (version + source.ref) to
    // the new plugin version. The registry is useless if it keeps pointing at
    // the previous tag.
    let companion = if args.also_bump_marketplace && target_repo != mp_repo {
        match prepare_bump_plugin(gh, &args.marketplace, &args.plugin_name, &new_plugin_version) {
            Ok(mut d) => {
                d.pr_body = format!(
                    "Companion PR.\n\nUpdates `{}` to v`{}` in the registry (version + source.ref).",
                    args.plugin_name, new_plugin_version
                );
                // The companion's needs_tag triggers a tag-creation step that
                // expects the manifest bump to already be on the plugin
                // repo's default branch. In this flow the manifest bump is in
                // the SAME PR opened by the main draft — submit_draft creates
                // the tag from the main PR's branch SHA. Clearing the
                // companion's needs_tag avoids prompting the user twice.
                d.needs_tag = None;
                Some(Box::new(d))
            }
            Err(e) => {
                problems.push(format!("Companion bump preparation failed: {e}"));
                None
            }
        }
    } else {
        None
    };

    // The main PR introduces the new manifest version on the plugin repo, so
    // the tag must point at the PR branch (not default-branch HEAD). Storing
    // needs_tag here makes submit_draft create the tag automatically once the
    // branch exists.
    let needs_tag = if target_repo != mp_repo && !gh.ref_exists(&target_repo, &new_plugin_version) {
        Some(NeedsTag {
            repo: target_repo.clone(),
            tag: new_plugin_version.clone(),
        })
    } else {
        None
    };

    Ok(AdminDraft {
        target_repo,
        base_branch,
        branch_name,
        pr_title,
        pr_body,
        branch_prefix: branch_prefix.to_string(),
        changes,
        deletions: Vec::new(),
        entries,
        problems,
        conflicts,
        needs_tag,
        companion,
        pending_meta: Some(PendingMeta {
            marketplace_name: args.marketplace.clone(),
            plugin_name: args.plugin_name.clone(),
            action: if is_update {
                "update-skill".to_string()
            } else {
                "add-skill".to_string()
            },
            new_version: new_plugin_version,
            plugin_source_repo: plugin_repo,
            skill_name: target_name.clone(),
        }),
    })
}

// ============================================================
// Delete remote skill
// ============================================================

pub fn prepare_delete_skill(
    gh: &GitHubClient,
    marketplace: &str,
    plugin_name: &str,
    skill_name: &str,
) -> Result<AdminDraft> {
    let (mp_repo, mp_branch) = repo_for(marketplace)?;
    let (registry, _, _) = fetch_marketplace_registry(gh, &mp_repo, &mp_branch)?;
    let plugin_repo = plugin_source_repo_of(&registry, plugin_name);
    let target_repo = if plugin_repo.is_empty() {
        mp_repo.clone()
    } else {
        plugin_repo.clone()
    };
    let base_branch = if target_repo == mp_repo {
        mp_branch.clone()
    } else {
        gh.get_default_branch(&target_repo)?
    };
    let skill_subpath = format!("skills/{skill_name}");

    let files = gh.list_dir_recursive(&target_repo, &skill_subpath, &base_branch)?;
    if files.is_empty() {
        return Err(Error::NotFound(format!(
            "No files under {skill_subpath} on {target_repo}@{base_branch}."
        )));
    }
    let deletions: Vec<String> = files.iter().map(|f| f.path.clone()).collect();

    let mut entries: Vec<DiffEntry> = Vec::new();
    for f in files.iter().take(10) {
        let old_text = gh
            .get_file(&target_repo, &f.path, &base_branch)
            .map(|(t, _)| t)
            .unwrap_or_default();
        entries.push(diff_entry_delete(&f.path, &old_text));
    }
    if files.len() > 10 {
        entries.push(DiffEntry {
            path: format!("... and {} more file(s)", files.len() - 10),
            action: "delete".to_string(),
            old_content: None,
            new_content: None,
            unified: String::new(),
        });
    }

    // Fetch every plugin-manifest file present (manifest.json and/or
    // .claude-plugin/plugin.json) and bump them in lockstep. A deletion shifts
    // plugin contents, so the version must move; otherwise Claude clients
    // won't pull the change.
    let mut problems: Vec<String> = Vec::new();
    let mut changes: Vec<FileChange> = Vec::new();
    let (manifest_files, current_plugin_version) =
        fetch_plugin_manifests(gh, &target_repo, &base_branch);
    if manifest_files.is_empty() {
        problems.push(
            "No manifest.json or .claude-plugin/plugin.json found on the plugin repo.".into(),
        );
    }
    let current_for_bump = if current_plugin_version.is_empty() {
        "0.0.0".to_string()
    } else {
        current_plugin_version.clone()
    };
    let new_version = bump_version(&current_for_bump, "patch");
    for mf in &manifest_files {
        if !mf.json.is_object() {
            problems.push(format!("{} root is not a JSON object.", mf.path));
        }
        let new_bytes = build_manifest_bump(&mf.json, &new_version);
        let new_text = String::from_utf8_lossy(&new_bytes).to_string();
        entries.push(diff_entry_modify(&mf.path, &mf.text, &new_text));
        changes.push(FileChange {
            path: mf.path.clone(),
            content: new_bytes,
        });
    }

    let mut conflict_paths: Vec<String> = deletions.clone();
    for mf in &manifest_files {
        conflict_paths.push(mf.path.clone());
    }
    let conflicts = detect_conflicts(gh, &target_repo, &conflict_paths, &base_branch);
    let branch_name = make_branch_name("skillmanager/delete-skill", &[skill_name, &new_version]);

    // Companion PR keeps the marketplace registry in sync (version + source.ref).
    let companion = if !new_version.is_empty() && target_repo != mp_repo {
        match prepare_bump_plugin(gh, marketplace, plugin_name, &new_version) {
            Ok(mut d) => {
                d.pr_body = format!(
                    "Companion PR.\n\nUpdates `{}` to v`{}` in the registry after removing skill `{}`.",
                    plugin_name, new_version, skill_name
                );
                d.needs_tag = None;
                Some(Box::new(d))
            }
            Err(e) => {
                problems.push(format!("Companion bump preparation failed: {e}"));
                None
            }
        }
    } else {
        None
    };

    let needs_tag = if !new_version.is_empty()
        && target_repo != mp_repo
        && !gh.ref_exists(&target_repo, &new_version)
    {
        Some(NeedsTag {
            repo: target_repo.clone(),
            tag: new_version.clone(),
        })
    } else {
        None
    };

    Ok(AdminDraft {
        target_repo,
        base_branch,
        branch_name,
        pr_title: format!("Delete skill: {skill_name} (v{new_version})"),
        pr_body: format!(
            "Removes skill `{skill_name}` ({} file(s)) from plugin `{plugin_name}` and bumps the plugin to v{}.",
            deletions.len(),
            new_version
        ),
        branch_prefix: "skillmanager/delete-skill".to_string(),
        changes,
        deletions,
        entries,
        problems,
        conflicts,
        needs_tag,
        companion,
        pending_meta: Some(PendingMeta {
            marketplace_name: marketplace.to_string(),
            plugin_name: plugin_name.to_string(),
            action: "delete-skill".to_string(),
            new_version,
            plugin_source_repo: plugin_repo,
            skill_name: skill_name.to_string(),
        }),
    })
}

// ============================================================
// Submit
// ============================================================

pub fn submit_draft(gh: &GitHubClient, draft: &AdminDraft) -> Result<UploadResult> {
    let result = submit_changes(
        gh,
        &draft.target_repo,
        &draft.base_branch,
        &draft.changes,
        &draft.pr_title,
        &draft.pr_body,
        &draft.branch_prefix,
        &draft.deletions,
    )?;
    if let Some(meta) = &draft.pending_meta {
        let _ = pending_prs::upsert(PendingPR {
            marketplace_name: meta.marketplace_name.clone(),
            plugin_name: meta.plugin_name.clone(),
            action: meta.action.clone(),
            pr_url: result.pr_url.clone(),
            pr_number: result.pr_number,
            branch: result.branch.clone(),
            target_repo: draft.target_repo.clone(),
            new_version: meta.new_version.clone(),
            plugin_source_repo: meta.plugin_source_repo.clone(),
            skill_name: meta.skill_name.clone(),
            ..Default::default()
        });
    }
    // When the draft introduces a new version on the same repo it tags (upload
    // skill / delete skill), the tag must point at the PR branch — default
    // branch HEAD doesn't yet contain the manifest bump. We do it here so the
    // user gets one click ("Open PR") instead of a separate tagging step that
    // would race the merge.
    if let Some(nt) = &draft.needs_tag {
        if nt.repo == draft.target_repo {
            match gh.get_branch_sha(&draft.target_repo, &result.branch) {
                Ok(sha) => {
                    if let Err(e) = gh.create_tag(&draft.target_repo, &nt.tag, &sha) {
                        tracing::warn!(
                            "auto-create tag {} on {} failed: {}",
                            nt.tag,
                            draft.target_repo,
                            e
                        );
                    } else {
                        tracing::info!(
                            "auto-created tag {} on {}@{}",
                            nt.tag,
                            draft.target_repo,
                            sha
                        );
                    }
                }
                Err(e) => tracing::warn!(
                    "could not resolve branch SHA for tag creation on {}/{}: {}",
                    draft.target_repo,
                    result.branch,
                    e
                ),
            }
        }
    }
    Ok(result)
}

// ============================================================
// Tag creation helper
// ============================================================

pub fn create_tag_if_missing(gh: &GitHubClient, repo: &str, tag: &str) -> Result<String> {
    if gh.ref_exists(repo, tag) {
        return Ok(format!("Tag `{tag}` already exists on {repo}."));
    }
    let default_branch = gh.get_default_branch(repo)?;
    let head_sha = gh.get_branch_sha(repo, &default_branch)?;
    gh.create_tag(repo, tag, &head_sha)?;
    Ok(format!("Tag `{tag}` created on {repo}@{head_sha}."))
}

// ============================================================
// Utility surfaces for the React UI
// ============================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkill {
    pub name: String,
    pub folder: String,
    pub description: String,
    pub version: String,
}

pub fn list_user_skills() -> Vec<LocalSkill> {
    let mut out = Vec::new();
    for s in local_scanner::scan_user_skills() {
        let mut version = String::new();
        let skill_md = s.folder.join("SKILL.md");
        let alt_md = s.folder.join("skill.md");
        let target = if skill_md.exists() {
            skill_md
        } else if alt_md.exists() {
            alt_md
        } else {
            s.folder.clone()
        };
        if let Ok(text) = std::fs::read_to_string(&target) {
            let (fm, _) = parse_frontmatter(&text);
            version = skill_version_from_fm(&fm);
        }
        out.push(LocalSkill {
            name: s.name,
            folder: s.folder.to_string_lossy().into(),
            description: s.description,
            version,
        });
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillInfo {
    pub name: String,
    pub version: String,
    pub local_match: Option<LocalSkill>,
}

/// Lists `skills/*/` directories in the plugin's source repo and pairs each
/// with the matching local skill folder if any (used by the React skills tab
/// to surface "upgrade this skill" affordances).
pub fn list_remote_skills(
    gh: &GitHubClient,
    marketplace: &str,
    plugin_name: &str,
) -> Result<Vec<RemoteSkillInfo>> {
    let (mp_repo, mp_branch) = repo_for(marketplace)?;
    let (registry, _, _) = fetch_marketplace_registry(gh, &mp_repo, &mp_branch)?;
    let plugin_repo = plugin_source_repo_of(&registry, plugin_name);
    if plugin_repo.is_empty() {
        return Ok(Vec::new());
    }
    let plugin_ref = registry
        .get("plugins")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|p| {
                let o = p.as_object()?;
                if o.get("name").and_then(|v| v.as_str())? != plugin_name {
                    return None;
                }
                let src = o.get("source")?;
                src.get("ref").and_then(|v| v.as_str()).map(String::from)
            })
        })
        .unwrap_or_default();

    let entries = match gh.list_dir(&plugin_repo, "skills", &plugin_ref) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let local_index: std::collections::HashMap<String, LocalSkill> =
        list_user_skills().into_iter().map(|s| (s.name.clone(), s)).collect();
    let mut out = Vec::new();
    for e in entries {
        if e.r#type != "dir" {
            continue;
        }
        let name = e.path.rsplit('/').next().unwrap_or("").to_string();
        let mut version = String::new();
        if let Ok((text, _)) = gh.get_file(&plugin_repo, &format!("{}/SKILL.md", e.path), &plugin_ref)
        {
            let (fm, _) = parse_frontmatter(&text);
            version = skill_version_from_fm(&fm);
        }
        let local_match = local_index.get(&name).cloned();
        out.push(RemoteSkillInfo {
            name,
            version,
            local_match,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BumpSuggestion {
    pub patch: String,
    pub minor: String,
    pub major: String,
}

pub fn suggest_bumps(version: &str) -> BumpSuggestion {
    let base = if version.is_empty() { "0.0.0" } else { version };
    BumpSuggestion {
        patch: bump_version(base, "patch"),
        minor: bump_version(base, "minor"),
        major: bump_version(base, "major"),
    }
}


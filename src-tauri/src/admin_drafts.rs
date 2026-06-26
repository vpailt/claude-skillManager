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
    add_plugin_to_registry, bump_marketplace_version, bump_version, build_manifest_bump,
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

/// Normalization key for matching a skill across the remote repo (folder
/// basename) and the local install (frontmatter `name:`): trim + lowercase.
/// Bridges case/whitespace differences and folder-vs-`name:` divergence.
fn norm_key(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Coerce a free-form bump level to one of "patch" | "minor" | "major",
/// defaulting to "patch". The shared level chosen in the wizard drives the
/// skill, plugin and marketplace version bumps alike.
fn normalize_bump_level(level: &str) -> &'static str {
    match level.trim().to_lowercase().as_str() {
        "major" => "major",
        "minor" => "minor",
        _ => "patch",
    }
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
    /// Skill's own SKILL.md version (add-skill / update-skill). Distinct from
    /// `new_version`, which is the plugin's bumped manifest version.
    #[serde(default)]
    pub skill_version: String,
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
    /// Tags/releases to create when the PR is opened. A single action can spawn
    /// several (e.g. adding a plugin tags both the plugin repo and the
    /// marketplace repo). All are created automatically by [`submit_draft`].
    #[serde(default)]
    pub tags: Vec<TagSpec>,
    /// Companion draft (used by upload-skill to also bump the marketplace).
    #[serde(default)]
    pub companion: Option<Box<AdminDraft>>,
    /// Filled when the draft results in a pending PR record.
    #[serde(default)]
    pub pending_meta: Option<PendingMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSpec {
    pub repo: String,
    pub tag: String,
    /// Free-text release notes shown on the tag/release. Empty → a default
    /// "auto-created by SkillManager" body is used.
    #[serde(default)]
    pub description: String,
    /// When the tag lives on the same repo the PR targets, it is cut from the
    /// PR branch SHA (which already carries the version bump). Otherwise it is
    /// cut from that repo's default-branch HEAD.
    #[serde(default)]
    pub from_pr_branch: bool,
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
    bump_level: &str,
    version_description: &str,
) -> Result<AdminDraft> {
    let bump_level = normalize_bump_level(bump_level);
    let version_description = version_description.trim();
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

    // "main always published" model: the registry entry tracks the plugin repo's
    // default branch, not the freshly-tagged version. The plugin tag is still
    // created (release marker) but the registry never re-pins to it, so the app
    // can detect future releases by reading the manifest on this ref.
    let plugin_branch = gh
        .get_default_branch(&plugin_repo)
        .unwrap_or_else(|_| "main".into());
    let (registry, registry_path, _) = fetch_marketplace_registry(gh, &repo, &branch)?;
    let source = serde_json::json!({
        "source": "url",
        "url": source_url,
        "repo": plugin_repo,
        "ref": plugin_branch,
    });
    let with_plugin = add_plugin_to_registry(&registry, &name, &description, source)?;
    // Adding a plugin is a catalogue change → bump the marketplace's own version
    // so the change is a taggable marketplace release (req. #5). Same PR.
    let (new_reg, mp_version) = bump_marketplace_version(&with_plugin, bump_level);
    let problems = validate_marketplace_registry(&new_reg);
    let old_text = serde_json::to_string_pretty(&registry).unwrap_or_default() + "\n";
    let new_text = serde_json::to_string_pretty(&new_reg).unwrap_or_default() + "\n";

    let conflicts = detect_conflicts(gh, &repo, &[registry_path.clone()], &branch);
    let change = FileChange {
        path: registry_path.clone(),
        content: serialize_registry(&new_reg),
    };
    let branch_name = make_branch_name("skillmanager/add-plugin", &[&name, &mp_version]);
    let entries = vec![diff_entry_modify(&registry_path, &old_text, &new_text)];

    // Two tags: the plugin repo at its manifest version (cut from its default
    // branch, which already carries that manifest) and the marketplace repo at
    // its freshly-bumped version (cut from this PR's branch, which carries the
    // registry change). Both share the user-supplied release notes.
    let mut tags: Vec<TagSpec> = Vec::new();
    if !gh.ref_exists(&plugin_repo, &version) {
        tags.push(TagSpec {
            repo: plugin_repo.clone(),
            tag: version.clone(),
            description: version_description.to_string(),
            from_pr_branch: false,
        });
    }
    if !gh.ref_exists(&repo, &mp_version) {
        tags.push(TagSpec {
            repo: repo.clone(),
            tag: mp_version.clone(),
            description: version_description.to_string(),
            from_pr_branch: true,
        });
    }

    let mut pr_body = format!(
        "Adds plugin `{name}` v{version} to the registry and bumps the marketplace to v{mp_version} ({bump_level} bump)."
    );
    if !description.trim().is_empty() {
        pr_body.push_str(&format!("\n\n{}", description.trim()));
    }
    if !version_description.is_empty() {
        pr_body.push_str(&format!("\n\n---\n{version_description}"));
    }

    Ok(AdminDraft {
        target_repo: repo,
        base_branch: branch,
        branch_name,
        pr_title: format!("Add plugin: {name} (marketplace v{mp_version})"),
        pr_body,
        branch_prefix: "skillmanager/add-plugin".to_string(),
        changes: vec![change],
        deletions: Vec::new(),
        entries,
        problems,
        conflicts,
        tags,
        companion: None,
        pending_meta: Some(PendingMeta {
            marketplace_name: marketplace.to_string(),
            plugin_name: name,
            action: "add".to_string(),
            new_version: version,
            plugin_source_repo: plugin_repo,
            skill_name: String::new(),
            skill_version: String::new(),
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
    version_description: &str,
) -> Result<AdminDraft> {
    let (repo, branch) = repo_for(marketplace)?;
    let new_version = new_version.trim();
    let version_description = version_description.trim();
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

    let mut tags: Vec<TagSpec> = Vec::new();
    if !plugin_source_repo.is_empty()
        && plugin_source_repo != repo
        && !gh.ref_exists(&plugin_source_repo, new_version)
    {
        tags.push(TagSpec {
            repo: plugin_source_repo.clone(),
            tag: new_version.to_string(),
            description: version_description.to_string(),
            from_pr_branch: false,
        });
    }

    // "main always published" model: only the informational `version` moves;
    // `source.ref` is deliberately left pointing at the tracked branch (main).
    // Re-pinning it to the tag would freeze the app's manifest-based detection
    // so it could never see a later release. The branch already holds the new,
    // tagged contents, so clients still install the latest zipball.
    let new_reg = update_plugin_in_registry(&registry, plugin_name, Some(new_version), None, None)?;
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

    let mut pr_body = format!("Updates `{plugin_name}` to v`{new_version}` in the registry.");
    if !version_description.is_empty() {
        pr_body.push_str(&format!("\n\n---\n{version_description}"));
    }

    Ok(AdminDraft {
        target_repo: repo,
        base_branch: branch,
        branch_name,
        pr_title: format!("Bump {plugin_name} to {new_version}"),
        pr_body,
        branch_prefix: "skillmanager/bump-mp".to_string(),
        changes: vec![change],
        deletions: Vec::new(),
        entries,
        problems,
        conflicts,
        tags,
        companion: None,
        pending_meta: Some(PendingMeta {
            marketplace_name: marketplace.to_string(),
            plugin_name: plugin_name.to_string(),
            action: "bump".to_string(),
            new_version: new_version.to_string(),
            plugin_source_repo,
            skill_name: String::new(),
            skill_version: String::new(),
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
        tags: Vec::new(),
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
    /// Skill version stamped on SKILL.md. When empty the backend derives it
    /// from `bump_level` (bump the existing version on update, else "0.1.0").
    /// The wizard pre-fills it, so it normally arrives non-empty.
    #[serde(default)]
    pub new_version: String,
    /// Shared bump level (patch/minor/major) — drives BOTH the plugin's own
    /// version (manifest.json + .claude-plugin/plugin.json) and the pre-filled
    /// skill version. Defaults to "patch".
    #[serde(default)]
    pub bump_level: String,
    /// Free-text release notes for the tag/release and PR body created by this
    /// upload.
    #[serde(default)]
    pub version_description: String,
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

/// The plugin entry's raw `source.url` from the marketplace registry, if any.
/// Used to pick the right forge client: a Gitea marketplace can list a
/// GitHub-hosted plugin (and vice-versa), so the plugin's own host — not the
/// marketplace's — decides which client reads its repo.
fn plugin_source_url_of(registry: &Value, plugin_name: &str) -> String {
    registry
        .get("plugins")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|p| {
                let o = p.as_object()?;
                if o.get("name").and_then(|v| v.as_str())? != plugin_name {
                    return None;
                }
                o.get("source")
                    .and_then(|s| s.get("url"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
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

    let bump_level = normalize_bump_level(&args.bump_level);

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

    // Skill version stamped on SKILL.md. Priority:
    //   1. user-supplied newVersion (the wizard pre-fills the incremented value)
    //   2. on an update with a known current version → bump it by `bump_level`,
    //      so the skill version always moves on an upgrade (req. #2)
    //   3. an existing version with no bump context → keep as-is
    //   4. "0.1.0" for a brand-new skill
    let effective_skill_version = if !args.new_version.trim().is_empty() {
        args.new_version.trim().to_string()
    } else if is_update && !skill_existing_version.is_empty() {
        bump_version(&skill_existing_version, bump_level)
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

    // The plugin version always bumps on any upload — otherwise Claude clients
    // keep seeing the same version though the contents changed. It bumps by the
    // same shared `bump_level` as the skill version (req. #3).
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
    let version_description = args.version_description.trim();
    let mut pr_body = format!(
        "{action_word}s skill `{target_name}` (v{effective_skill_version}, {} file(s)) on plugin `{}` from local folder `{}`.\n\nBumps plugin `{}` from v{} to v{} ({} bump).",
        changes.len(),
        args.plugin_name,
        local_folder.display(),
        args.plugin_name,
        if current_plugin_version.is_empty() { "?" } else { &current_plugin_version },
        new_plugin_version,
        bump_level
    );
    if !version_description.is_empty() {
        pr_body.push_str(&format!("\n\n---\n{version_description}"));
    }

    // No companion registry PR: the registry no longer carries per-plugin
    // versions, so a skill upload only bumps the plugin's own manifest + tag.
    let companion: Option<Box<AdminDraft>> = None;

    // The main PR introduces the new manifest version on the plugin repo, so
    // the tag must point at the PR branch (not default-branch HEAD). Storing it
    // in `tags` makes submit_draft create the tag automatically once the branch
    // exists. (When the plugin lives in the marketplace repo there's nothing to
    // tag separately.)
    let mut tags: Vec<TagSpec> = Vec::new();
    if target_repo != mp_repo && !gh.ref_exists(&target_repo, &new_plugin_version) {
        tags.push(TagSpec {
            repo: target_repo.clone(),
            tag: new_plugin_version.clone(),
            description: version_description.to_string(),
            from_pr_branch: true,
        });
    }

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
        tags,
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
            skill_version: effective_skill_version.clone(),
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

    // "main always published" model: a skill deletion is a plugin content change,
    // not a registry add/remove, so we no longer open a companion registry PR.
    // The manifest bump + tag on the plugin repo (main) is enough; the app reads
    // the live manifest version at refresh. Avoids per-edit registry noise.
    let companion: Option<Box<AdminDraft>> = None;

    let mut tags: Vec<TagSpec> = Vec::new();
    if !new_version.is_empty()
        && target_repo != mp_repo
        && !gh.ref_exists(&target_repo, &new_version)
    {
        tags.push(TagSpec {
            repo: target_repo.clone(),
            tag: new_version.clone(),
            description: String::new(),
            from_pr_branch: true,
        });
    }

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
        tags,
        companion,
        pending_meta: Some(PendingMeta {
            marketplace_name: marketplace.to_string(),
            plugin_name: plugin_name.to_string(),
            action: "delete-skill".to_string(),
            new_version,
            plugin_source_repo: plugin_repo,
            skill_name: skill_name.to_string(),
            skill_version: String::new(),
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
            skill_version: meta.skill_version.clone(),
            ..Default::default()
        });
    }
    // Create every requested tag/release. All are best-effort: a forge-side
    // failure (permissions, race) is logged but never blocks the PR — the user
    // still gets a one-click "Open PR" instead of a separate tagging step.
    let plugin = draft
        .pending_meta
        .as_ref()
        .map(|m| m.plugin_name.as_str())
        .unwrap_or("");
    for tag in &draft.tags {
        create_one_tag(gh, tag, plugin, &draft.target_repo, &result);
    }
    Ok(result)
}

/// Resolve the commit a [`TagSpec`] should point at, then create the tag and a
/// best-effort release. `from_pr_branch` tags are cut from the just-opened PR
/// branch (which carries the version bump); others from their repo's default
/// branch HEAD.
fn create_one_tag(
    gh: &GitHubClient,
    tag: &TagSpec,
    plugin: &str,
    target_repo: &str,
    result: &UploadResult,
) {
    if gh.ref_exists(&tag.repo, &tag.tag) {
        tracing::debug!("tag {} already exists on {}, skipping", tag.tag, tag.repo);
        return;
    }
    let sha = if tag.from_pr_branch && tag.repo == target_repo {
        gh.get_branch_sha(&tag.repo, &result.branch)
    } else {
        gh.get_default_branch(&tag.repo)
            .and_then(|b| gh.get_branch_sha(&tag.repo, &b))
    };
    let sha = match sha {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                "could not resolve SHA for tag {} on {}: {}",
                tag.tag,
                tag.repo,
                e
            );
            return;
        }
    };
    if let Err(e) = gh.create_tag(&tag.repo, &tag.tag, &sha) {
        tracing::warn!("auto-create tag {} on {} failed: {}", tag.tag, tag.repo, e);
        return;
    }
    tracing::info!("auto-created tag {} on {}@{}", tag.tag, tag.repo, sha);

    let release_name = if plugin.is_empty() {
        format!("v{}", tag.tag)
    } else {
        format!("{plugin} v{}", tag.tag)
    };
    // User-supplied release notes when present; otherwise a provenance footer.
    let release_body = if tag.description.trim().is_empty() {
        format!(
            "Auto-created by SkillManager from PR [{}]({}).",
            result.pr_number, result.pr_url
        )
    } else {
        format!(
            "{}\n\n---\nAuto-created by SkillManager from PR [{}]({}).",
            tag.description.trim(),
            result.pr_number,
            result.pr_url
        )
    };
    match gh.create_release(&tag.repo, &tag.tag, &release_name, &release_body) {
        Ok(_) => tracing::info!("auto-created release {} on {}", tag.tag, tag.repo),
        Err(e) => tracing::warn!(
            "auto-create release {} on {} failed: {}",
            tag.tag,
            tag.repo,
            e
        ),
    }
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
    let mut msg = format!("Tag `{tag}` created on {repo}@{head_sha}.");
    // Release is best-effort; surface a hint in the message but never fail.
    match gh.create_release(
        repo,
        tag,
        &format!("v{tag}"),
        "Auto-created by SkillManager.",
    ) {
        Ok(_) => {
            msg.push_str(" Release published.");
            tracing::info!("auto-created release {tag} on {repo}");
        }
        Err(e) => {
            msg.push_str(&format!(" Release creation failed: {e}"));
            tracing::warn!("auto-create release {tag} on {repo} failed: {e}");
        }
    }
    Ok(msg)
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

/// A plugin's source `(owner/repo, url)` read from the marketplace registry
/// that's **already installed locally** (under
/// `~/.claude/plugins/marketplaces/<name>/.claude-plugin/marketplace.json`).
/// Lets us resolve the plugin's own repo without hitting the marketplace's
/// remote — which matters when that repo is private/internal and no token is
/// set, yet the plugin's own repo is public.
fn local_plugin_source(marketplace: &str, plugin_name: &str) -> Option<(String, String)> {
    let known = local_scanner::load_known_marketplaces();
    let install_location = known
        .get(marketplace)
        .and_then(|info| info.get("installLocation"))
        .and_then(|v| v.as_str())?;
    let plugins =
        local_scanner::scan_directory_marketplace(Path::new(install_location), marketplace);
    let src = plugins
        .into_iter()
        .find(|p| p.name == plugin_name)?
        .source?;
    if src.repo.is_empty() && src.url.is_empty() {
        return None;
    }
    Some((src.repo, src.url))
}

/// Resolve a plugin's source `(owner/repo, url)` from its marketplace registry.
/// `gh` targets the marketplace's own repo (where the registry lives). Callers
/// then use the returned url to pick the forge client for the *plugin* repo,
/// which may live on a different host than its marketplace.
///
/// Prefers the live remote registry, but falls back to the locally-installed
/// copy when the remote can't be read (e.g. an "internal" Gitea marketplace
/// repo with no token configured) — the plugin's own repo is often public even
/// when its marketplace index isn't.
pub fn resolve_plugin_source(
    gh: &GitHubClient,
    marketplace: &str,
    plugin_name: &str,
) -> Result<(String, String)> {
    if let Ok((mp_repo, mp_branch)) = repo_for(marketplace) {
        match fetch_marketplace_registry(gh, &mp_repo, &mp_branch) {
            Ok((registry, _, _)) => {
                return Ok((
                    plugin_source_repo_of(&registry, plugin_name),
                    plugin_source_url_of(&registry, plugin_name),
                ));
            }
            Err(e) => {
                if let Some(local) = local_plugin_source(marketplace, plugin_name) {
                    tracing::warn!(
                        "resolve_plugin_source: remote registry for {} unreadable ({}); \
                         using locally-installed marketplace.json",
                        marketplace,
                        e
                    );
                    return Ok(local);
                }
                return Err(e);
            }
        }
    }
    local_plugin_source(marketplace, plugin_name).ok_or_else(|| {
        Error::Invalid(format!(
            "Marketplace '{marketplace}' has no readable registry (remote or local)."
        ))
    })
}

/// Lists `skills/*/` directories in a plugin's source repo and pairs each with
/// the matching local skill folder if any (used by the React skills tab to
/// surface "upgrade this skill" affordances).
///
/// `gh` must already target the plugin's own forge (see [`resolve_plugin_source`]).
/// Reads from the plugin repo's default branch (not the marketplace registry's
/// `source.ref`) so that admins see the live state right after a merge —
/// otherwise a deletion stays "visible" until both the plugin tag and the
/// marketplace bump propagate.
pub fn list_skills_in_repo(
    gh: &GitHubClient,
    plugin_repo: &str,
) -> Result<Vec<RemoteSkillInfo>> {
    if plugin_repo.is_empty() {
        return Ok(Vec::new());
    }
    let plugin_ref = gh
        .get_default_branch(plugin_repo)
        .unwrap_or_else(|_| "main".to_string());

    let entries = match gh.list_dir(plugin_repo, "skills", &plugin_ref) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    // Index local skills by BOTH their declared frontmatter `name:` and their
    // folder basename, normalized (trim + lowercase), so a remote skill pairs
    // with its local copy even when those two differ in case/whitespace or
    // outright (e.g. a namespaced `name:`). Insert the `name:` key last so it
    // wins on collision.
    let mut local_index: std::collections::HashMap<String, LocalSkill> =
        std::collections::HashMap::new();
    for s in list_user_skills() {
        let basename = std::path::Path::new(&s.folder)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if !basename.trim().is_empty() {
            local_index
                .entry(norm_key(&basename))
                .or_insert_with(|| s.clone());
        }
        local_index.insert(norm_key(&s.name), s);
    }

    let mut out = Vec::new();
    for e in entries {
        if e.r#type != "dir" {
            continue;
        }
        // Folder basename stays the skill's identity for display + upload/delete
        // operations (the repo path), regardless of how matching resolves.
        let name = e.path.rsplit('/').next().unwrap_or("").to_string();
        let mut version = String::new();
        let mut fm_name = String::new();
        // Accept either SKILL.md or skill.md — mirrors the local scanner, which
        // already falls back. Without this a lowercase skill.md showed an empty
        // remote version next to a populated local one (a phantom mismatch).
        for fname in ["SKILL.md", "skill.md"] {
            if let Ok((text, _)) =
                gh.get_file(plugin_repo, &format!("{}/{}", e.path, fname), &plugin_ref)
            {
                let (fm, _) = parse_frontmatter(&text);
                version = skill_version_from_fm(&fm);
                fm_name = fm.get("name").cloned().unwrap_or_default();
                break;
            }
        }
        // Match by folder basename first, then by the skill's declared name.
        let local_match = local_index
            .get(&norm_key(&name))
            .or_else(|| {
                if fm_name.trim().is_empty() {
                    None
                } else {
                    local_index.get(&norm_key(&fm_name))
                }
            })
            .cloned();
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


//! Scans the local Claude install for marketplaces, plugins and skills —
//! port of src/local_scanner.py.

use crate::config::{self, MarketplaceConfig};
use crate::frontmatter::{parse_frontmatter, Fields};
use crate::models::{InstallState, Marketplace, Plugin, Skill, UserSkill};
use crate::plugin_state;
use crate::registry::parse_marketplace_json;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const LOCAL_MARKETPLACE_NAME: &str = "(local skills)";

fn read_json(path: &Path) -> Value {
    if !path.exists() {
        return Value::Null;
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

pub fn load_known_marketplaces() -> serde_json::Map<String, Value> {
    read_json(&config::known_marketplaces_file())
        .as_object()
        .cloned()
        .unwrap_or_default()
}

pub fn load_installed_plugins() -> serde_json::Map<String, Value> {
    read_json(&config::installed_plugins_file())
        .get("plugins")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

fn scan_skill_folder(
    folder: &Path,
    plugin_folder: &Path,
    plugin_name: &str,
    marketplace_name: &str,
) -> Option<Skill> {
    let mut skill_md = folder.join("SKILL.md");
    if !skill_md.exists() {
        skill_md = folder.join("skill.md");
        if !skill_md.exists() {
            return None;
        }
    }
    let text = fs::read_to_string(&skill_md).ok()?;
    let (fm, _) = parse_frontmatter(&text);
    let rel = folder.strip_prefix(plugin_folder).ok()?;
    let rel_posix = rel.to_string_lossy().replace('\\', "/");
    Some(Skill {
        name: fm
            .get("name")
            .cloned()
            .unwrap_or_else(|| folder.file_name().unwrap_or_default().to_string_lossy().into()),
        description: fm.get("description").cloned().unwrap_or_default(),
        folder: Some(folder.to_path_buf()),
        skill_md_path: Some(skill_md),
        relative_path: rel_posix,
        plugin_name: Some(plugin_name.to_string()),
        marketplace_name: Some(marketplace_name.to_string()),
        remote_present: false,
    })
}

fn scan_skills_in_folder(
    plugin_folder: &Path,
    plugin_name: &str,
    marketplace_name: &str,
) -> Vec<Skill> {
    let mut skills = Vec::new();
    let skills_root = plugin_folder.join("skills");
    if !skills_root.is_dir() {
        return skills;
    }
    let mut entries: Vec<PathBuf> = match fs::read_dir(&skills_root) {
        Ok(it) => it.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(_) => return skills,
    };
    entries.sort();
    for entry in entries {
        if !entry.is_dir() {
            continue;
        }
        if let Some(s) = scan_skill_folder(&entry, plugin_folder, plugin_name, marketplace_name) {
            skills.push(s);
        } else {
            // Look one level deeper (some skills are grouped in folders).
            let mut sub_entries: Vec<PathBuf> = match fs::read_dir(&entry) {
                Ok(it) => it.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
                Err(_) => continue,
            };
            sub_entries.sort();
            for sub in sub_entries {
                if sub.is_dir() {
                    if let Some(s) = scan_skill_folder(
                        &sub,
                        plugin_folder,
                        plugin_name,
                        marketplace_name,
                    ) {
                        skills.push(s);
                    }
                }
            }
        }
    }
    skills
}

/// Resolve the plugin's effective root inside a cache directory.
///
/// Most plugins extract directly under `<install_path>/`, but some upstream
/// marketplaces ship a plugin nested in a subdirectory (e.g.
/// `RevenueCat/rc-claude-code-plugin` puts everything under `revenuecat/`
/// without declaring a `source.path`). Walk one level deep looking for the
/// canonical `.claude-plugin/plugin.json` (or `manifest.json`) marker.
fn resolve_plugin_root(install_path: &Path) -> PathBuf {
    let is_root = |p: &Path| -> bool {
        p.join(".claude-plugin").join("plugin.json").exists()
            || p.join("manifest.json").exists()
            || p.join("skills").is_dir()
    };
    if is_root(install_path) {
        return install_path.to_path_buf();
    }
    if let Ok(entries) = fs::read_dir(install_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && is_root(&path) {
                return path;
            }
        }
    }
    install_path.to_path_buf()
}

pub fn scan_local_plugin(
    install_path: &Path,
    plugin_name: &str,
    marketplace_name: &str,
    installed_version: &str,
    git_sha: &str,
    last_updated: &str,
) -> Plugin {
    let plugin_root = resolve_plugin_root(install_path);
    let manifest_path = plugin_root.join("manifest.json");
    let manifest = if manifest_path.exists() {
        read_json(&manifest_path)
    } else {
        // Fall back to .claude-plugin/plugin.json so we still pick up
        // description/version when manifest.json is absent.
        let alt = plugin_root.join(".claude-plugin").join("plugin.json");
        if alt.exists() {
            read_json(&alt)
        } else {
            Value::Null
        }
    };
    let description = manifest
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let skills = scan_skills_in_folder(&plugin_root, plugin_name, marketplace_name);
    let installed_version = if installed_version.is_empty() {
        manifest
            .get("version")
            .and_then(|v| v.as_str())
            .map(String::from)
    } else {
        Some(installed_version.to_string())
    };
    Plugin {
        name: plugin_name.to_string(),
        marketplace_name: marketplace_name.to_string(),
        installed_version,
        install_path: Some(install_path.to_path_buf()),
        git_commit_sha: if git_sha.is_empty() {
            None
        } else {
            Some(git_sha.to_string())
        },
        description,
        skills,
        manifest: if manifest.is_object() {
            Some(manifest)
        } else {
            None
        },
        install_state: InstallState::Installed,
        last_updated: last_updated.to_string(),
        ..Default::default()
    }
}

pub fn scan_directory_marketplace(source_path: &Path, marketplace_name: &str) -> Vec<Plugin> {
    if !source_path.is_dir() {
        return Vec::new();
    }
    let registry = source_path.join(".claude-plugin").join("marketplace.json");
    if !registry.exists() {
        return Vec::new();
    }
    let text = match fs::read_to_string(&registry) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    parse_marketplace_json(&text, marketplace_name)
}

fn merge_directory_plugins(mut installed: Vec<Plugin>, available: Vec<Plugin>) -> Vec<Plugin> {
    use std::collections::HashMap;
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (i, p) in installed.iter().enumerate() {
        by_name.insert(p.name.clone(), i);
    }
    for av in available {
        if let Some(&idx) = by_name.get(&av.name) {
            let local = &mut installed[idx];
            local.latest_version = av.latest_version.clone();
            if local.description.is_empty() {
                local.description = av.description;
            }
            local.source = av.source;
            // The plugin is listed in this (local) registry → it's "known".
            local.remote_present = true;
            // Share the remote merge's state logic so an unknown `latest`
            // (registries no longer pin a version) is NOT treated as outdated —
            // otherwise every installed plugin gets a permanent, unfixable
            // "Mettre à jour" button.
            local.install_state = crate::marketplace_remote::install_state_for(
                local.installed_version.as_deref(),
                local.latest_version.as_deref(),
                true,
            );
        } else {
            installed.push(av);
        }
    }
    installed
}

pub fn installed_plugins_by_marketplace() -> BTreeMap<String, Vec<Plugin>> {
    let installed = load_installed_plugins();
    let enabled_map = plugin_state::load_enabled_plugins();
    let mut out: BTreeMap<String, Vec<Plugin>> = BTreeMap::new();
    for (key, records) in installed {
        let Some((plugin_name, marketplace_name)) = key.split_once('@') else {
            continue;
        };
        let record = records
            .as_array()
            .and_then(|a| a.first().cloned())
            .unwrap_or(Value::Null);
        let install_path = PathBuf::from(
            record
                .get("installPath")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        );
        let mut plugin = scan_local_plugin(
            &install_path,
            plugin_name,
            marketplace_name,
            record.get("version").and_then(|v| v.as_str()).unwrap_or(""),
            record
                .get("gitCommitSha")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            record
                .get("lastUpdated")
                .and_then(|v| v.as_str())
                .or_else(|| record.get("installedAt").and_then(|v| v.as_str()))
                .unwrap_or(""),
        );
        plugin.enabled = enabled_map.get(&key).copied();
        out.entry(marketplace_name.to_string())
            .or_default()
            .push(plugin);
    }
    out
}

pub fn build_marketplaces_from_settings(
    settings_marketplaces: &[MarketplaceConfig],
) -> Vec<Marketplace> {
    let mut installed_map = installed_plugins_by_marketplace();
    let known = load_known_marketplaces();
    let mut out: Vec<Marketplace> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for cfg in settings_marketplaces {
        let mut plugins = installed_map.remove(&cfg.name).unwrap_or_default();
        if !cfg.source_path.is_empty() {
            let available = scan_directory_marketplace(Path::new(&cfg.source_path), &cfg.name);
            plugins = merge_directory_plugins(plugins, available);
        }
        let info = known.get(&cfg.name).cloned().unwrap_or(Value::Null);
        let install_location = info
            .get("installLocation")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let last_updated = info
            .get("lastUpdated")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // Fallback: if app settings has no github_repo but Claude's own
        // known_marketplaces.json knows this marketplace was installed from
        // GitHub, use that. Avoids forcing the user to re-enter owner/repo
        // already recorded by `/plugin marketplace add`.
        let known_repo = info
            .get("source")
            .and_then(|s| s.get("repo"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let source_repo = if !cfg.github_repo.is_empty() {
            cfg.github_repo.clone()
        } else {
            known_repo
        };
        let kind = if !source_repo.is_empty() {
            "github"
        } else if !cfg.source_path.is_empty() {
            "directory"
        } else {
            "unknown"
        };
        if !install_location.is_empty() && cfg.source_path.is_empty() {
            let available = scan_directory_marketplace(Path::new(&install_location), &cfg.name);
            plugins = merge_directory_plugins(plugins, available);
        }
        seen.insert(cfg.name.clone());
        out.push(Marketplace {
            name: cfg.name.clone(),
            source_kind: kind.to_string(),
            remote_browseable: !source_repo.is_empty(),
            source_repo,
            source_path: cfg.source_path.clone(),
            install_location,
            plugins,
            owned: cfg.owned,
            installed: !info.is_null(),
            last_updated,
            ..Default::default()
        });
    }

    // Surface orphan marketplaces (installed locally but missing from settings).
    let mut orphan_names: HashSet<String> = installed_map.keys().cloned().collect();
    for k in known.keys() {
        if !seen.contains(k) {
            orphan_names.insert(k.clone());
        }
    }
    for orphan_name in orphan_names {
        if seen.contains(&orphan_name) {
            continue;
        }
        let info = known.get(&orphan_name).cloned().unwrap_or(Value::Null);
        let mut plugins = installed_map.remove(&orphan_name).unwrap_or_default();
        let install_location = info
            .get("installLocation")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !install_location.is_empty() {
            let available =
                scan_directory_marketplace(Path::new(&install_location), &orphan_name);
            plugins = merge_directory_plugins(plugins, available);
        }
        let known_repo = info
            .get("source")
            .and_then(|s| s.get("repo"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        out.push(Marketplace {
            name: orphan_name.clone(),
            source_kind: if known_repo.is_empty() {
                "unknown".to_string()
            } else {
                "github".to_string()
            },
            remote_browseable: !known_repo.is_empty(),
            source_repo: known_repo,
            install_location,
            plugins,
            installed: !info.is_null(),
            last_updated: info
                .get("lastUpdated")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            ..Default::default()
        });
    }
    out
}

pub fn scan_user_skills() -> Vec<UserSkill> {
    let root = config::claude_user_skills_dir();
    if !root.is_dir() {
        return Vec::new();
    }
    let mut entries: Vec<PathBuf> = match fs::read_dir(&root) {
        Ok(it) => it.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(_) => return Vec::new(),
    };
    entries.sort();
    let mut out = Vec::new();
    for entry in entries {
        if !entry.is_dir() {
            continue;
        }
        let mut skill_md = entry.join("SKILL.md");
        if !skill_md.exists() {
            skill_md = entry.join("skill.md");
            if !skill_md.exists() {
                continue;
            }
        }
        let text = match fs::read_to_string(&skill_md) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (fm, _) = parse_frontmatter(&text);
        out.push(UserSkill {
            name: fm
                .get("name")
                .cloned()
                .unwrap_or_else(|| entry.file_name().unwrap_or_default().to_string_lossy().into()),
            folder: entry,
            description: fm.get("description").cloned().unwrap_or_default(),
        });
    }
    out
}

/// Pulls a skill version from frontmatter, mirroring `admin_drafts::skill_version_from_fm`.
fn skill_version(fm: &Fields) -> String {
    fm.get("version")
        .or_else(|| fm.get("metadata.version"))
        .cloned()
        .unwrap_or_default()
}

fn file_mtime_iso(path: &Path) -> String {
    let Ok(meta) = fs::metadata(path) else {
        return String::new();
    };
    let Ok(mtime) = meta.modified() else {
        return String::new();
    };
    let dt: DateTime<Utc> = mtime.into();
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCopy {
    pub folder: PathBuf,
    pub skill_md_path: PathBuf,
    pub version: String,
    pub description: String,
    pub last_modified: String,
    /// Human-readable origin: "(local)" or "<plugin>@<marketplace>".
    pub source: String,
    pub plugin_name: Option<String>,
    pub marketplace_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateSkill {
    pub name: String,
    pub local: DuplicateCopy,
    pub plugin_copies: Vec<DuplicateCopy>,
}

fn copy_from_local(folder: &Path) -> Option<DuplicateCopy> {
    let mut skill_md = folder.join("SKILL.md");
    if !skill_md.exists() {
        skill_md = folder.join("skill.md");
        if !skill_md.exists() {
            return None;
        }
    }
    let text = fs::read_to_string(&skill_md).ok()?;
    let (fm, _) = parse_frontmatter(&text);
    let name = fm.get("name").cloned().unwrap_or_else(|| {
        folder
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    Some(DuplicateCopy {
        folder: folder.to_path_buf(),
        last_modified: file_mtime_iso(&skill_md),
        skill_md_path: skill_md,
        version: skill_version(&fm),
        description: fm.get("description").cloned().unwrap_or_default(),
        source: "(local)".to_string(),
        plugin_name: None,
        marketplace_name: Some(name),
    })
}

fn copy_from_plugin_skill(skill: &Skill) -> Option<DuplicateCopy> {
    let folder = skill.folder.clone()?;
    let skill_md = skill.skill_md_path.clone().unwrap_or_else(|| {
        let candidate = folder.join("SKILL.md");
        if candidate.exists() {
            candidate
        } else {
            folder.join("skill.md")
        }
    });
    let (version, description) = if skill_md.exists() {
        fs::read_to_string(&skill_md)
            .ok()
            .map(|t| {
                let (fm, _) = parse_frontmatter(&t);
                (skill_version(&fm), fm.get("description").cloned().unwrap_or_default())
            })
            .unwrap_or_default()
    } else {
        (String::new(), skill.description.clone())
    };
    let plugin_name = skill.plugin_name.clone().unwrap_or_default();
    let marketplace_name = skill.marketplace_name.clone().unwrap_or_default();
    let source = if plugin_name.is_empty() && marketplace_name.is_empty() {
        "(plugin)".to_string()
    } else {
        format!("{plugin_name}@{marketplace_name}")
    };
    Some(DuplicateCopy {
        folder,
        last_modified: file_mtime_iso(&skill_md),
        skill_md_path: skill_md,
        version,
        description,
        source,
        plugin_name: skill.plugin_name.clone(),
        marketplace_name: skill.marketplace_name.clone(),
    })
}

/// Scans `~/.claude/skills/` and every installed plugin's skills, returning
/// each local skill that also exists in at least one installed plugin (matched
/// case-insensitively on the skill `name` from frontmatter, falling back to
/// folder basename).
pub fn find_duplicate_skills() -> Vec<DuplicateSkill> {
    let user_skills = scan_user_skills();
    if user_skills.is_empty() {
        return Vec::new();
    }
    let by_mp = installed_plugins_by_marketplace();
    let mut out = Vec::new();
    for us in user_skills {
        let key = us.name.to_lowercase();
        let mut plugin_copies = Vec::new();
        for (_mp_name, plugins) in &by_mp {
            for plugin in plugins {
                for skill in &plugin.skills {
                    if skill.name.to_lowercase() == key {
                        if let Some(c) = copy_from_plugin_skill(skill) {
                            plugin_copies.push(c);
                        }
                    }
                }
            }
        }
        if plugin_copies.is_empty() {
            continue;
        }
        let Some(mut local) = copy_from_local(&us.folder) else {
            continue;
        };
        // copy_from_local stuffed the resolved name into marketplace_name as a
        // convenience; drop it so the JSON shape matches plugin copies.
        local.marketplace_name = None;
        out.push(DuplicateSkill {
            name: us.name,
            local,
            plugin_copies,
        });
    }
    out
}

/// Marker used in archive folder names — `<basename>__archived-<YYYYMMDDTHHMMSSZ>`.
/// Picked because skill folder names typically use dashes, so a double-underscore
/// + literal prefix is unambiguous to parse back out.
const ARCHIVE_SUFFIX_MARKER: &str = "__archived-";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedSkill {
    pub name: String,
    pub original_name: String,
    pub folder: PathBuf,
    pub skill_md_path: Option<PathBuf>,
    pub description: String,
    pub archived_at: String,
    pub version: String,
}

fn make_archive_dirname(basename: &str, ts: &DateTime<Utc>) -> String {
    format!(
        "{basename}{ARCHIVE_SUFFIX_MARKER}{}",
        ts.format("%Y%m%dT%H%M%SZ")
    )
}

/// Returns `(original_basename, iso8601_archived_at)` parsed from an archive
/// folder name. Returns `None` if the folder name doesn't match the encoding.
fn parse_archive_dirname(name: &str) -> Option<(String, String)> {
    let idx = name.rfind(ARCHIVE_SUFFIX_MARKER)?;
    let original = name[..idx].to_string();
    let mut tail = &name[idx + ARCHIVE_SUFFIX_MARKER.len()..];
    // Collision suffix "-N" — strip before parsing the timestamp.
    if let Some(dash_idx) = tail.rfind('-') {
        let candidate = &tail[..dash_idx];
        if candidate.len() == 16 && tail[dash_idx + 1..].chars().all(|c| c.is_ascii_digit()) {
            tail = candidate;
        }
    }
    if tail.len() != 16 {
        return None;
    }
    let bytes = tail.as_bytes();
    if bytes[8] != b'T' || bytes[15] != b'Z' {
        return None;
    }
    let iso = format!(
        "{}-{}-{}T{}:{}:{}Z",
        &tail[0..4],
        &tail[4..6],
        &tail[6..8],
        &tail[9..11],
        &tail[11..13],
        &tail[13..15],
    );
    Some((original, iso))
}

/// Moves a local user skill folder into `~/.claude/skills_archive/`. Returns the
/// new path. Refuses anything that isn't a direct child of `~/.claude/skills/`.
pub fn archive_user_skill_folder(folder: &Path) -> crate::error::Result<PathBuf> {
    use crate::error::Error;
    let root = config::claude_user_skills_dir();
    let canon_root = fs::canonicalize(&root)
        .map_err(|e| Error::Invalid(format!("user skills dir not accessible: {e}")))?;
    let canon_target = fs::canonicalize(folder)
        .map_err(|e| Error::NotFound(format!("folder not accessible: {e}")))?;
    if !canon_target.starts_with(&canon_root) {
        return Err(Error::Invalid(format!(
            "Refusing to archive '{}' — not under {}",
            canon_target.display(),
            canon_root.display()
        )));
    }
    if canon_target.parent().map(|p| p != canon_root).unwrap_or(true) {
        return Err(Error::Invalid(format!(
            "Refusing to archive '{}' — not a direct child of {}",
            canon_target.display(),
            canon_root.display()
        )));
    }
    let basename = canon_target
        .file_name()
        .ok_or_else(|| Error::Invalid("folder has no name".into()))?
        .to_string_lossy()
        .into_owned();
    let archive_root = config::claude_skills_archive_dir();
    fs::create_dir_all(&archive_root)?;
    let now = Utc::now();
    let base_dirname = make_archive_dirname(&basename, &now);
    let mut dest = archive_root.join(&base_dirname);
    let mut counter = 2;
    while dest.exists() {
        dest = archive_root.join(format!("{base_dirname}-{counter}"));
        counter += 1;
    }
    fs::rename(&canon_target, &dest)?;
    Ok(dest)
}

/// Moves an archived skill back into `~/.claude/skills/`. Refuses anything that
/// isn't a direct child of `~/.claude/skills_archive/`.
pub fn restore_archived_skill_folder(folder: &Path) -> crate::error::Result<PathBuf> {
    use crate::error::Error;
    let archive_root = config::claude_skills_archive_dir();
    let canon_archive_root = fs::canonicalize(&archive_root)
        .map_err(|e| Error::Invalid(format!("archive dir not accessible: {e}")))?;
    let canon_target = fs::canonicalize(folder)
        .map_err(|e| Error::NotFound(format!("folder not accessible: {e}")))?;
    if !canon_target.starts_with(&canon_archive_root) {
        return Err(Error::Invalid(format!(
            "Refusing to restore '{}' — not under {}",
            canon_target.display(),
            canon_archive_root.display()
        )));
    }
    if canon_target
        .parent()
        .map(|p| p != canon_archive_root)
        .unwrap_or(true)
    {
        return Err(Error::Invalid(format!(
            "Refusing to restore '{}' — not a direct child of {}",
            canon_target.display(),
            canon_archive_root.display()
        )));
    }
    let folder_name = canon_target
        .file_name()
        .ok_or_else(|| Error::Invalid("folder has no name".into()))?
        .to_string_lossy()
        .into_owned();
    let basename = parse_archive_dirname(&folder_name)
        .map(|(b, _)| b)
        .unwrap_or(folder_name);
    let skills_root = config::claude_user_skills_dir();
    fs::create_dir_all(&skills_root)?;
    let mut dest = skills_root.join(&basename);
    let mut counter = 2;
    while dest.exists() {
        dest = skills_root.join(format!("{basename}-{counter}"));
        counter += 1;
    }
    fs::rename(&canon_target, &dest)?;
    Ok(dest)
}

pub fn list_archived_skills() -> Vec<ArchivedSkill> {
    let root = config::claude_skills_archive_dir();
    if !root.is_dir() {
        return Vec::new();
    }
    let entries: Vec<PathBuf> = match fs::read_dir(&root) {
        Ok(it) => it.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries {
        if !entry.is_dir() {
            continue;
        }
        let folder_name = entry
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let (original_name, archived_at_from_name) = parse_archive_dirname(&folder_name)
            .unwrap_or_else(|| (folder_name.clone(), String::new()));
        let mut skill_md = entry.join("SKILL.md");
        if !skill_md.exists() {
            skill_md = entry.join("skill.md");
        }
        let (fm, skill_md_path) = if skill_md.exists() {
            match fs::read_to_string(&skill_md) {
                Ok(t) => (parse_frontmatter(&t).0, Some(skill_md)),
                Err(_) => (Fields::new(), None),
            }
        } else {
            (Fields::new(), None)
        };
        let archived_at = if archived_at_from_name.is_empty() {
            file_mtime_iso(&entry)
        } else {
            archived_at_from_name
        };
        let name = fm
            .get("name")
            .cloned()
            .unwrap_or_else(|| original_name.clone());
        out.push(ArchivedSkill {
            name,
            original_name,
            folder: entry,
            skill_md_path,
            description: fm.get("description").cloned().unwrap_or_default(),
            version: skill_version(&fm),
            archived_at,
        });
    }
    out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    out
}

pub fn build_local_only_marketplace() -> Marketplace {
    let skills = scan_user_skills();
    let mut plugins = Vec::new();
    for s in skills {
        let mut skill_md = s.folder.join("SKILL.md");
        if !skill_md.exists() {
            skill_md = s.folder.join("skill.md");
        }
        let plugin_skill = Skill {
            name: s.name.clone(),
            description: s.description.clone(),
            folder: Some(s.folder.clone()),
            skill_md_path: if skill_md.exists() { Some(skill_md) } else { None },
            relative_path: String::new(),
            plugin_name: Some(s.name.clone()),
            marketplace_name: Some(LOCAL_MARKETPLACE_NAME.to_string()),
            remote_present: false,
        };
        plugins.push(Plugin {
            name: s.name.clone(),
            marketplace_name: LOCAL_MARKETPLACE_NAME.to_string(),
            installed_version: Some("local".to_string()),
            install_path: Some(s.folder.clone()),
            description: s.description.clone(),
            skills: vec![plugin_skill],
            install_state: InstallState::LocalOnly,
            ..Default::default()
        });
    }
    Marketplace {
        name: LOCAL_MARKETPLACE_NAME.to_string(),
        source_kind: "local".to_string(),
        source_path: config::claude_user_skills_dir().to_string_lossy().into(),
        plugins,
        ..Default::default()
    }
}

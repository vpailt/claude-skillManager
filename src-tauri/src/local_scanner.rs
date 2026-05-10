//! Scans the local Claude install for marketplaces, plugins and skills —
//! port of src/local_scanner.py.

use crate::config::{self, MarketplaceConfig};
use crate::frontmatter::parse_frontmatter;
use crate::models::{InstallState, Marketplace, Plugin, Skill, UserSkill};
use crate::plugin_state;
use crate::registry::parse_marketplace_json;
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

pub fn scan_local_plugin(
    install_path: &Path,
    plugin_name: &str,
    marketplace_name: &str,
    installed_version: &str,
    git_sha: &str,
    last_updated: &str,
) -> Plugin {
    let manifest_path = install_path.join("manifest.json");
    let manifest = if manifest_path.exists() {
        read_json(&manifest_path)
    } else {
        Value::Null
    };
    let description = manifest
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let skills = scan_skills_in_folder(install_path, plugin_name, marketplace_name);
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
            let same = local
                .installed_version
                .as_deref()
                .unwrap_or("")
                == av.latest_version.as_deref().unwrap_or("");
            local.install_state = if same {
                InstallState::Installed
            } else {
                InstallState::Outdated
            };
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
        let kind = if !cfg.github_repo.is_empty() {
            "github"
        } else if !cfg.source_path.is_empty() {
            "directory"
        } else {
            "unknown"
        };
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
        if !install_location.is_empty() && cfg.source_path.is_empty() {
            let available = scan_directory_marketplace(Path::new(&install_location), &cfg.name);
            plugins = merge_directory_plugins(plugins, available);
        }
        seen.insert(cfg.name.clone());
        out.push(Marketplace {
            name: cfg.name.clone(),
            source_kind: kind.to_string(),
            source_repo: cfg.github_repo.clone(),
            source_path: cfg.source_path.clone(),
            install_location,
            plugins,
            owned: cfg.owned,
            remote_browseable: !cfg.github_repo.is_empty(),
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
        out.push(Marketplace {
            name: orphan_name.clone(),
            source_kind: "unknown".to_string(),
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

//! Usage audit — reconstructs *actual* Claude Code usage from the session
//! transcripts under `~/.claude/projects/<project>/*.jsonl`.
//!
//! Claude Code keeps no usage counters; the only ground truth is the JSONL
//! transcripts. Each line is one event. We mine three kinds of explicit
//! invocations:
//!
//! - **Skill** — an `assistant` line whose `message.content[]` holds a
//!   `tool_use` block `name:"Skill"`; the skill id is `input.skill`
//!   (`"<plugin>:<skill>"`).
//! - **Agent** — same, but `name:"Agent"`; the subagent is `input.subagent_type`.
//! - **Command** — a `user` line whose text contains
//!   `<command-name>/foo</command-name>` (how Claude Code records a slash
//!   command).
//!
//! Each event carries the line's ISO `timestamp` and the `cwd` (→ project name
//! + full path, the latter used to open the project root in VS Code).
//!
//! ## Provenance
//!
//! To answer "top plugins" / "unused plugins" we attribute each invocation to a
//! plugin:
//! - Skills carry their plugin in the namespace prefix (`"<plugin>:<skill>"`).
//! - Agents/commands are bare names, so we scan the installed plugins' cache
//!   (`~/.claude/plugins/cache/<mp>/<plugin>/<version>/{agents,commands}/`) to
//!   map an agent/command name back to the plugin that ships it. Built-in
//!   agents/commands match nothing and correctly count toward no plugin.
//!
//! ## Caching
//!
//! Parsing ~130 MB of transcripts on every open would stall the UI, so the
//! parsed events are cached per file at `<exe_dir>/config/usage_index.json`,
//! keyed by path with its `mtime`+`size`. Only files whose stamp changed are
//! re-parsed; deleted files are pruned. The cache is the full event set; date
//! filtering and aggregation run over it in memory.
//!
//! The measure reflects *active* usage (explicit invocations). A plugin that
//! only contributes injected context, with no skill/agent/command invocation,
//! shows as little- or un-used — that is expected.

use crate::config;
use crate::error::{Error, Result};
use crate::installer::{atomic_write_json, now_iso};
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// Bumped whenever the cached event shape changes (a mismatch drops the cache).
// v2 added `project_path`; v3 added `project_key` (stable project identity).
const INDEX_VERSION: u32 = 3;

// Serializes the index refresh+persist so two concurrent audits (dashboard,
// audit page, export) never race on the shared `usage_index.json.tmp`.
static INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ============================================================
// Event model + on-disk index
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageKind {
    Skill,
    Agent,
    Command,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UsageEvent {
    /// ISO-8601 timestamp of the line that produced the event.
    ts: String,
    /// Stable project identity: the transcript's parent directory name. Claude
    /// Code keeps one folder per launch root, so this groups every session (and
    /// any sub-directory the session `cd`-ed into) of the *same* project — and,
    /// crucially, never collapses two different repos that share a basename
    /// (e.g. `clientA/api` vs `clientB/api`).
    #[serde(default)]
    project_key: String,
    /// Full `cwd` as recorded on the line — used to resolve the project root
    /// path (to open in VS Code) and the display name. Empty when the line
    /// carried no `cwd`.
    #[serde(default)]
    project_path: String,
    kind: UsageKind,
    /// Raw invocation id: `"<plugin>:<skill>"` for skills, the subagent type
    /// for agents, the slash-command (with leading `/`) for commands.
    name: String,
}

/// One transcript file's cached parse: its stamp + the events it yielded.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileEntry {
    mtime: u64,
    size: u64,
    events: Vec<UsageEvent>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UsageIndex {
    #[serde(default)]
    version: u32,
    /// Keyed by absolute transcript path.
    #[serde(default)]
    files: HashMap<String, FileEntry>,
}

fn index_file() -> PathBuf {
    config::app_settings_dir().join("usage_index.json")
}

fn load_index() -> UsageIndex {
    let f = index_file();
    if !f.exists() {
        return UsageIndex::default();
    }
    let idx: UsageIndex = fs::read_to_string(&f)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // A schema bump invalidates the whole cache — cheaper than migrating.
    if idx.version != INDEX_VERSION {
        return UsageIndex::default();
    }
    idx
}

fn save_index(idx: &UsageIndex) -> Result<()> {
    let value = serde_json::to_value(idx)?;
    atomic_write_json(&index_file(), &value)
}

// ============================================================
// Report model (returned to the frontend)
// ============================================================

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUsage {
    pub plugin: String,
    /// Marketplace the plugin is installed from, or empty when the used plugin
    /// is not currently installed (e.g. renamed/removed since the session).
    pub marketplace: String,
    pub installed: bool,
    pub total: u64,
    pub skill_count: u64,
    pub agent_count: u64,
    pub command_count: u64,
}

/// A skill's usage within one project: how many times, on which days.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    /// Project display name (last segment of its root path).
    pub project: String,
    /// Project root path, for opening in VS Code. Empty if never captured.
    pub path: String,
    pub count: u64,
    /// Distinct usage days (`YYYY-MM-DD`), ascending. No times.
    pub dates: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsage {
    /// Full invocation id (`"<plugin>:<skill>"` or a bare local skill name).
    pub skill: String,
    /// Namespace prefix, or empty for an unprefixed local skill.
    pub plugin: String,
    pub count: u64,
    /// Per-project breakdown (count + usage days), ranked by count desc.
    pub projects: Vec<ProjectUsage>,
}

/// One skill line inside a project aggregate.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillLine {
    pub skill: String,
    pub count: u64,
    /// Distinct usage days (`YYYY-MM-DD`), ascending.
    pub dates: Vec<String>,
}

/// A project's skill usage — the inverse view of [`SkillUsage`].
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAggregate {
    pub project: String,
    pub path: String,
    pub total: u64,
    pub skills: Vec<ProjectSkillLine>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// Echoed filter bounds (ISO). Empty string = unbounded.
    pub from: String,
    pub to: String,
    pub generated_at: String,
    pub total_events: u64,
    /// All plugins with ≥1 invocation in the window, ranked by total desc.
    /// The UI shows the top 3; the export includes the full ranking.
    pub top_plugins: Vec<PluginUsage>,
    /// Installed plugins with **zero** invocations in the window.
    pub unused_plugins: Vec<String>,
    /// Every skill invoked in the window, ranked by count desc.
    pub skills: Vec<SkillUsage>,
    /// Skill usage grouped by project (for the "par projet" view/sheet),
    /// ranked by total desc.
    pub projects: Vec<ProjectAggregate>,
}

// ============================================================
// Provenance: agent/command name -> installed plugin
// ============================================================

/// One installed plugin, resolved to what it ships.
struct InstalledPlugin {
    plugin: String,
    marketplace: String,
}

/// Read `installed_plugins.json` → the list of `<plugin>@<marketplace>` entries.
fn installed_plugins() -> Vec<InstalledPlugin> {
    let f = config::installed_plugins_file();
    let Ok(text) = fs::read_to_string(&f) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(map) = json.get("plugins").and_then(Value::as_object) {
        for key in map.keys() {
            // Key is "<plugin>@<marketplace>".
            let (plugin, marketplace) = match key.split_once('@') {
                Some((p, m)) => (p.to_string(), m.to_string()),
                None => (key.clone(), String::new()),
            };
            out.push(InstalledPlugin { plugin, marketplace });
        }
    }
    out
}

/// Map bare agent/command names → plugin, by scanning each installed plugin's
/// cache dir. Keys are lowercased for case-insensitive lookup. Command keys are
/// stored without a leading `/`.
struct Provenance {
    /// agent name (lowercased) -> plugin
    agents: HashMap<String, String>,
    /// command name (lowercased, no leading '/') -> plugin
    commands: HashMap<String, String>,
    /// plugin -> marketplace, for every installed plugin
    installed: HashMap<String, String>,
}

impl Provenance {
    fn build(plugins: &[InstalledPlugin]) -> Self {
        let mut agents = HashMap::new();
        let mut commands = HashMap::new();
        let mut installed = HashMap::new();
        let cache_root = config::plugins_cache_dir();
        for p in plugins {
            installed.insert(p.plugin.clone(), p.marketplace.clone());
            // cache/<marketplace>/<plugin>/<version>/... — scan every version dir.
            let plugin_dir = cache_root.join(&p.marketplace).join(&p.plugin);
            let Ok(versions) = fs::read_dir(&plugin_dir) else {
                continue;
            };
            for ver in versions.flatten() {
                let base = ver.path();
                collect_stems(&base.join("agents"), &p.plugin, &mut agents);
                collect_stems(&base.join("commands"), &p.plugin, &mut commands);
            }
        }
        Provenance {
            agents,
            commands,
            installed,
        }
    }
}

/// Insert `<file stem lowercased> -> plugin` for every `.md` file directly under
/// `dir` (agents and commands ship as `<name>.md`).
fn collect_stems(dir: &Path, plugin: &str, out: &mut HashMap<String, String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            out.entry(stem.to_ascii_lowercase())
                .or_insert_with(|| plugin.to_string());
        }
    }
}

/// Resolve an event to the plugin that owns it, if any.
/// - Skill `"X:Y"` → `X` (namespace prefix). Bare skill → `None`.
/// - Agent → provenance lookup. Built-in → `None`.
/// - Command `"/name"` → provenance lookup (leading `/` stripped). Built-in → `None`.
fn plugin_of(ev: &UsageEvent, prov: &Provenance) -> Option<String> {
    match ev.kind {
        UsageKind::Skill => ev
            .name
            .split_once(':')
            .map(|(plugin, _)| plugin.to_string()),
        UsageKind::Agent => prov.agents.get(&ev.name.to_ascii_lowercase()).cloned(),
        UsageKind::Command => {
            let key = ev.name.trim_start_matches('/').to_ascii_lowercase();
            prov.commands.get(&key).cloned()
        }
    }
}

// ============================================================
// Transcript parsing
// ============================================================

/// Project display name for a `cwd`: its last path segment.
fn project_name(cwd: Option<&str>, fallback_dir: &str) -> String {
    if let Some(cwd) = cwd {
        let trimmed = cwd.trim_end_matches(['\\', '/']);
        let seg = trimmed
            .rsplit(['\\', '/'])
            .find(|s| !s.is_empty())
            .unwrap_or(trimmed);
        if !seg.is_empty() {
            return seg.to_string();
        }
    }
    fallback_dir.to_string()
}

/// Pull the plain text out of a `user` message's `content` (string or a list of
/// `{type:"text", text}` blocks).
fn user_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            let mut buf = String::new();
            for b in items {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(t) = b.get("text").and_then(Value::as_str) {
                        buf.push_str(t);
                    }
                }
            }
            buf
        }
        _ => String::new(),
    }
}

/// Extract the slash-command id from a user text, if any: the content of the
/// first `<command-name>…</command-name>` tag. Cheap substring scan — no regex.
fn command_in(text: &str) -> Option<String> {
    const OPEN: &str = "<command-name>";
    const CLOSE: &str = "</command-name>";
    let start = text.find(OPEN)? + OPEN.len();
    let end = text[start..].find(CLOSE)? + start;
    let cmd = text[start..end].trim();
    if cmd.is_empty() {
        None
    } else {
        Some(cmd.to_string())
    }
}

/// Parse one transcript file into its events. Malformed lines are skipped.
fn parse_transcript(path: &Path, fallback_dir: &str) -> Vec<UsageEvent> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(d) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ty = d.get("type").and_then(Value::as_str).unwrap_or("");
        let ts = d.get("timestamp").and_then(Value::as_str).unwrap_or("");
        if ts.is_empty() {
            continue;
        }
        let cwd = d.get("cwd").and_then(Value::as_str);
        let project_key = fallback_dir.to_string();
        let project_path = cwd.unwrap_or("").to_string();

        match ty {
            "assistant" => {
                let Some(content) = d
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                else {
                    continue;
                };
                for block in content {
                    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                        continue;
                    }
                    let tool = block.get("name").and_then(Value::as_str).unwrap_or("");
                    let input = block.get("input");
                    let (kind, name) = match tool {
                        "Skill" => (
                            UsageKind::Skill,
                            input
                                .and_then(|i| i.get("skill"))
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                        ),
                        "Agent" => (
                            UsageKind::Agent,
                            input
                                .and_then(|i| i.get("subagent_type"))
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                        ),
                        _ => continue,
                    };
                    if name.is_empty() {
                        continue;
                    }
                    events.push(UsageEvent {
                        ts: ts.to_string(),
                        project_key: project_key.clone(),
                        project_path: project_path.clone(),
                        kind,
                        name: name.to_string(),
                    });
                }
            }
            "user" => {
                let Some(content) = d.get("message").and_then(|m| m.get("content")) else {
                    continue;
                };
                let text = user_text(content);
                if let Some(cmd) = command_in(&text) {
                    events.push(UsageEvent {
                        ts: ts.to_string(),
                        project_key,
                        project_path,
                        kind: UsageKind::Command,
                        name: cmd,
                    });
                }
            }
            _ => {}
        }
    }
    events
}

fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((mtime, size))
}

/// Walk `~/.claude/projects/`, (re)parsing only transcripts whose stamp changed
/// vs the cached index. Prunes deleted files. Returns the full event set and the
/// refreshed index (to be persisted by the caller).
fn refresh_events(mut index: UsageIndex) -> (Vec<UsageEvent>, UsageIndex) {
    let root = config::claude_home().join("projects");
    let mut fresh: HashMap<String, FileEntry> = HashMap::new();
    let mut all: Vec<UsageEvent> = Vec::new();
    let mut reparsed = 0usize;
    let mut reused = 0usize;

    for entry in WalkDir::new(&root)
        .min_depth(2)
        .max_depth(2)
        .into_iter()
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let key = path.to_string_lossy().to_string();
        let fallback_dir = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let Some((mtime, size)) = file_stamp(path) else {
            continue;
        };

        let file_entry = match index.files.remove(&key) {
            Some(cached) if cached.mtime == mtime && cached.size == size => {
                reused += 1;
                cached
            }
            _ => {
                reparsed += 1;
                FileEntry {
                    mtime,
                    size,
                    events: parse_transcript(path, &fallback_dir),
                }
            }
        };
        all.extend(file_entry.events.iter().cloned());
        fresh.insert(key, file_entry);
    }

    tracing::info!(
        "usage audit: {} transcripts ({} reparsed, {} cached), {} events",
        fresh.len(),
        reparsed,
        reused,
        all.len()
    );
    index.files = fresh;
    index.version = INDEX_VERSION;
    (all, index)
}

// ============================================================
// Aggregation
// ============================================================

fn parse_bound(s: &str) -> Option<DateTime<Utc>> {
    if s.trim().is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn in_window(ts: &str, from: Option<DateTime<Utc>>, to: Option<DateTime<Utc>>) -> bool {
    let Some(t) = DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|d| d.with_timezone(&Utc))
    else {
        return false;
    };
    if let Some(f) = from {
        if t < f {
            return false;
        }
    }
    if let Some(u) = to {
        if t > u {
            return false;
        }
    }
    true
}

/// The calendar day (`YYYY-MM-DD`) of an ISO timestamp, in the machine's local
/// timezone — no time. Local (not UTC) so that a France-evening invocation lands
/// on the day the user actually worked, matching the local `<input type=date>`
/// bounds. Falls back to the raw UTC date prefix if parsing fails.
fn day_of(ts: &str) -> String {
    DateTime::parse_from_rfc3339(ts)
        .map(|d| d.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| ts.get(..10).unwrap_or(ts).to_string())
}

/// Aggregate the cached events into a report for the `[from, to]` window.
fn aggregate(events: &[UsageEvent], from: &str, to: &str) -> UsageReport {
    let plugins = installed_plugins();
    let prov = Provenance::build(&plugins);
    let from_dt = parse_bound(from);
    let to_dt = parse_bound(to);

    // Keep only in-window events once, up front.
    let in_win: Vec<&UsageEvent> = events
        .iter()
        .filter(|e| in_window(&e.ts, from_dt, to_dt))
        .collect();
    let total_events = in_win.len() as u64;

    // Canonical root path per project (keyed by the stable `project_key`) =
    // shortest non-empty `cwd` seen — the launch root is a prefix of any subdir
    // the session `cd`-ed into, so the shortest cwd is the root.
    let mut root_path: HashMap<String, String> = HashMap::new();
    for ev in &in_win {
        if ev.project_path.is_empty() {
            continue;
        }
        root_path
            .entry(ev.project_key.clone())
            .and_modify(|cur| {
                if ev.project_path.len() < cur.len() {
                    *cur = ev.project_path.clone();
                }
            })
            .or_insert_with(|| ev.project_path.clone());
    }

    // --- Per-plugin counters ---
    struct Agg {
        marketplace: String,
        installed: bool,
        total: u64,
        skill: u64,
        agent: u64,
        command: u64,
    }
    let mut by_plugin: BTreeMap<String, Agg> = BTreeMap::new();

    // --- Skill × project → (count, days) ; and its inverse Project × skill ---
    struct Cell {
        count: u64,
        days: BTreeSet<String>,
    }
    let mut by_skill: BTreeMap<String, BTreeMap<String, Cell>> = BTreeMap::new();
    let mut by_project: BTreeMap<String, BTreeMap<String, Cell>> = BTreeMap::new();

    for ev in &in_win {
        if ev.kind == UsageKind::Skill {
            let day = day_of(&ev.ts);
            let sk = by_skill.entry(ev.name.clone()).or_default();
            let cell = sk.entry(ev.project_key.clone()).or_insert_with(|| Cell {
                count: 0,
                days: BTreeSet::new(),
            });
            cell.count += 1;
            cell.days.insert(day.clone());

            let pr = by_project.entry(ev.project_key.clone()).or_default();
            let cell = pr.entry(ev.name.clone()).or_insert_with(|| Cell {
                count: 0,
                days: BTreeSet::new(),
            });
            cell.count += 1;
            cell.days.insert(day);
        }

        if let Some(plugin) = plugin_of(ev, &prov) {
            let a = by_plugin.entry(plugin.clone()).or_insert_with(|| Agg {
                marketplace: prov.installed.get(&plugin).cloned().unwrap_or_default(),
                installed: prov.installed.contains_key(&plugin),
                total: 0,
                skill: 0,
                agent: 0,
                command: 0,
            });
            a.total += 1;
            match ev.kind {
                UsageKind::Skill => a.skill += 1,
                UsageKind::Agent => a.agent += 1,
                UsageKind::Command => a.command += 1,
            }
        }
    }

    // Resolve a project_key to its root path and human display name. The display
    // is the last segment of the resolved root (falling back to the raw key when
    // no cwd was ever captured), so two same-basename repos keep distinct keys
    // but each shows its own name + opens its own root.
    let path_of = |key: &str| root_path.get(key).cloned().unwrap_or_default();
    let display_of = |key: &str| -> String {
        let root = root_path.get(key).map(|s| s.as_str()).unwrap_or("");
        project_name(Some(root), key)
    };

    // Plugins, ranked by total desc then name.
    let mut top_plugins: Vec<PluginUsage> = by_plugin
        .into_iter()
        .map(|(plugin, a)| PluginUsage {
            plugin,
            marketplace: a.marketplace,
            installed: a.installed,
            total: a.total,
            skill_count: a.skill,
            agent_count: a.agent,
            command_count: a.command,
        })
        .collect();
    top_plugins.sort_by(|a, b| b.total.cmp(&a.total).then(a.plugin.cmp(&b.plugin)));

    // Installed plugins with no usage in the window.
    let used: BTreeSet<&str> = top_plugins.iter().map(|p| p.plugin.as_str()).collect();
    let mut unused_plugins: Vec<String> = plugins
        .iter()
        .map(|p| p.plugin.clone())
        .filter(|p| !used.contains(p.as_str()))
        .collect();
    unused_plugins.sort();
    unused_plugins.dedup();

    // Skills, ranked by total count desc; per-project breakdown ranked by count.
    let mut skills: Vec<SkillUsage> = by_skill
        .into_iter()
        .map(|(skill, projects)| {
            let plugin = skill
                .split_once(':')
                .map(|(p, _)| p.to_string())
                .unwrap_or_default();
            let count = projects.values().map(|c| c.count).sum();
            let mut projects: Vec<ProjectUsage> = projects
                .into_iter()
                .map(|(key, c)| ProjectUsage {
                    project: display_of(&key),
                    path: path_of(&key),
                    count: c.count,
                    dates: c.days.into_iter().collect(),
                })
                .collect();
            projects.sort_by(|a, b| b.count.cmp(&a.count).then(a.project.cmp(&b.project)));
            SkillUsage {
                skill,
                plugin,
                count,
                projects,
            }
        })
        .collect();
    skills.sort_by(|a, b| b.count.cmp(&a.count).then(a.skill.cmp(&b.skill)));

    // Projects, ranked by total desc; per-skill breakdown ranked by count.
    let mut projects: Vec<ProjectAggregate> = by_project
        .into_iter()
        .map(|(key, sk)| {
            let total = sk.values().map(|c| c.count).sum();
            let mut lines: Vec<ProjectSkillLine> = sk
                .into_iter()
                .map(|(skill, c)| ProjectSkillLine {
                    skill,
                    count: c.count,
                    dates: c.days.into_iter().collect(),
                })
                .collect();
            lines.sort_by(|a, b| b.count.cmp(&a.count).then(a.skill.cmp(&b.skill)));
            ProjectAggregate {
                project: display_of(&key),
                path: path_of(&key),
                total,
                skills: lines,
            }
        })
        .collect();
    projects.sort_by(|a, b| b.total.cmp(&a.total).then(a.project.cmp(&b.project)));

    UsageReport {
        from: from.to_string(),
        to: to.to_string(),
        generated_at: now_iso(),
        total_events,
        top_plugins,
        unused_plugins,
        skills,
        projects,
    }
}

// ============================================================
// Public entry points (called from the Tauri command layer)
// ============================================================

/// Build the usage report for the `[from, to]` window. Refreshes the on-disk
/// index (re-parsing only changed transcripts) as a side effect.
pub fn build_report(from: &str, to: &str) -> Result<UsageReport> {
    // Serialize the cache refresh+persist: the dashboard (all-time), the audit
    // page (windowed) and the export can each call this on their own blocking
    // thread, and they would otherwise race on the shared index temp file.
    // Poison-safe: a panic elsewhere shouldn't wedge the audit forever.
    let events = {
        let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let index = load_index();
        let (events, index) = refresh_events(index);
        if let Err(e) = save_index(&index) {
            // A cache-write failure must not fail the audit — the report is
            // already computed from the in-memory events.
            tracing::warn!("usage audit: could not persist index: {e}");
        }
        events
    };
    Ok(aggregate(&events, from, to))
}

/// Build the report for `[from, to]` and write it as a multi-sheet `.xlsx` to
/// `path`. Returns `path`.
pub fn export_xlsx(path: &str, from: &str, to: &str) -> Result<String> {
    use rust_xlsxwriter::{Format, Workbook};

    let report = build_report(from, to)?;
    let mut wb = Workbook::new();
    let bold = Format::new().set_bold();

    let short = |iso: &str, fallback: &str| -> String {
        if iso.trim().is_empty() {
            fallback.to_string()
        } else {
            day_of(iso)
        }
    };

    // --- Sheet 1: Récapitulatif ---
    {
        let sheet = wb
            .add_worksheet()
            .set_name("Récapitulatif")
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(0, 0, "Audit d'utilisation — récapitulatif", &bold)
            .map_err(xlsx_err)?;
        let top_plugin = report
            .top_plugins
            .first()
            .map(|p| format!("{} ({})", p.plugin, p.total))
            .unwrap_or_else(|| "—".into());
        let top_skill = report
            .skills
            .first()
            .map(|s| format!("{} ({})", s.skill, s.count))
            .unwrap_or_else(|| "—".into());
        let rows: [(&str, String); 10] = [
            ("Date d'export", short(&report.generated_at, "—")),
            ("Période — du", short(&report.from, "(début de l'historique)")),
            ("Période — au", short(&report.to, "(maintenant)")),
            ("Invocations totales", report.total_events.to_string()),
            ("Plugins utilisés", report.top_plugins.len().to_string()),
            (
                "Plugins installés non utilisés",
                report.unused_plugins.len().to_string(),
            ),
            ("Skills distincts utilisés", report.skills.len().to_string()),
            ("Projets actifs", report.projects.len().to_string()),
            ("Plugin le plus utilisé", top_plugin),
            ("Skill le plus utilisé", top_skill),
        ];
        for (i, (label, value)) in rows.iter().enumerate() {
            let r = (i + 2) as u32;
            sheet
                .write_string_with_format(r, 0, *label, &bold)
                .map_err(xlsx_err)?;
            sheet.write_string(r, 1, value).map_err(xlsx_err)?;
        }
    }

    // --- Sheet 2: Top plugins ---
    {
        let sheet = wb
            .add_worksheet()
            .set_name("Top plugins")
            .map_err(xlsx_err)?;
        write_headers(
            sheet,
            &bold,
            &[
                "Plugin",
                "Marketplace",
                "Installé",
                "Total",
                "Skills",
                "Agents",
                "Commandes",
            ],
        )?;
        for (i, p) in report.top_plugins.iter().enumerate() {
            let r = (i + 1) as u32;
            sheet.write_string(r, 0, &p.plugin).map_err(xlsx_err)?;
            sheet.write_string(r, 1, &p.marketplace).map_err(xlsx_err)?;
            sheet
                .write_string(r, 2, if p.installed { "oui" } else { "non" })
                .map_err(xlsx_err)?;
            sheet.write_number(r, 3, p.total as f64).map_err(xlsx_err)?;
            sheet
                .write_number(r, 4, p.skill_count as f64)
                .map_err(xlsx_err)?;
            sheet
                .write_number(r, 5, p.agent_count as f64)
                .map_err(xlsx_err)?;
            sheet
                .write_number(r, 6, p.command_count as f64)
                .map_err(xlsx_err)?;
        }
    }

    // --- Sheet 3: Plugins installés non utilisés ---
    {
        let sheet = wb
            .add_worksheet()
            .set_name("Plugins non utilisés")
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(0, 0, "Plugin installé non utilisé", &bold)
            .map_err(xlsx_err)?;
        for (i, p) in report.unused_plugins.iter().enumerate() {
            sheet.write_string((i + 1) as u32, 0, p).map_err(xlsx_err)?;
        }
    }

    // --- Sheet 4: Skills (one row per skill × project, with usage days) ---
    {
        let sheet = wb.add_worksheet().set_name("Skills").map_err(xlsx_err)?;
        write_headers(
            sheet,
            &bold,
            &["Skill", "Plugin", "Projet", "Utilisations", "Dates d'utilisation"],
        )?;
        let mut r = 1u32;
        for s in &report.skills {
            if s.projects.is_empty() {
                sheet.write_string(r, 0, &s.skill).map_err(xlsx_err)?;
                sheet.write_string(r, 1, &s.plugin).map_err(xlsx_err)?;
                sheet.write_number(r, 3, s.count as f64).map_err(xlsx_err)?;
                r += 1;
                continue;
            }
            for proj in &s.projects {
                sheet.write_string(r, 0, &s.skill).map_err(xlsx_err)?;
                sheet.write_string(r, 1, &s.plugin).map_err(xlsx_err)?;
                sheet.write_string(r, 2, &proj.project).map_err(xlsx_err)?;
                sheet
                    .write_number(r, 3, proj.count as f64)
                    .map_err(xlsx_err)?;
                sheet
                    .write_string(r, 4, &proj.dates.join(", "))
                    .map_err(xlsx_err)?;
                r += 1;
            }
        }
    }

    // --- Sheet 5: Utilisation par projet ---
    {
        let sheet = wb
            .add_worksheet()
            .set_name("Utilisation par projet")
            .map_err(xlsx_err)?;
        write_headers(
            sheet,
            &bold,
            &["Projet", "Skill", "Utilisations", "Dates d'utilisation"],
        )?;
        let mut r = 1u32;
        for p in &report.projects {
            for line in &p.skills {
                sheet.write_string(r, 0, &p.project).map_err(xlsx_err)?;
                sheet.write_string(r, 1, &line.skill).map_err(xlsx_err)?;
                sheet
                    .write_number(r, 2, line.count as f64)
                    .map_err(xlsx_err)?;
                sheet
                    .write_string(r, 3, &line.dates.join(", "))
                    .map_err(xlsx_err)?;
                r += 1;
            }
        }
    }

    wb.save(path).map_err(xlsx_err)?;
    // Logged in the "usage_audit.export ok:" shape so it surfaces in the
    // dashboard's "Activité récente" (parsed from the log tail).
    tracing::info!("usage_audit.export ok: {path}");
    Ok(path.to_string())
}

fn write_headers(
    sheet: &mut rust_xlsxwriter::Worksheet,
    bold: &rust_xlsxwriter::Format,
    headers: &[&str],
) -> Result<()> {
    for (c, h) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(0, c as u16, *h, bold)
            .map_err(xlsx_err)?;
    }
    Ok(())
}

fn xlsx_err(e: rust_xlsxwriter::XlsxError) -> Error {
    Error::Other(format!("xlsx: {e}"))
}

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
//! Transcripts are **append-only**, and the one belonging to the session you're
//! in right now changes on every message — under a whole-file re-parse that
//! meant re-reading a multi-MB file on every audit. So each cache entry also
//! records how far it parsed (`parsed_upto`) and a hash of the file's head; when
//! the head still matches and the file only grew, just the new tail is parsed
//! and its events appended. A rewritten or truncated file fails the head check
//! and falls back to a full re-parse.
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
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// Bumped whenever the cached event shape changes (a mismatch drops the cache).
// v2 added `project_path`; v3 added `project_key` (stable project identity);
// v4 added the incremental-parse bookkeeping (`parsed_upto` / head hash).
const INDEX_VERSION: u32 = 4;

/// How many bytes of a file's head are hashed to decide "appended to" vs
/// "rewritten". Large enough that two different transcripts never collide,
/// small enough to be a single cheap read.
const HEAD_SAMPLE: u64 = 64 * 1024;

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
    /// Byte offset just past the last **complete** line parsed. A half-flushed
    /// final line is deliberately left unconsumed so the next pass picks it up
    /// whole.
    #[serde(default)]
    parsed_upto: u64,
    /// Hash of the file's first `head_len` bytes at the time of the last parse.
    #[serde(default)]
    head_hash: u64,
    /// How many bytes `head_hash` covers (`min(size, HEAD_SAMPLE)`).
    #[serde(default)]
    head_len: u64,
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

/// One usage day and how many invocations happened on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    /// `YYYY-MM-DD` (local day).
    pub date: String,
    pub count: u64,
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
    /// Per-day counts (`YYYY-MM-DD` → n), ascending by date. No times.
    pub dates: Vec<DayCount>,
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
    /// Per-day counts (`YYYY-MM-DD` → n), ascending by date.
    pub dates: Vec<DayCount>,
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

/// Could this line possibly hold an invocation? Cheap substring test run before
/// the JSON parse.
///
/// Transcript lines are mostly tool results, file contents and prose — a single
/// line can be hundreds of KB, and allocating a generic `serde_json::Value` for
/// each one is where nearly all of the parse time went. Only a percent or so of
/// lines carry a `Skill`/`Agent` tool_use or a `<command-name>` marker.
///
/// Matched on bare ASCII substrings (no quotes, no angle brackets) so JSON
/// escaping of the delimiters can't cause a false negative — a serializer never
/// escapes plain letters. False positives are harmless: they just get parsed.
fn line_may_hold_event(line: &str) -> bool {
    line.contains("Skill") || line.contains("Agent") || line.contains("command-name")
}

/// Parse a transcript from byte offset `start` up to the end of its last
/// *complete* line. Returns the events found and the new "parsed up to" offset.
/// Malformed lines are skipped.
fn parse_transcript_from(path: &Path, fallback_dir: &str, start: u64) -> (Vec<UsageEvent>, u64) {
    let Ok(mut f) = fs::File::open(path) else {
        return (Vec::new(), start);
    };
    if start > 0 && f.seek(SeekFrom::Start(start)).is_err() {
        return (Vec::new(), start);
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return (Vec::new(), start);
    }
    // Stop at the last newline: anything after it is a line the writer hasn't
    // finished flushing, and consuming it would drop the event it will carry.
    let Some(last_nl) = buf.iter().rposition(|b| *b == b'\n') else {
        return (Vec::new(), start);
    };
    let end = last_nl + 1;
    let text = String::from_utf8_lossy(&buf[..end]);

    let mut events = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || !line_may_hold_event(line) {
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
    (events, start + end as u64)
}

/// Hash of exactly the first `n` bytes of `path`. `None` when the file is
/// shorter than `n` (i.e. it was truncated — the cached tail offset is void).
fn head_hash_of(path: &Path, n: u64) -> Option<u64> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; n as usize];
    f.read_exact(&mut buf).ok()?;
    let mut h = DefaultHasher::new();
    buf.hash(&mut h);
    Some(h.finish())
}

/// Parse a transcript from scratch into a fresh cache entry.
fn full_entry(path: &Path, fallback_dir: &str, mtime: u64, size: u64) -> FileEntry {
    let (events, parsed_upto) = parse_transcript_from(path, fallback_dir, 0);
    let head_len = size.min(HEAD_SAMPLE);
    FileEntry {
        mtime,
        size,
        parsed_upto,
        head_hash: head_hash_of(path, head_len).unwrap_or(0),
        head_len,
        events,
    }
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
    let mut appended = 0usize;

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
            // Untouched since the last audit.
            Some(cached) if cached.mtime == mtime && cached.size == size => {
                reused += 1;
                cached
            }
            // Grew, and its head is byte-identical to what we parsed before —
            // an append. Parse only the tail and keep the events already known.
            // This is the live session's transcript on every audit.
            Some(cached)
                if size >= cached.size
                    && cached.parsed_upto <= size
                    && cached.head_len > 0
                    && head_hash_of(path, cached.head_len) == Some(cached.head_hash) =>
            {
                appended += 1;
                let (mut fresh, upto) =
                    parse_transcript_from(path, &fallback_dir, cached.parsed_upto);
                let mut events = cached.events;
                events.append(&mut fresh);
                FileEntry {
                    mtime,
                    size,
                    parsed_upto: upto,
                    head_hash: cached.head_hash,
                    head_len: cached.head_len,
                    events,
                }
            }
            // New, rewritten or truncated.
            _ => {
                reparsed += 1;
                full_entry(path, &fallback_dir, mtime, size)
            }
        };
        all.extend(file_entry.events.iter().cloned());
        fresh.insert(key, file_entry);
    }

    tracing::info!(
        "usage audit: {} transcripts ({} reparsed, {} tail-only, {} cached), {} events",
        fresh.len(),
        reparsed,
        appended,
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

/// Total invocations across a day→count map.
fn cell_total(days: &BTreeMap<String, u64>) -> u64 {
    days.values().sum()
}

/// A day→count map as an ascending `Vec<DayCount>` (BTreeMap iterates in date
/// order, which is chronological for `YYYY-MM-DD`).
fn to_day_counts(days: BTreeMap<String, u64>) -> Vec<DayCount> {
    days.into_iter()
        .map(|(date, count)| DayCount { date, count })
        .collect()
}

/// `YYYY-MM-DD` → `DD/MM/YYYY` for display; passes through anything unexpected.
fn fmt_date_fr(day: &str) -> String {
    let p: Vec<&str> = day.split('-').collect();
    if p.len() == 3 {
        format!("{}/{}/{}", p[2], p[1], p[0])
    } else {
        day.to_string()
    }
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

    // --- Skill × project → per-day counts ; and its inverse Project × skill ---
    // days: BTreeMap<day, count> keeps days ascending and counts per day.
    type Cell = BTreeMap<String, u64>;
    let mut by_skill: BTreeMap<String, BTreeMap<String, Cell>> = BTreeMap::new();
    let mut by_project: BTreeMap<String, BTreeMap<String, Cell>> = BTreeMap::new();

    for ev in &in_win {
        if ev.kind == UsageKind::Skill {
            let day = day_of(&ev.ts);
            *by_skill
                .entry(ev.name.clone())
                .or_default()
                .entry(ev.project_key.clone())
                .or_default()
                .entry(day.clone())
                .or_insert(0) += 1;
            *by_project
                .entry(ev.project_key.clone())
                .or_default()
                .entry(ev.name.clone())
                .or_default()
                .entry(day)
                .or_insert(0) += 1;
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
            let count = projects.values().map(cell_total).sum();
            let mut projects: Vec<ProjectUsage> = projects
                .into_iter()
                .map(|(key, days)| ProjectUsage {
                    project: display_of(&key),
                    path: path_of(&key),
                    count: cell_total(&days),
                    dates: to_day_counts(days),
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
            let total = sk.values().map(cell_total).sum();
            let mut lines: Vec<ProjectSkillLine> = sk
                .into_iter()
                .map(|(skill, days)| ProjectSkillLine {
                    skill,
                    count: cell_total(&days),
                    dates: to_day_counts(days),
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
///
/// Layout:
/// - **Récapitulatif** — key figures + bar charts (top plugins, top skills) and
///   a pie (plugins used vs unused), backed by small data tables lower down.
/// - **Top plugins**, **Plugins non utilisés** — flat tables.
/// - **Skills**, **Utilisation par projet** — one row *per usage day* (with that
///   day's count), and the grouping columns (Skill/Plugin/Projet) merged
///   vertically across their day rows.
pub fn export_xlsx(path: &str, from: &str, to: &str) -> Result<String> {
    use rust_xlsxwriter::{Format, FormatAlign, Workbook};

    let report = build_report(from, to)?;
    let mut wb = Workbook::new();
    let bold = Format::new().set_bold();
    // Merged grouping cells read best top-left aligned + vertically centered.
    let merged = Format::new()
        .set_align(FormatAlign::Left)
        .set_align(FormatAlign::VerticalCenter)
        .set_text_wrap();
    let date_fmt = Format::new().set_align(FormatAlign::Right);

    write_recap_sheet(&mut wb, &report, &bold)?;

    // --- Top plugins ---
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
        let _ = sheet.set_column_width(0, 30);
        let _ = sheet.set_column_width(1, 22);
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

    // --- Plugins installés non utilisés ---
    {
        let sheet = wb
            .add_worksheet()
            .set_name("Plugins non utilisés")
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(0, 0, "Plugin installé non utilisé", &bold)
            .map_err(xlsx_err)?;
        let _ = sheet.set_column_width(0, 32);
        for (i, p) in report.unused_plugins.iter().enumerate() {
            sheet.write_string((i + 1) as u32, 0, p).map_err(xlsx_err)?;
        }
    }

    // --- Skills: one row per (skill × project × day); Skill/Plugin/Projet merged ---
    {
        let sheet = wb.add_worksheet().set_name("Skills").map_err(xlsx_err)?;
        write_headers(
            sheet,
            &bold,
            &["Skill", "Plugin", "Projet", "Utilisations", "Dates d'utilisation"],
        )?;
        let _ = sheet.set_column_width(0, 34);
        let _ = sheet.set_column_width(1, 18);
        let _ = sheet.set_column_width(2, 22);
        let _ = sheet.set_column_width(3, 12);
        let _ = sheet.set_column_width(4, 16);
        let mut r = 1u32;
        for s in &report.skills {
            let skill_start = r;
            if s.projects.is_empty() {
                sheet.write_number(r, 3, s.count as f64).map_err(xlsx_err)?;
                r += 1;
            } else {
                for proj in &s.projects {
                    let proj_start = r;
                    r = write_day_rows(sheet, r, 3, proj.count, &proj.dates, &date_fmt)?;
                    merge_or_write(sheet, proj_start, r - 1, 2, &proj.project, &merged)?;
                }
            }
            merge_or_write(sheet, skill_start, r - 1, 0, &s.skill, &merged)?;
            merge_or_write(sheet, skill_start, r - 1, 1, &s.plugin, &merged)?;
        }
    }

    // --- Utilisation par projet: one row per (project × skill × day); Projet/Skill merged ---
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
        let _ = sheet.set_column_width(0, 22);
        let _ = sheet.set_column_width(1, 34);
        let _ = sheet.set_column_width(2, 12);
        let _ = sheet.set_column_width(3, 16);
        let mut r = 1u32;
        for p in &report.projects {
            if p.skills.is_empty() {
                continue;
            }
            let proj_start = r;
            for line in &p.skills {
                let skill_start = r;
                r = write_day_rows(sheet, r, 2, line.count, &line.dates, &date_fmt)?;
                merge_or_write(sheet, skill_start, r - 1, 1, &line.skill, &merged)?;
            }
            merge_or_write(sheet, proj_start, r - 1, 0, &p.project, &merged)?;
        }
    }

    wb.save(path).map_err(xlsx_err)?;
    // Logged in the "usage_audit.export ok:" shape so it surfaces in the
    // dashboard's "Activité récente" (parsed from the log tail).
    tracing::info!("usage_audit.export ok: {path}");
    Ok(path.to_string())
}

/// Write one row per usage day (count in `count_col`, `DD/MM/YYYY` in the next
/// column). When `dates` is empty, writes a single fallback row carrying the
/// total `total`. Returns the next free row.
fn write_day_rows(
    sheet: &mut rust_xlsxwriter::Worksheet,
    mut r: u32,
    count_col: u16,
    total: u64,
    dates: &[DayCount],
    date_fmt: &rust_xlsxwriter::Format,
) -> Result<u32> {
    if dates.is_empty() {
        sheet
            .write_number(r, count_col, total as f64)
            .map_err(xlsx_err)?;
        return Ok(r + 1);
    }
    for dc in dates {
        sheet
            .write_number(r, count_col, dc.count as f64)
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(r, count_col + 1, &fmt_date_fr(&dc.date), date_fmt)
            .map_err(xlsx_err)?;
        r += 1;
    }
    Ok(r)
}

/// Merge `[r1..=r2]` in `col` into one cell holding `text`, or write a plain cell
/// when the span is a single row (Excel rejects a 1-cell merge).
fn merge_or_write(
    sheet: &mut rust_xlsxwriter::Worksheet,
    r1: u32,
    r2: u32,
    col: u16,
    text: &str,
    fmt: &rust_xlsxwriter::Format,
) -> Result<()> {
    if r2 > r1 {
        sheet
            .merge_range(r1, col, r2, col, text, fmt)
            .map_err(xlsx_err)?;
    } else {
        sheet
            .write_string_with_format(r1, col, text, fmt)
            .map_err(xlsx_err)?;
    }
    Ok(())
}

/// The Récapitulatif sheet: key figures (col A/B), backing data tables lower
/// down, and native Excel charts (two bars + a pie) anchored to the right.
fn write_recap_sheet(
    wb: &mut rust_xlsxwriter::Workbook,
    report: &UsageReport,
    bold: &rust_xlsxwriter::Format,
) -> Result<()> {
    use rust_xlsxwriter::{Chart, ChartType, Format};

    const SHEET: &str = "Récapitulatif";
    let title = Format::new().set_bold().set_font_size(14);

    let sheet = wb.add_worksheet().set_name(SHEET).map_err(xlsx_err)?;
    let _ = sheet.set_column_width(0, 32);
    let _ = sheet.set_column_width(1, 24);

    sheet
        .write_string_with_format(0, 0, "Audit d'utilisation — récapitulatif", &title)
        .map_err(xlsx_err)?;

    let short = |iso: &str, fallback: &str| -> String {
        if iso.trim().is_empty() {
            fallback.to_string()
        } else {
            fmt_date_fr(&day_of(iso))
        }
    };
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
    let used = report.top_plugins.len();
    let unused = report.unused_plugins.len();
    let kv: [(&str, String); 10] = [
        ("Date d'export", short(&report.generated_at, "—")),
        ("Période — du", short(&report.from, "(début de l'historique)")),
        ("Période — au", short(&report.to, "(maintenant)")),
        ("Invocations totales", report.total_events.to_string()),
        ("Plugins utilisés", used.to_string()),
        ("Plugins installés non utilisés", unused.to_string()),
        ("Skills distincts utilisés", report.skills.len().to_string()),
        ("Projets actifs", report.projects.len().to_string()),
        ("Plugin le plus utilisé", top_plugin),
        ("Skill le plus utilisé", top_skill),
    ];
    for (i, (label, value)) in kv.iter().enumerate() {
        let r = (i + 2) as u32;
        sheet
            .write_string_with_format(r, 0, *label, bold)
            .map_err(xlsx_err)?;
        sheet.write_string(r, 1, value).map_err(xlsx_err)?;
    }

    // Backing data tables (col A/B), below the key figures. Charts reference
    // these ranges. Capped for a readable chart.
    const CAP: usize = 12;
    let mut r = 14u32;

    // Top plugins by invocations.
    let plug_n = report.top_plugins.len().min(CAP) as u32;
    let plug_first = r + 1;
    if plug_n > 0 {
        sheet
            .write_string_with_format(r, 0, "Plugin", bold)
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(r, 1, "Invocations", bold)
            .map_err(xlsx_err)?;
        for (i, p) in report.top_plugins.iter().take(CAP).enumerate() {
            let rr = plug_first + i as u32;
            sheet.write_string(rr, 0, &p.plugin).map_err(xlsx_err)?;
            sheet.write_number(rr, 1, p.total as f64).map_err(xlsx_err)?;
        }
        r = plug_first + plug_n + 1;
    }

    // Top skills by usage.
    let skill_n = report.skills.len().min(CAP) as u32;
    let skill_first = r + 1;
    if skill_n > 0 {
        sheet
            .write_string_with_format(r, 0, "Skill", bold)
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(r, 1, "Utilisations", bold)
            .map_err(xlsx_err)?;
        for (i, s) in report.skills.iter().take(CAP).enumerate() {
            let rr = skill_first + i as u32;
            sheet.write_string(rr, 0, &s.skill).map_err(xlsx_err)?;
            sheet.write_number(rr, 1, s.count as f64).map_err(xlsx_err)?;
        }
        r = skill_first + skill_n + 1;
    }

    // Plugins used vs unused (pie).
    let split_first = r + 1;
    sheet
        .write_string_with_format(r, 0, "Répartition plugins", bold)
        .map_err(xlsx_err)?;
    sheet
        .write_string_with_format(r, 1, "Nombre", bold)
        .map_err(xlsx_err)?;
    sheet
        .write_string(split_first, 0, "Utilisés")
        .map_err(xlsx_err)?;
    sheet
        .write_number(split_first, 1, used as f64)
        .map_err(xlsx_err)?;
    sheet
        .write_string(split_first + 1, 0, "Non utilisés")
        .map_err(xlsx_err)?;
    sheet
        .write_number(split_first + 1, 1, unused as f64)
        .map_err(xlsx_err)?;

    // --- Charts (anchored to the right, cols D+) ---
    if plug_n > 0 {
        let mut chart = Chart::new(ChartType::Bar);
        chart
            .add_series()
            .set_categories((SHEET, plug_first, 0, plug_first + plug_n - 1, 0))
            .set_values((SHEET, plug_first, 1, plug_first + plug_n - 1, 1))
            .set_name("Invocations");
        chart.title().set_name("Top plugins");
        chart.legend().set_hidden();
        sheet.insert_chart(2, 3, &chart).map_err(xlsx_err)?;
    }
    if skill_n > 0 {
        let mut chart = Chart::new(ChartType::Bar);
        chart
            .add_series()
            .set_categories((SHEET, skill_first, 0, skill_first + skill_n - 1, 0))
            .set_values((SHEET, skill_first, 1, skill_first + skill_n - 1, 1))
            .set_name("Utilisations");
        chart.title().set_name("Top skills");
        chart.legend().set_hidden();
        sheet.insert_chart(2, 11, &chart).map_err(xlsx_err)?;
    }
    if used + unused > 0 {
        let mut pie = Chart::new(ChartType::Pie);
        pie.add_series()
            .set_categories((SHEET, split_first, 0, split_first + 1, 0))
            .set_values((SHEET, split_first, 1, split_first + 1, 1));
        pie.title().set_name("Plugins : utilisés vs non utilisés");
        sheet.insert_chart(18, 3, &pie).map_err(xlsx_err)?;
    }

    Ok(())
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

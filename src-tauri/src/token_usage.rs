//! Token consumption — reads `~/.claude/usage/usage.db` and aggregates it by
//! project, month, ISO week, day and session, with the usage limits hit.
//!
//! The database has a **single writer**: the `token-usage.py` hook
//! (`assets/token-usage.py`, managed by `token_hook.rs`). The app opens it
//! read-only and never re-implements ingestion; when it needs the database
//! built or brought up to date (first run, "Actualiser"), it runs that same
//! script's `ingest` command. The schema is a contract with the script:
//!
//! - `messages(msg_key, ts_utc, session_id, project_dir, model, is_sidechain,
//!   input, output, cache_write, cache_read)` — one row per API call;
//! - `limits(entry_uuid, ts_utc, session_id, project_dir, text)`;
//! - `projects(project_dir, cwd)`, `sessions(session_id, title)`;
//! - `files(path, size, mtime)` — the script's incremental bookkeeping.
//!
//! "Output + cache écrit" is the figure used to compare projects and periods:
//! cache reads dominate the raw volume but weigh far less in the quota.

use crate::config;
use crate::error::{Error, Result};
use crate::token_hook::{self, HookStatus};
use chrono::{DateTime, Datelike, Local};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Sessions sent to the UI; exports carry them all.
const UI_SESSION_CAP: usize = 300;

// One app-triggered ingestion at a time: two script runs would contend for the
// SQLite write lock and the second would only redo the first one's work.
static INGEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn usage_dir() -> PathBuf {
    config::claude_home().join("usage")
}

pub fn db_path() -> PathBuf {
    usage_dir().join("usage.db")
}

fn open_readonly() -> Result<Connection> {
    let path = db_path();
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| sql_err(&format!("ouverture de {}", path.display()), e))?;
    // The hook may be writing at the same moment (a session just ended).
    conn.busy_timeout(Duration::from_secs(30))
        .map_err(|e| sql_err("busy_timeout", e))?;
    Ok(conn)
}

fn sql_err(context: &str, e: rusqlite::Error) -> Error {
    Error::Other(format!("usage.db ({context}) : {e}"))
}

// ============================================================
// Status
// ============================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageStatus {
    pub usage_dir_exists: bool,
    pub db_exists: bool,
    pub db_path: String,
    pub message_count: Option<u64>,
    pub last_message_at: Option<String>,
    /// Set when the file exists but could not be read.
    pub db_error: Option<String>,
    pub hook: HookStatus,
}

pub fn status() -> Result<TokenUsageStatus> {
    let hook = token_hook::detect()?;
    let path = db_path();
    let db_exists = path.is_file();
    let (mut message_count, mut last_message_at, mut db_error) = (None, None, None);
    if db_exists {
        let read = open_readonly().and_then(|conn| {
            conn.query_row("SELECT COUNT(*), MAX(ts_utc) FROM messages", [], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| sql_err("comptage", e))
        });
        match read {
            Ok((count, last)) => {
                message_count = Some(count.max(0) as u64);
                last_message_at = last.as_deref().and_then(local).map(|d| fmt_fr(&d));
            }
            Err(e) => db_error = Some(e.to_string()),
        }
    }
    Ok(TokenUsageStatus {
        usage_dir_exists: usage_dir().is_dir(),
        db_exists,
        db_path: path.to_string_lossy().to_string(),
        message_count,
        last_message_at,
        db_error,
        hook,
    })
}

// ============================================================
// Ingestion (delegated to the hook script)
// ============================================================

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestProgress {
    pub done: u64,
    pub total: u64,
}

/// Run `token-usage.py ingest --progress` with the hook's own interpreter.
/// Incremental: the script only re-reads transcripts whose size or mtime moved.
/// Returns the number of files ingested.
pub fn run_ingest(progress: impl Fn(IngestProgress)) -> Result<u64> {
    let _guard = INGEST_LOCK
        .try_lock()
        .map_err(|_| Error::Invalid("Une génération de la base est déjà en cours.".into()))?;
    let (python, script) = token_hook::runnable()?;
    tracing::info!(
        "token_usage.ingest: {} {} ingest",
        python.display(),
        script.display()
    );

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("ingest")
        .arg("--progress")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up for the duration of the run.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| Error::Other(format!("lancement de {} : {e}", python.display())))?;

    let mut last = IngestProgress { done: 0, total: 0 };
    // Everything that is not a progress tick, kept for the error message.
    let mut other: Vec<String> = Vec::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            match parse_progress(&line) {
                Some(p) => {
                    last = p;
                    progress(p);
                }
                None if !line.trim().is_empty() => {
                    other.push(line);
                    if other.len() > 40 {
                        other.remove(0);
                    }
                }
                None => {}
            }
        }
    }
    let status = child
        .wait()
        .map_err(|e| Error::Other(format!("attente du script : {e}")))?;
    if !status.success() {
        let tail = other
            .iter()
            .rev()
            .take(8)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        tracing::warn!("token_usage.ingest failed ({status}): {tail}");
        return Err(Error::Other(format!(
            "Le script token-usage a échoué ({status}).\n{tail}"
        )));
    }
    tracing::info!("token_usage.ingest ok: {} file(s)", last.total);
    Ok(last.total)
}

fn parse_progress(line: &str) -> Option<IngestProgress> {
    let (done, total) = line.trim().split_once('/')?;
    Some(IngestProgress {
        done: done.parse().ok()?,
        total: total.parse().ok()?,
    })
}

// ============================================================
// Dataset: the filtered rows every view and export is built from
// ============================================================

#[derive(Debug, Clone, Default)]
pub struct Filter {
    /// Local calendar days, `YYYY-MM-DD`, inclusive; empty = unbounded.
    pub from: String,
    pub to: String,
    /// Exact project label (as listed in `TokenReport::project_labels`); empty = all.
    pub project: String,
}

impl Filter {
    fn keeps(&self, day: &str, label: &str) -> bool {
        (self.from.is_empty() || day >= self.from.as_str())
            && (self.to.is_empty() || day <= self.to.as_str())
            && (self.project.is_empty() || label == self.project)
    }
}

pub struct Row {
    pub when: DateTime<Local>,
    pub session_id: String,
    pub label: String,
    pub cwd: String,
    pub model: String,
    pub sidechain: bool,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitEvent {
    #[serde(skip)]
    pub when: Option<DateTime<Local>>,
    /// `DD/MM/YYYY HH:MM`, local.
    pub at: String,
    pub label: String,
    pub session_id: String,
    pub title: String,
    pub text: String,
}

pub struct Dataset {
    pub rows: Vec<Row>,
    pub limits: Vec<LimitEvent>,
    pub titles: HashMap<String, String>,
    /// Every project label in the database, regardless of the filter.
    pub all_labels: Vec<String>,
}

fn local(ts_utc: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(ts_utc)
        .ok()
        .map(|d| d.with_timezone(&Local))
}

pub fn fmt_fr(d: &DateTime<Local>) -> String {
    d.format("%d/%m/%Y %H:%M").to_string()
}

pub fn day_key(d: &DateTime<Local>) -> String {
    d.format("%Y-%m-%d").to_string()
}

pub fn week_key(d: &DateTime<Local>) -> String {
    let w = d.iso_week();
    format!("{}-S{:02}", w.year(), w.week())
}

pub fn month_key(d: &DateTime<Local>) -> String {
    d.format("%Y-%m").to_string()
}

/// Last two segments of the working directory (`ProjetAnnexe/claude-skillManager`);
/// the encoded `~/.claude/projects` folder name when the cwd is unknown.
fn short_label(project_dir: &str, cwd: Option<&String>) -> String {
    let Some(cwd) = cwd.filter(|c| !c.trim().is_empty()) else {
        return project_dir.to_string();
    };
    let parts: Vec<&str> = cwd
        .trim_end_matches(['\\', '/'])
        .split(['\\', '/'])
        .filter(|p| !p.is_empty())
        .collect();
    let start = parts.len().saturating_sub(2);
    parts[start..].join("/")
}

fn as_u64(v: Option<i64>) -> u64 {
    v.unwrap_or(0).max(0) as u64
}

pub fn load(filter: &Filter) -> Result<Dataset> {
    if !db_path().is_file() {
        return Err(Error::NotFound(format!(
            "{} n'existe pas encore",
            db_path().display()
        )));
    }
    let conn = open_readonly()?;

    let mut cwds: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT project_dir, cwd FROM projects")
            .map_err(|e| sql_err("projects", e))?;
        let it = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| sql_err("projects", e))?;
        for (dir, cwd) in it.flatten() {
            if let Some(cwd) = cwd {
                cwds.insert(dir, cwd);
            }
        }
    }

    let mut titles: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT session_id, title FROM sessions")
            .map_err(|e| sql_err("sessions", e))?;
        let it = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| sql_err("sessions", e))?;
        for (id, title) in it.flatten() {
            titles.insert(id, title.unwrap_or_default());
        }
    }

    let mut labels_seen: HashSet<String> = HashSet::new();
    let mut rows = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT ts_utc, session_id, project_dir, model, is_sidechain, \
                 input, output, cache_write, cache_read FROM messages ORDER BY ts_utc",
            )
            .map_err(|e| sql_err("messages", e))?;
        let it = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                ))
            })
            .map_err(|e| sql_err("messages", e))?;
        for item in it {
            let (ts, session, dir, model, side, inp, out, cw, cr) =
                item.map_err(|e| sql_err("messages", e))?;
            let Some(when) = local(&ts) else { continue };
            let dir = dir.unwrap_or_default();
            let label = short_label(&dir, cwds.get(&dir));
            labels_seen.insert(label.clone());
            if !filter.keeps(&day_key(&when), &label) {
                continue;
            }
            rows.push(Row {
                when,
                session_id: session.unwrap_or_default(),
                cwd: cwds.get(&dir).cloned().unwrap_or_default(),
                label,
                model: model.unwrap_or_default(),
                sidechain: side.unwrap_or(0) != 0,
                input: as_u64(inp),
                output: as_u64(out),
                cache_write: as_u64(cw),
                cache_read: as_u64(cr),
            });
        }
    }

    // One event per (day, project, message): parallel subagents and retries
    // hitting the same limit window would otherwise be counted several times.
    let mut limits = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT ts_utc, session_id, project_dir, text FROM limits ORDER BY ts_utc")
            .map_err(|e| sql_err("limits", e))?;
        let it = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| sql_err("limits", e))?;
        let mut seen: HashSet<(String, String, String)> = HashSet::new();
        for item in it {
            let (ts, session, dir, text) = item.map_err(|e| sql_err("limits", e))?;
            let Some(when) = local(&ts) else { continue };
            let dir = dir.unwrap_or_default();
            let label = short_label(&dir, cwds.get(&dir));
            let day = day_key(&when);
            if !filter.keeps(&day, &label) {
                continue;
            }
            let text = text.unwrap_or_default();
            if !seen.insert((day, label.clone(), text.clone())) {
                continue;
            }
            let session_id = session.unwrap_or_default();
            limits.push(LimitEvent {
                at: fmt_fr(&when),
                when: Some(when),
                title: titles.get(&session_id).cloned().unwrap_or_default(),
                label,
                session_id,
                text,
            });
        }
    }

    let mut all_labels: Vec<String> = labels_seen.into_iter().collect();
    all_labels.sort_by_key(|l| l.to_lowercase());

    Ok(Dataset {
        rows,
        limits,
        titles,
        all_labels,
    })
}

// ============================================================
// Aggregation
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum By {
    Project,
    Month,
    Week,
    Day,
    Session,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBucket {
    /// Month / week / day key, or the session id; empty for `By::Project`.
    pub period: String,
    pub label: String,
    pub calls: u64,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub limits: u64,
    /// `DD/MM/YYYY HH:MM` of the first and last call in the bucket.
    pub start: String,
    pub end: String,
    pub duration_min: i64,
    /// First user prompt, sessions only.
    pub title: String,
    #[serde(skip)]
    pub start_at: Option<DateTime<Local>>,
    #[serde(skip)]
    pub end_at: Option<DateTime<Local>>,
}

impl TokenBucket {
    pub fn weight(&self) -> u64 {
        self.output + self.cache_write
    }
}

fn key_of(by: By, when: &DateTime<Local>, session: &str, label: &str) -> (String, String) {
    let period = match by {
        By::Project => String::new(),
        By::Month => month_key(when),
        By::Week => week_key(when),
        By::Day => day_key(when),
        By::Session => session.to_string(),
    };
    (period, label.to_string())
}

pub fn aggregate(data: &Dataset, by: By) -> Vec<TokenBucket> {
    let mut buckets: HashMap<(String, String), TokenBucket> = HashMap::new();
    for r in &data.rows {
        let key = key_of(by, &r.when, &r.session_id, &r.label);
        let b = buckets.entry(key.clone()).or_insert_with(|| TokenBucket {
            period: key.0.clone(),
            label: key.1.clone(),
            calls: 0,
            input: 0,
            output: 0,
            cache_write: 0,
            cache_read: 0,
            limits: 0,
            start: String::new(),
            end: String::new(),
            duration_min: 0,
            title: String::new(),
            start_at: Some(r.when),
            end_at: Some(r.when),
        });
        b.calls += 1;
        b.input += r.input;
        b.output += r.output;
        b.cache_write += r.cache_write;
        b.cache_read += r.cache_read;
        // Rows arrive ordered by timestamp.
        b.end_at = Some(r.when);
    }
    for ev in &data.limits {
        let Some(when) = ev.when else { continue };
        let key = key_of(by, &when, &ev.session_id, &ev.label);
        if let Some(b) = buckets.get_mut(&key) {
            b.limits += 1;
        }
    }

    let mut items: Vec<TokenBucket> = buckets.into_values().collect();
    for b in &mut items {
        if let (Some(s), Some(e)) = (b.start_at, b.end_at) {
            b.start = fmt_fr(&s);
            b.end = fmt_fr(&e);
            b.duration_min = (e - s).num_minutes();
        }
        if by == By::Session {
            b.title = data.titles.get(&b.period).cloned().unwrap_or_default();
        }
    }
    match by {
        By::Session => items.sort_by(|a, b| b.start_at.cmp(&a.start_at)),
        By::Project => items.sort_by(|a, b| b.weight().cmp(&a.weight())),
        _ => items.sort_by(|a, b| {
            b.period
                .cmp(&a.period)
                .then_with(|| b.weight().cmp(&a.weight()))
        }),
    }
    items
}

// ============================================================
// Report (the tab's payload)
// ============================================================

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub calls: u64,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenReport {
    pub generated_at: String,
    /// First and last call within the filter, `DD/MM/YYYY HH:MM`.
    pub first_at: Option<String>,
    pub last_at: Option<String>,
    pub totals: Totals,
    pub session_count: u64,
    /// `YYYY-MM` of today, and "output + cache écrit" within it.
    pub current_month: String,
    pub current_month_weight: u64,
    pub projects: Vec<TokenBucket>,
    pub months: Vec<TokenBucket>,
    pub weeks: Vec<TokenBucket>,
    pub days: Vec<TokenBucket>,
    /// Newest first, capped at `UI_SESSION_CAP`; `sessions_total` is the full count.
    pub sessions: Vec<TokenBucket>,
    pub sessions_total: u64,
    pub limits: Vec<LimitEvent>,
    pub project_labels: Vec<String>,
}

pub fn totals(data: &Dataset) -> Totals {
    data.rows.iter().fold(Totals::default(), |mut t, r| {
        t.calls += 1;
        t.input += r.input;
        t.output += r.output;
        t.cache_write += r.cache_write;
        t.cache_read += r.cache_read;
        t
    })
}

pub fn report(filter: &Filter) -> Result<TokenReport> {
    let data = load(filter)?;
    let now = Local::now();
    let current_month = month_key(&now);
    let current_month_weight = data
        .rows
        .iter()
        .filter(|r| month_key(&r.when) == current_month)
        .map(|r| r.output + r.cache_write)
        .sum();
    let session_count = data
        .rows
        .iter()
        .map(|r| r.session_id.as_str())
        .collect::<HashSet<_>>()
        .len() as u64;

    let mut sessions = aggregate(&data, By::Session);
    let sessions_total = sessions.len() as u64;
    sessions.truncate(UI_SESSION_CAP);
    let mut limits = data.limits.clone();
    limits.reverse();

    Ok(TokenReport {
        generated_at: fmt_fr(&now),
        first_at: data.rows.first().map(|r| fmt_fr(&r.when)),
        last_at: data.rows.last().map(|r| fmt_fr(&r.when)),
        totals: totals(&data),
        session_count,
        current_month,
        current_month_weight,
        projects: aggregate(&data, By::Project),
        months: aggregate(&data, By::Month),
        weeks: aggregate(&data, By::Week),
        days: aggregate(&data, By::Day),
        sessions,
        sessions_total,
        limits,
        project_labels: data.all_labels.clone(),
    })
}

/// Compact token count: `1.2k`, `3.4M`, `1.05G`.
pub fn fmt_tokens(n: u64) -> String {
    let f = n as f64;
    if n >= 1_000_000_000 {
        format!("{:.2}G", f / 1e9)
    } else if n >= 1_000_000 {
        format!("{:.1}M", f / 1e6)
    } else if n >= 1_000 {
        format!("{:.1}k", f / 1e3)
    } else {
        n.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_keeps_last_two_segments() {
        let cwd = r"C:\DEV\ProjetAnnexe\claude-skillManager\".to_string();
        assert_eq!(
            short_label("c--DEV", Some(&cwd)),
            "ProjetAnnexe/claude-skillManager"
        );
        assert_eq!(short_label("c--DEV", None), "c--DEV");
    }

    #[test]
    fn progress_lines() {
        assert_eq!(parse_progress("3/10").map(|p| (p.done, p.total)), Some((3, 10)));
        assert!(parse_progress("12 fichier(s) ingere(s).").is_none());
    }

    #[test]
    fn compact_numbers() {
        assert_eq!(fmt_tokens(999), "999");
        assert_eq!(fmt_tokens(1_500), "1.5k");
        assert_eq!(fmt_tokens(2_340_000), "2.3M");
    }
}

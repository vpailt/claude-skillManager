//! Application logging.
//!
//! - Writes to `<exe_dir>/logs/skillmanager.YYYY-MM-DD.log` via `tracing-appender`.
//! - Mirrors to stderr at INFO+ (always — even when file logging is disabled,
//!   so panics and bootstrap errors still surface).
//! - Configuration lives in `config/logging.properties`. Changes from the UI
//!   are persisted immediately; the file appender rolls daily and old files
//!   beyond `max_file_count` are pruned at startup and on demand.
//!
//! We use the `tracing` macros (`info!`, `warn!`, `error!`, `debug!`,
//! `trace!`) everywhere so a single subscriber drives the whole pipeline.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

use crate::config;

const LOG_PREFIX: &str = "skillmanager";

/// Workers must stay alive for log writes to flush. Stored here for the
/// process lifetime.
static GUARDS: OnceLock<Mutex<Vec<WorkerGuard>>> = OnceLock::new();

fn guards() -> &'static Mutex<Vec<WorkerGuard>> {
    GUARDS.get_or_init(|| Mutex::new(Vec::new()))
}

fn level_filter(level: &str) -> EnvFilter {
    let level = level.to_ascii_uppercase();
    let level = match level.as_str() {
        "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE" => level,
        _ => "INFO".to_string(),
    };
    // Only our own crate and the frontend bridge, to keep deps quiet at TRACE.
    //
    // `frontend` has to be named explicitly: `logging_log` emits under that
    // target, so a filter naming `skillmanager_lib` alone dropped every line the
    // React side sent — the file logging that `lib/logger.ts` exists to provide
    // recorded nothing at all. Diagnosing a refresh loop meant guessing at which
    // event drove it, because the one log line that says so never arrived.
    // `api` is the third target that must be named: forge calls are logged
    // under it (see `github_client::trace_call`) so the Logs page can tell an
    // HTTP round trip from everything else without matching on message text. A
    // filter naming only the crate would drop every one of them.
    EnvFilter::try_new(format!(
        "skillmanager_lib={level},frontend={level},api={level}"
    ))
    .unwrap_or_else(|_| EnvFilter::new("skillmanager_lib=info,frontend=info,api=info"))
}

/// Initialise the global subscriber. Safe to call exactly once (during
/// `lib::run` boot). Subsequent calls are no-ops.
pub fn init() {
    static INIT: OnceLock<()> = OnceLock::new();
    if INIT.get().is_some() {
        return;
    }

    let cfg = config::load_logging_config();
    let logs_dir = config::logs_dir();
    prune_old_logs(&logs_dir, cfg.max_file_count);

    if cfg.enabled {
        let file_appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(LOG_PREFIX)
            .filename_suffix("log")
            .build(&logs_dir)
            .unwrap_or_else(|_| tracing_appender::rolling::daily(&logs_dir, LOG_PREFIX));
        let (nb, guard) = tracing_appender::non_blocking(file_appender);
        guards().lock().push(guard);

        let _ = tracing_subscriber::fmt()
            .with_env_filter(level_filter(&cfg.level))
            .with_ansi(false)
            .with_target(true)
            .with_writer(nb)
            .try_init();
    } else {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(EnvFilter::new("skillmanager_lib=warn,frontend=warn"))
            .with_ansi(false)
            .with_target(false)
            .with_writer(std::io::stderr)
            .try_init();
    }

    INIT.set(()).ok();
    tracing::info!(
        "logger initialised: enabled={} level={} dir={}",
        cfg.enabled,
        cfg.level,
        logs_dir.display()
    );
}

/// Remove all log files matching our prefix. Returns the count removed.
pub fn purge() -> std::io::Result<usize> {
    let dir = config::logs_dir();
    let mut removed = 0;
    if !dir.is_dir() {
        return Ok(0);
    }
    for entry in fs::read_dir(&dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_our_log_file(&path) {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(e) => {
                // The currently-open log file is locked on Windows; truncate it instead.
                if let Ok(f) = fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(&path)
                {
                    drop(f);
                    removed += 1;
                } else {
                    tracing::warn!("could not remove log file {}: {}", path.display(), e);
                }
            }
        }
    }
    tracing::info!("purged {} log file(s) in {}", removed, dir.display());
    Ok(removed)
}

/// Tail the most recently-modified log file for the in-app log viewer.
pub fn tail(max_bytes: usize) -> std::io::Result<String> {
    let dir = config::logs_dir();
    let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !is_our_log_file(&path) {
                continue;
            }
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if newest.as_ref().map(|(_, t)| mtime > *t).unwrap_or(true) {
                newest = Some((path, mtime));
            }
        }
    }
    let Some((path, _)) = newest else {
        return Ok(String::new());
    };
    let bytes = fs::read(&path)?;
    let start = bytes.len().saturating_sub(max_bytes);
    let slice = &bytes[start..];
    Ok(String::from_utf8_lossy(slice).into_owned())
}

fn is_our_log_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.starts_with(LOG_PREFIX) && (s.ends_with(".log") || s.contains(".log.")))
        .unwrap_or(false)
}

fn prune_old_logs(dir: &Path, max_count: u32) {
    if max_count == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if !p.is_file() || !is_our_log_file(&p) {
                return None;
            }
            let t = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((p, t))
        })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1)); // newest first
    for (path, _) in files.into_iter().skip(max_count as usize) {
        let _ = fs::remove_file(&path);
    }
}

/// One log file on disk, as the in-app viewer lists them.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    /// File name only — never a path. It is what `read_file` takes back, and
    /// keeping paths out of the round trip is what makes traversal impossible.
    pub name: String,
    pub size: u64,
    /// Epoch milliseconds, so the frontend can render it with `Date`.
    pub modified: i64,
}

/// Every log file we wrote, newest first.
///
/// The viewer needs the list because `tail()` only ever reaches the *current*
/// file: the appender rolls daily, so yesterday's session — the one being asked
/// about, usually — was unreachable from the UI.
pub fn list_files() -> Vec<LogFileInfo> {
    let dir = config::logs_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<(LogFileInfo, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if !p.is_file() || !is_our_log_file(&p) {
                return None;
            }
            let meta = e.metadata().ok()?;
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            let ms = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Some((
                LogFileInfo {
                    name: p.file_name()?.to_str()?.to_string(),
                    size: meta.len(),
                    modified: ms,
                },
                modified,
            ))
        })
        .collect();
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out.into_iter().map(|(info, _)| info).collect()
}

/// Read one log file by name, tailing it at `max_bytes`.
///
/// `name` is resolved against the logs directory and must pass
/// `is_our_log_file`, so a caller cannot walk out of it — the name arrives from
/// the frontend, and `logs_dir().join("../../secrets")` would otherwise be a
/// perfectly ordinary path. An empty name means "the newest one", which is what
/// the viewer opens on.
/// Every log file, oldest first, as one text — the whole journal rather than
/// one day of it.
///
/// The appender rolls daily, so a session anyone asks about usually straddles
/// two files; picking one of them from a dropdown made the reader do the
/// stitching. Files are read newest-first so the budget is spent on recent
/// history, then emitted oldest-first: each file is already chronological and
/// they do not overlap, so concatenating in that order is a sort.
pub fn read_all(max_bytes: usize) -> std::io::Result<String> {
    // `list_files` is newest-first.
    let files = list_files();
    let mut chunks: Vec<String> = Vec::new();
    let mut budget = max_bytes;
    for f in &files {
        if budget == 0 {
            break;
        }
        let text = read_file(&f.name, budget)?;
        budget = budget.saturating_sub(text.len());
        chunks.push(text);
    }
    chunks.reverse();
    let truncated = chunks.len() < files.len() || budget == 0;
    if truncated {
        tracing::debug!(
            "logger: read_all truncated to {} of {} file(s)",
            chunks.len(),
            files.len()
        );
    }
    Ok(chunks.join("\n"))
}

/// Zip every log file into `dest_dir`, and say where it landed.
///
/// Whole files, not the truncated text the page shows: this is what gets
/// attached to a bug report, and a report missing the part before the byte
/// budget is the one that fails to explain anything. The name carries the
/// current time, and an existing file is never overwritten — exporting twice in
/// the same second yields `…-2.zip` rather than silently replacing the first.
pub fn export_zip(dest_dir: &Path) -> crate::error::Result<PathBuf> {
    let files = list_files();
    if files.is_empty() {
        return Err(crate::error::Error::Invalid(
            "aucun fichier de log à exporter".into(),
        ));
    }
    fs::create_dir_all(dest_dir)?;

    let stamp = crate::installer::now_iso()
        .replace(':', "")
        .replace('-', "")
        .replace('.', "-");
    let base = format!("{LOG_PREFIX}-logs-{stamp}");
    let mut dest = dest_dir.join(format!("{base}.zip"));
    let mut n = 2;
    while dest.exists() {
        dest = dest_dir.join(format!("{base}-{n}.zip"));
        n += 1;
    }

    let file = fs::File::create(&dest)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let dir = config::logs_dir();
    let mut written = 0usize;
    for f in &files {
        let path = dir.join(&f.name);
        // A file that vanished under us (rotation, or a manual purge mid-export)
        // is skipped rather than failing the whole archive.
        let Ok(bytes) = fs::read(&path) else {
            tracing::warn!("logger: export skipped unreadable {}", f.name);
            continue;
        };
        zip.start_file(&f.name, opts)?;
        std::io::Write::write_all(&mut zip, &bytes)?;
        written += 1;
    }
    zip.finish()?;
    tracing::info!(
        "logger: exported {} log file(s) to {}",
        written,
        dest.display()
    );
    Ok(dest)
}

pub fn read_file(name: &str, max_bytes: usize) -> std::io::Result<String> {
    if name.is_empty() {
        return tail(max_bytes);
    }
    // A name, not a path: anything with a separator or a parent component is
    // refused outright rather than normalised into something plausible.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid log file name",
        ));
    }
    let path = config::logs_dir().join(name);
    if !path.is_file() || !is_our_log_file(&path) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no such log file",
        ));
    }
    let bytes = fs::read(&path)?;
    let start = bytes.len().saturating_sub(max_bytes);
    Ok(String::from_utf8_lossy(&bytes[start..]).into_owned())
}

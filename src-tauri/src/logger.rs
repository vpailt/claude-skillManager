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
    // Only filter our own crate to keep deps quiet at TRACE.
    EnvFilter::try_new(format!("skillmanager_lib={level}"))
        .unwrap_or_else(|_| EnvFilter::new("skillmanager_lib=info"))
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
            .with_env_filter(EnvFilter::new("skillmanager_lib=warn"))
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

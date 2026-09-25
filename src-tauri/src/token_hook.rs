//! The `token-usage` SessionEnd hook: detection, installation, repair.
//!
//! The hook is a Python script (`assets/token-usage.py`, embedded here) whose
//! only job is to feed `~/.claude/usage/usage.db`; `token_usage.rs` reads that
//! database and builds every report. Python is therefore a prerequisite of the
//! hook, not of the app: without it the tab still reads an existing database.
//!
//! A hook is recognised by a `SessionEnd` command mentioning `token-usage.py`.
//! Its script is ours when its first line carries [`MARKER`]; any other script
//! with that name (typically the older all-in-one version that also rebuilt the
//! HTML/Excel reports on every session end) is reported as `Legacy` and backed
//! up before being replaced.

use crate::config;
use crate::error::{Error, Result};
use crate::plugin_state;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const SCRIPT: &str = include_str!("../assets/token-usage.py");
/// First line of the embedded script. Bump the version in both places when the
/// script changes, so installed copies show up as needing an update.
pub const MARKER: &str = "# skillmanager-token-usage v1";
const SCRIPT_NAME: &str = "token-usage.py";
const HOOK_EVENT: &str = "SessionEnd";
const HOOK_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HookState {
    /// No SessionEnd command references token-usage.py.
    Missing,
    /// Registered, interpreter and script present, script is the current version.
    Installed,
    /// Registered, but the script is not ours or is an older version.
    Legacy,
    /// Registered, but the interpreter or the script is missing on disk.
    Broken,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub state: HookState,
    /// The registered command line, verbatim.
    pub command: Option<String>,
    /// Interpreter and script parsed out of `command`.
    pub python: Option<String>,
    pub script: Option<String>,
    /// Interpreter the app would use to install or run the script, if any.
    pub python_found: Option<String>,
    /// Human-readable explanation of a `Broken` / `Legacy` state.
    pub detail: Option<String>,
}

pub fn script_path() -> PathBuf {
    config::claude_home()
        .join("hooks")
        .join("scripts")
        .join(SCRIPT_NAME)
}

/// Split a command line on whitespace, honouring double quotes. Enough for the
/// commands Claude Code settings hold; no escape sequences.
fn split_command(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in cmd.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn is_our_command(cmd: &str) -> bool {
    cmd.contains(SCRIPT_NAME)
}

/// Every `command` string registered under `hooks.SessionEnd`.
fn session_end_commands(settings: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    let groups = settings
        .get("hooks")
        .and_then(|h| h.get(HOOK_EVENT))
        .and_then(Value::as_array);
    for group in groups.into_iter().flatten() {
        let hooks = group.get("hooks").and_then(Value::as_array);
        for hook in hooks.into_iter().flatten() {
            if let Some(cmd) = hook.get("command").and_then(Value::as_str) {
                out.push(cmd.to_string());
            }
        }
    }
    out
}

fn script_is_current(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|s| s.lines().next().map(str::trim) == Some(MARKER))
        .unwrap_or(false)
}

/// The Microsoft Store alias under `WindowsApps` is a zero-byte stub that opens
/// the Store when Python is not installed: never pick it.
fn usable_interpreter(path: &Path) -> bool {
    path.is_file()
        && !path
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("\\windowsapps\\")
}

/// Locate a Python interpreter without spawning anything: `PATH` first, then the
/// per-user installs of the python.org installer (highest version), then the
/// `py` launcher.
pub fn find_python() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("python.exe");
            if usable_interpreter(&candidate) {
                return Some(candidate);
            }
        }
    }

    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let root = PathBuf::from(local).join("Programs").join("Python");
        let mut versions: Vec<(u32, PathBuf)> = fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                // "Python312" -> 312, so 3.12 sorts above 3.9 (39).
                let digits = name.strip_prefix("Python")?;
                let rank: u32 = digits.parse().ok()?;
                let exe = e.path().join("python.exe");
                exe.is_file().then_some((rank, exe))
            })
            .collect();
        versions.sort_by(|a, b| b.0.cmp(&a.0));
        if let Some((_, exe)) = versions.into_iter().next() {
            return Some(exe);
        }
    }

    let windir = std::env::var_os("WINDIR").map(PathBuf::from)?;
    let launcher = windir.join("py.exe");
    launcher.is_file().then_some(launcher)
}

pub fn detect() -> Result<HookStatus> {
    let settings = plugin_state::read_settings_strict()?;
    let registered = session_end_commands(&settings)
        .into_iter()
        .find(|c| is_our_command(c));
    let python_found = find_python().map(|p| p.to_string_lossy().to_string());

    let Some(command) = registered else {
        return Ok(HookStatus {
            state: HookState::Missing,
            command: None,
            python: None,
            script: None,
            python_found,
            detail: None,
        });
    };

    let parts = split_command(&command);
    let python = parts.first().cloned();
    let script = parts.iter().find(|p| p.ends_with(SCRIPT_NAME)).cloned();

    let (state, detail) = match (&python, &script) {
        (Some(py), _) if !Path::new(py).is_file() => (
            HookState::Broken,
            Some(format!("Interpréteur Python introuvable : {py}")),
        ),
        (_, None) => (
            HookState::Broken,
            Some("Chemin du script absent de la commande du hook".to_string()),
        ),
        (_, Some(s)) if !Path::new(s).is_file() => (
            HookState::Broken,
            Some(format!("Script introuvable : {s}")),
        ),
        (_, Some(s)) if !script_is_current(Path::new(s)) => (
            HookState::Legacy,
            Some(
                "Le script installé n'est pas la version gérée par SkillManager \
                 (il peut encore générer ses propres rapports à chaque fin de session)."
                    .to_string(),
            ),
        ),
        _ => (HookState::Installed, None),
    };

    Ok(HookStatus {
        state,
        command: Some(command),
        python,
        script,
        python_found,
        detail,
    })
}

/// The interpreter and script to run for an app-triggered ingestion: the ones
/// the installed hook uses, so both writers run the same code.
pub fn runnable() -> Result<(PathBuf, PathBuf)> {
    let status = detect()?;
    match (status.state, status.python, status.script) {
        (HookState::Installed, Some(py), Some(script)) => Ok((py.into(), script.into())),
        (HookState::Missing, ..) => Err(Error::Invalid(
            "Le hook token-usage n'est pas installé : installez-le avant de générer la base."
                .into(),
        )),
        _ => Err(Error::Invalid(format!(
            "Le hook token-usage doit être réparé ou mis à jour avant de générer la base{}",
            status.detail.map(|d| format!(" : {d}")).unwrap_or_default()
        ))),
    }
}

fn quote_if_needed(path: &str) -> String {
    if path.contains(' ') {
        format!("\"{path}\"")
    } else {
        path.to_string()
    }
}

/// Write the embedded script and register it as a SessionEnd hook. Idempotent:
/// also serves to update a `Legacy` install and to repair a `Broken` one.
/// Returns the new status.
pub fn install() -> Result<HookStatus> {
    // Parse settings first: a malformed file must stop us before anything is
    // written to disk.
    let mut settings = plugin_state::read_settings_strict()?;
    let current = detect()?;

    let python = current
        .python
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| usable_interpreter(p))
        .or_else(find_python)
        .ok_or_else(|| {
            Error::NotFound(
                "Python est requis pour le hook token-usage et n'a pas été trouvé \
                 (PATH, %LOCALAPPDATA%\\Programs\\Python, py.exe)."
                    .into(),
            )
        })?;

    let script = script_path();
    if let Some(parent) = script.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Ok(existing) = fs::read_to_string(&script) {
        if existing != SCRIPT {
            // Not reproducible from anything we ship: keep it next to the new one.
            let backup = script.with_file_name(format!(
                "{SCRIPT_NAME}.bak-{}",
                chrono::Local::now().format("%Y%m%d-%H%M%S")
            ));
            fs::copy(&script, &backup)?;
            tracing::info!("token_hook: previous script backed up to {}", backup.display());
        }
    }
    let tmp = script.with_extension("py.tmp");
    fs::write(&tmp, SCRIPT)?;
    fs::rename(&tmp, &script)?;

    // Forward slashes for the script, like the existing hooks: it is read by
    // Python, which accepts both, and no shell ever mangles them.
    let script_arg = script.to_string_lossy().replace('\\', "/");
    let command = format!(
        "{} {} hook",
        quote_if_needed(&python.to_string_lossy()),
        quote_if_needed(&script_arg)
    );
    set_session_end_command(&mut settings, &command);
    plugin_state::write_settings(&settings)?;
    tracing::info!("token_hook: installed SessionEnd hook: {command}");

    detect()
}

/// Point the first `token-usage.py` SessionEnd entry at `command` and drop any
/// other one (two entries would ingest twice per session), or append a new
/// group when none exists. Every unrelated hook is left as is.
fn set_session_end_command(settings: &mut Map<String, Value>, command: &str) {
    let hooks = settings
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let groups = hooks
        .as_object_mut()
        .expect("hooks is an object")
        .entry(HOOK_EVENT)
        .or_insert_with(|| Value::Array(Vec::new()));
    if !groups.is_array() {
        *groups = Value::Array(Vec::new());
    }
    let groups = groups.as_array_mut().expect("SessionEnd is an array");

    let mut placed = false;
    for group in groups.iter_mut() {
        let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
            continue;
        };
        list.retain_mut(|hook| {
            let ours = hook
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(is_our_command);
            if !ours {
                return true;
            }
            if placed {
                return false;
            }
            placed = true;
            if let Some(obj) = hook.as_object_mut() {
                obj.insert("type".into(), json!("command"));
                obj.insert("command".into(), json!(command));
                obj.insert("timeout".into(), json!(HOOK_TIMEOUT_SECS));
            }
            true
        });
    }
    groups.retain(|g| {
        g.get("hooks")
            .and_then(Value::as_array)
            .map_or(true, |l| !l.is_empty())
    });

    if !placed {
        groups.push(json!({
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": HOOK_TIMEOUT_SECS,
            }]
        }));
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_honours_quotes() {
        assert_eq!(
            split_command(r#""C:\Program Files\py.exe" C:/a/token-usage.py hook"#),
            vec![r"C:\Program Files\py.exe", "C:/a/token-usage.py", "hook"]
        );
    }

    #[test]
    fn replaces_existing_entry_and_keeps_others() {
        let mut settings: Map<String, Value> = serde_json::from_value(json!({
            "theme": "dark",
            "hooks": { "SessionEnd": [
                { "hooks": [
                    { "type": "command", "command": "old token-usage.py hook", "timeout": 5 },
                    { "type": "command", "command": "other.py" }
                ]},
                { "hooks": [{ "type": "command", "command": "dup token-usage.py hook" }] }
            ]}
        }))
        .unwrap();
        set_session_end_command(&mut settings, "new token-usage.py hook");
        assert_eq!(
            session_end_commands(&settings),
            vec!["new token-usage.py hook", "other.py"]
        );
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["hooks"]["SessionEnd"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn appends_when_missing() {
        let mut settings = Map::new();
        set_session_end_command(&mut settings, "py token-usage.py hook");
        assert_eq!(session_end_commands(&settings), vec!["py token-usage.py hook"]);
    }

    #[test]
    fn embedded_script_carries_marker() {
        assert_eq!(SCRIPT.lines().next(), Some(MARKER));
    }
}


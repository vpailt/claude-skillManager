# skillmanager-token-usage v1
"""Claude Code token usage collector.

Ingests the session transcripts (~/.claude/projects/**/*.jsonl) into a permanent
SQLite database (~/.claude/usage/usage.db), so usage history survives the
transcript cleanup (cleanupPeriodDays). This script only feeds the database:
reports and exports are produced by SkillManager, which reads it.

Installed and kept up to date by SkillManager (src-tauri/assets/token-usage.py).
The schema below is a contract with src-tauri/src/token_usage.rs: change both
together and bump the version marker on the first line.

Usage:
  token-usage.py hook                        SessionEnd hook: ingest the ending session
  token-usage.py ingest [--force] [--progress]
                                             scan every transcript (incremental, idempotent)
"""

import argparse
import json
import re
import sqlite3
import sys
import traceback
from datetime import datetime
from pathlib import Path

CLAUDE_DIR = Path.home() / ".claude"
PROJECTS_DIR = CLAUDE_DIR / "projects"
DATA_DIR = CLAUDE_DIR / "usage"
DB_PATH = DATA_DIR / "usage.db"
ERROR_LOG = DATA_DIR / "errors.log"

LIMIT_TEXT = re.compile(r"hit your .*limit|usage limit", re.IGNORECASE)
# IDE context, system reminders and slash-command wrappers are not the user's words.
INJECTED_TAGS = re.compile(r"<([a-zA-Z_-]+)[^>]*>.*?</\1>", re.DOTALL)

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    msg_key       TEXT PRIMARY KEY,
    ts_utc        TEXT NOT NULL,
    session_id    TEXT,
    project_dir   TEXT,
    model         TEXT,
    is_sidechain  INTEGER,
    input         INTEGER,
    output        INTEGER,
    cache_write   INTEGER,
    cache_read    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts_utc);
CREATE TABLE IF NOT EXISTS limits (
    entry_uuid    TEXT PRIMARY KEY,
    ts_utc        TEXT NOT NULL,
    session_id    TEXT,
    project_dir   TEXT,
    text          TEXT
);
CREATE TABLE IF NOT EXISTS projects (
    project_dir   TEXT PRIMARY KEY,
    cwd           TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    title         TEXT
);
CREATE TABLE IF NOT EXISTS files (
    path          TEXT PRIMARY KEY,
    size          INTEGER,
    mtime         REAL
);
"""


def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.executescript(SCHEMA)
    return conn


def log_error(context):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(ERROR_LOG, "a", encoding="utf-8") as log:
        log.write(f"--- {datetime.now().isoformat()} {context}\n{traceback.format_exc()}\n")


def project_dir_of(path):
    """Top-level folder under ~/.claude/projects: one per working directory."""
    try:
        return path.relative_to(PROJECTS_DIR).parts[0]
    except ValueError:
        return path.parent.name


def entry_text(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(c.get("text", "") for c in content
                        if isinstance(c, dict) and c.get("type") == "text")
    return ""


def prompt_title(message):
    text = INJECTED_TAGS.sub(" ", entry_text(message))
    text = " ".join(text.split())
    return text[:100]


def ingest_file(conn, path):
    project_dir = project_dir_of(path)
    messages, limits = [], []
    cwd = None
    title = None
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            wants_title = title is None and '"type":"user"' in line
            # Cheap pre-filter: most lines are tool results without usage data.
            if '"usage"' not in line and "rate_limit" not in line and not wants_title:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = entry.get("message")
            if not isinstance(message, dict):
                continue
            cwd = cwd or entry.get("cwd")
            ts = entry.get("timestamp")
            session_id = entry.get("sessionId")

            if wants_title and entry.get("type") == "user" and not entry.get("isSidechain"):
                candidate = prompt_title(message)
                if candidate:
                    title = (session_id, candidate)
                continue
            if not ts:
                continue

            is_limit = entry.get("error") == "rate_limit" or (
                message.get("model") == "<synthetic>" and LIMIT_TEXT.search(entry_text(message))
            )
            if is_limit:
                limits.append((entry.get("uuid") or f"{path}:{ts}", ts, session_id,
                               project_dir, entry_text(message)[:300]))
                continue

            usage = message.get("usage")
            if not isinstance(usage, dict) or message.get("model") == "<synthetic>":
                continue
            # One API call is written as several lines (one per content block)
            # carrying the same message id and usage: the key deduplicates them.
            key = message.get("id") or entry.get("uuid")
            messages.append((
                key, ts, session_id, project_dir, message.get("model"),
                1 if entry.get("isSidechain") else 0,
                usage.get("input_tokens") or 0,
                usage.get("output_tokens") or 0,
                usage.get("cache_creation_input_tokens") or 0,
                usage.get("cache_read_input_tokens") or 0,
            ))

    conn.executemany("INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)", messages)
    conn.executemany("INSERT OR IGNORE INTO limits VALUES (?,?,?,?,?)", limits)
    if cwd:
        conn.execute("INSERT OR IGNORE INTO projects VALUES (?,?)", (project_dir, cwd))
    if title and title[0]:
        conn.execute("INSERT OR IGNORE INTO sessions VALUES (?,?)", title)
    stat = path.stat()
    conn.execute("INSERT OR REPLACE INTO files VALUES (?,?,?)",
                 (str(path), stat.st_size, stat.st_mtime))


def ingest_all(conn, force=False, progress=False):
    known = {} if force else {
        row[0]: (row[1], row[2]) for row in conn.execute("SELECT path, size, mtime FROM files")}
    pending = []
    for path in PROJECTS_DIR.rglob("*.jsonl"):
        stat = path.stat()
        if known.get(str(path)) != (stat.st_size, stat.st_mtime):
            pending.append(path)
    total = len(pending)
    if progress:
        # Read by SkillManager to drive its progress bar: one "done/total" per line.
        print(f"0/{total}", file=sys.stderr, flush=True)
    for done, path in enumerate(pending, start=1):
        ingest_file(conn, path)
        if progress:
            print(f"{done}/{total}", file=sys.stderr, flush=True)
    conn.commit()
    return total


def run_hook():
    """SessionEnd hook: ingest the ending session and its subagents.

    Never fails the session: errors are logged to ~/.claude/usage/errors.log.
    """
    try:
        # Raw bytes: sys.stdin decodes with the Windows ANSI code page, which would
        # garble accented paths, and a PowerShell pipe prepends a UTF-8 BOM.
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        transcript = Path(payload["transcript_path"])
        conn = connect()
        if transcript.exists():
            ingest_file(conn, transcript)
        subagents = transcript.with_suffix("") / "subagents"
        if subagents.is_dir():
            for path in subagents.rglob("*.jsonl"):
                ingest_file(conn, path)
        conn.commit()
        conn.close()
    except Exception:
        log_error("hook")


def main():
    parser = argparse.ArgumentParser(description="Collecte de la consommation de tokens Claude Code")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("hook")
    ingest = sub.add_parser("ingest")
    ingest.add_argument("--force", action="store_true", help="relire tous les fichiers")
    ingest.add_argument("--progress", action="store_true", help="avancement sur stderr")
    args = parser.parse_args()

    if args.command == "hook":
        run_hook()
        return

    conn = connect()
    try:
        scanned = ingest_all(conn, force=args.force, progress=args.progress)
    finally:
        conn.close()
    print(f"{scanned} fichier(s) ingere(s).", file=sys.stderr)


if __name__ == "__main__":
    main()

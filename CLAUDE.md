# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build / run

From the project root:
```pwsh
.\build.ps1 -Dev          # hot-reload dev (Vite + Tauri)
.\build.ps1 -NoBundle     # just the .exe (~5 min cold, cached after)
.\build.ps1               # .exe + NSIS installer
```

`build.ps1` locates Rust (`%USERPROFILE%\.cargo\bin\cargo.exe`) and the MSVC linker
(`vcvarsall.bat` from VS 2022 BuildTools), runs `npm install` if `node_modules/`
is missing, then drives `npm run build` + `npm run tauri build`. Output:
`src-tauri\target\release\skillmanager.exe`.

There is no test suite, no linter, no formatter configured. Don't add one without asking.

## Releasing a new version ("build & push")

When asked to ship a change ("build & push", "fais une nouvelle version", "same as
last time"), run this exact cycle:

1. **Stop the running app** — the running `skillmanager.exe` locks the output file, so
   the build fails with `Accès refusé (os error 5)` if it's open. Kill it first:
   `Get-Process skillmanager -ErrorAction SilentlyContinue | Stop-Process -Force`.
2. **Bump the version** (patch for fixes/small features) in **three** files, kept in
   lockstep: `package.json`, `src-tauri/Cargo.toml` (`[package] version`), and
   `src-tauri/tauri.conf.json`. `src-tauri/Cargo.lock` updates itself on build.
3. **Build**: `.\build.ps1 -NoBundle` (call it by absolute path —
   `& "c:\DEV\ProjetAnnexe\claude-skillManager\build.ps1" -NoBundle` — the PowerShell
   working dir sometimes drifts). Frontend-only changes still need this (it rebundles
   into the exe); a quick `npx tsc -b` / `cargo check` is a faster pre-flight.
4. **Commit on `main`** (this is a solo repo; history is linear, no PR). French message
   `vX.Y.Z: <résumé>` + a body, ending with the `Co-Authored-By:` trailer.
5. **Push** `origin main` — only with a fresh, explicit user go-ahead for *this* round
   (the auto-mode classifier blocks an unprompted push to the default branch).

Defaults that ship by default (changed from the originals): PR-status polling
(`polling.enabled`) and a new marketplace's `autoUpdate` are both ON; marketplace PR
tracking auto-enables on forge push rights (`can_push`), not the `track_prs` flag.

## Hard constraint: standalone .exe, no runtime deps

The shipped artifact is `src-tauri\target\release\skillmanager.exe` and it must run on a
machine with **no Python, no git, no gh CLI, no Claude CLI, no Rust, no Node**. All
operations on GitHub go through `reqwest` against the REST API. All filesystem mutations
on the Claude install go through Rust stdlib + `walkdir`/`zip`. Never add a code path
that shells out to `git`/`gh`/`claude`, and never add a runtime dep that the Tauri
bundler can't pack into the single .exe.

`Cargo.toml`'s release profile (`opt-level = "s"`, `lto = true`, `codegen-units = 1`,
`strip = true`, `panic = "abort"`) is tuned for binary size — keep it that way.
`reqwest` uses `rustls-tls` (no OpenSSL dep). If you add a crate, prefer ones that
are pure-Rust and don't pull in C libraries.

## Mental model

The app is a GUI over **Claude Code's plugin install state**. Every important file it reads/writes lives under `%USERPROFILE%\.claude\`:

| File | Purpose | Module |
|---|---|---|
| `~/.claude/plugins/installed_plugins.json` | per-plugin install records | `installer.rs` |
| `~/.claude/plugins/known_marketplaces.json` | registered marketplaces (incl. `autoUpdate` flag) | `marketplace_installer.rs` |
| `~/.claude/plugins/cache/<mp>/<plugin>/<version>/` | actual extracted plugin contents | `installer.rs` |
| `~/.claude/plugins/marketplaces/<name>/` | extracted marketplace repo | `marketplace_installer.rs` |
| `~/.claude/settings.json` → `enabledPlugins["<plugin>@<marketplace>"]` | enable/disable | `plugin_state.rs` |
| `~/.claude/skills/<name>/` | standalone user skills | `local_scanner.rs` |

### Portable install layout (own files)

The app's own state is **portable** and sits next to `skillmanager.exe` — the
distribution model is "zip the SkillManager directory and move it". `config::exe_dir()`
resolves the directory of the running exe; `config::app_settings_dir()` returns
`<exe_dir>/config`, `config::logs_dir()` returns `<exe_dir>/logs`. Both are created on
first access. In dev (`cargo tauri dev`), `exe_dir` is `src-tauri/target/debug/`, so
config and logs land there.

```
SkillManager/
├── skillmanager.exe
├── config/
│   ├── config.properties      ← token + polling + UI prefs (Java-style key=value)
│   ├── logging.properties     ← logger config (enabled, level, max files)
│   ├── marketplaces.json      ← list of registered marketplaces
│   ├── pr_history.json        ← rolling list of admin-opened PRs
│   └── pending_prs.json       ← PR drafts awaiting merge
└── logs/
    └── skillmanager.YYYY-MM-DD.log
```

The two `.properties` files are hand-editable; restart the app to pick up changes
made outside the Settings page. The properties parser is intentionally minimal
(no multi-line values, no `\uXXXX` escapes) — see `properties.rs`.

On first run, if a legacy `%APPDATA%/SkillManager/settings.json` is found and the
portable `config.properties` does not yet exist, the legacy blob is migrated once
(guarded by a `OnceLock` so it never re-runs). Don't reintroduce code paths that
write to `%APPDATA%` — everything goes through `config::app_settings_dir()`.

### Logging

`logger::init()` runs at the top of `lib::run()` and wires `tracing` to a daily
rolling file (`tracing-appender`) under `<exe_dir>/logs/`. The level filter is
scoped to `skillmanager_lib=<LEVEL>` so dependency chatter stays quiet at
DEBUG/TRACE. When `logging.enabled=false`, output drops to stderr at WARN+ only —
do not assume file logging is always on. The `WorkerGuard` returned by the
non-blocking writer is stashed in a static so it lives for the whole process;
forgetting to hold a guard loses the tail of the log on shutdown.

Frontend logs reach the same file via the `logging_log` Tauri command (see
`src/lib/logger.ts`). Use `createLogger("<target>")` rather than `console.*` for
events that should survive a session — `console.*` only lives in devtools.

### Marketplace = index, not container

A marketplace repo holds `.claude-plugin/marketplace.json` listing plugins. **Each plugin's
`source` points to where the plugin actually lives** (almost always a different GitHub
repo). So installing a plugin means: read marketplace.json → resolve plugin's
`source.repo`/`source.ref` → download *that* repo's zipball → extract to the cache path.
Don't conflate "install marketplace" (clone the index) with "install plugin" (fetch the
plugin's own repo). `installer.rs` and `marketplace_installer.rs` are separate for this
reason.

### Refresh flow (the heart of the UI)

The frontend calls a `refresh` Tauri command that:
1. For each marketplace flagged `auto_update` and installed → re-pull only if remote SHA
   differs (`marketplace_installer::auto_update_if_changed`).
2. `local_scanner::build_marketplaces_from_settings(...)` → builds `Marketplace` objects
   from local state, scanning install paths and falling back to directory marketplaces.
3. For each marketplace with a `source_repo` → fetch its registry
   (`marketplace_remote::fetch_marketplace_plugins`) and merge with local install state
   via `merge_local_remote` (sets `latest_version`, `source`, recomputes `InstallState`).
4. For each installed plugin with a GitHub source → fetch its remote skills list and
   merge so the tree shows remote-only skills too.

Network work happens in async Tauri command handlers — the React UI stays responsive via
TanStack Query (`src/hooks/useRefresh.ts`). New network work belongs in the Rust command
layer, not on the UI thread.

### Admin upload (no git binary)

`admin::submit_changes` performs: `POST /git/refs` (create branch) →
`PUT /repos/{owner}/{repo}/contents/<path>` for each file (auto-detects existing blob SHA
so create and update share one path) → `POST /repos/{owner}/{repo}/pulls`. If you add new
admin operations, follow the same Contents-API + PR pattern; never introduce a code path
that requires `git` on the user's machine.

## Module map (only the non-obvious bits)

### Rust backend (`src-tauri/src/`)

- `frontmatter.rs` — minimal YAML-frontmatter parser. Only `name`/`description`/`type`
  are used. If you need richer YAML, weigh that against the binary-size constraint.
- `properties.rs` — minimal Java-style `.properties` parser/serializer used for
  `config.properties` and `logging.properties`. Scalars only; reach for JSON for lists.
- `config.rs` — paths (`exe_dir`, `app_settings_dir`, `logs_dir`), the `Settings` /
  `UiPrefs` / `LoggingConfig` structs, and the load/save split between
  `config.properties` (scalars) and `marketplaces.json` (the list).
- `logger.rs` — boots the `tracing` subscriber against `<exe_dir>/logs/`. `init()` is
  idempotent. `purge()` handles the Windows file-lock case by truncating in place when
  removal fails. `tail()` powers the in-app log viewer.
- `github_client.rs::extract_zipball` — strips the top-level `<repo>-<sha>/` folder
  GitHub adds, and uses the `\\?\` long-path prefix on Windows (via `long_path()`) to
  bypass MAX_PATH. Don't replace with a naive zip extract loop.
- `installer.rs::rmtree_robust` — handles read-only files and long paths on Windows.
  Use this everywhere we delete a plugin/marketplace folder, not `std::fs::remove_dir_all`
  directly.
- `plugin_state.rs` — `~/.claude/settings.json` contains many unrelated keys (hooks,
  theme, etc.); always do a partial update preserving everything else.
- `local_scanner.rs::build_marketplaces_from_settings` — also surfaces "orphan"
  marketplaces (installed locally but missing from app settings) so the user can still
  see/act on them.
- `commands/` — every `#[tauri::command]` handler lives here; register new ones in
  `lib.rs::tauri::generate_handler!`. Wrap meaningful side-effects in
  `tracing::info!` (install/uninstall, PR submission, settings mutations) so they
  appear in the log file users can ship back as a bug report.
- `error.rs` — `AppError` is the single error type returned to the frontend. Wrap new
  failure modes here; don't leak `anyhow::Error` across the FFI boundary.

### React frontend (`src/`)

- `lib/api.ts` — typed wrappers around `invoke()`. Add a new wrapper here whenever you
  add a Tauri command; don't call `invoke()` directly from components.
- `lib/types.ts` — TS mirror of Rust models. Keep field casing consistent
  (`#[serde(rename_all = "camelCase")]` on the Rust side).
- `lib/logger.ts` — `createLogger("<target>")` produces an `{error,warn,info,debug,trace}`
  object that tees to the console **and** the backend log file via `logging_log`. Prefer
  this over `console.*` for anything you'd want in a post-mortem.
- `lib/utils.ts::openExternal` — always go through this for opening URLs; it falls back
  to `window.open` if the Tauri opener plugin is missing a capability.
- `hooks/useRefresh.ts` — TanStack Query bridge for the refresh pipeline; UI components
  consume the resulting query state, not the raw command.
- `hooks/usePrPolling.ts` — gated by `ui.prPollingEnabled` in settings; min interval 15s.
- `stores/ui.ts` — single source of truth for theme/density/sidebar/polling prefs.
  `stores/theme.ts` is a thin re-export alias kept for legacy imports.
- `stores/notifications.ts` — in-app toast queue. The polling hook and Settings page
  push success/error toasts here; `NotificationStack` renders them.
- `pages/` — one file per top-level tab (Overview, Plugins, Skills, Admin, Settings).
- `components/ResizableSplit.tsx` — wraps `react-resizable-panels` with persistent
  layout via `autoSaveId`. Use it for any two-pane page; never grid `[fixed_px]_1fr`
  again — that broke responsiveness on small windows.

## Conventions worth preserving

- All JSON writes that matter go through `installer::atomic_write_json` (write `.tmp`
  then `rename`) — don't write JSON in place. `properties::write_atomic` does the same
  for `.properties` files.
- Timestamps in install records use `installer::now_iso()` (UTC, milliseconds, `Z`
  suffix) to match Claude Code's own format.
- New plugins are auto-enabled on install only if `enabledPlugins` has no existing entry
  (mirrors `/plugin install`).
- Domain types live in `models.rs` + `config.rs` (Rust) and `lib/types.ts` (TS). Keep
  these in lockstep, not scattered.
- `serde` derives use `rename_all = "camelCase"` so the Rust → TS boundary doesn't need
  manual translation.
- App-state files (`config.properties`, `logging.properties`, `marketplaces.json`,
  `pr_history.json`, `pending_prs.json`, `logs/`) sit under `<exe_dir>/`. Never write
  to `%APPDATA%` directly — go through `config::app_settings_dir()` or
  `config::logs_dir()`.
- Backend events worth keeping in a log file use `tracing::info!`/`warn!`/`error!`.
  Frontend events use `createLogger("<target>")` from `lib/logger.ts`. Don't sprinkle
  `println!` or `console.log` in shipped code — they bypass the log file.

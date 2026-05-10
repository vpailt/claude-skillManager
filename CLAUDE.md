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

App's own settings live separately at `%APPDATA%\SkillManager\settings.json` (see
`config::app_settings_dir()`) — token + per-marketplace config. Nothing is written next
to the .exe; that's intentional so the exe stays portable.

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
  `lib.rs::tauri::generate_handler!`.
- `error.rs` — `AppError` is the single error type returned to the frontend. Wrap new
  failure modes here; don't leak `anyhow::Error` across the FFI boundary.

### React frontend (`src/`)

- `lib/api.ts` — typed wrappers around `invoke()`. Add a new wrapper here whenever you
  add a Tauri command; don't call `invoke()` directly from components.
- `lib/types.ts` — TS mirror of Rust models. Keep field casing consistent
  (`#[serde(rename_all = "camelCase")]` on the Rust side).
- `hooks/useRefresh.ts` — TanStack Query bridge for the refresh pipeline; UI components
  consume the resulting query state, not the raw command.
- `stores/` — Zustand for cross-page UI state (theme, current selection). Server state
  belongs in TanStack Query, not Zustand.
- `pages/` — one file per top-level tab (Overview, Plugins, Skills, Admin, Settings).

## Conventions worth preserving

- All JSON writes that matter go through `installer::atomic_write_json` (write `.tmp`
  then `rename`) — don't write JSON in place.
- Timestamps in install records use `installer::now_iso()` (UTC, milliseconds, `Z`
  suffix) to match Claude Code's own format.
- New plugins are auto-enabled on install only if `enabledPlugins` has no existing entry
  (mirrors `/plugin install`).
- Domain types live in `models.rs` (Rust) and `lib/types.ts` (TS). Keep these two files
  in lockstep, not scattered.
- `serde` derives use `rename_all = "camelCase"` so the Rust → TS boundary doesn't need
  manual translation.

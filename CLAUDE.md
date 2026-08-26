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
   `vX.Y.Z: <résumé>` + a body. **No `Co-Authored-By:` trailer and no tool
   attribution** — the repo owner asked for commit messages that carry neither.
5. **Push** `origin main` — only with a fresh, explicit user go-ahead for *this* round
   (the auto-mode classifier blocks an unprompted push to the default branch).

Builds are **Authenticode-signed**: open a SimplySign Desktop session *before*
building or `-Package` stops with an explicit error (the key lives in Certum's cloud
HSM). Note that `tauri build` signs `skillmanager.exe` and then restores the
pre-patch, unsigned binary once bundling ends — only the copy inside the NSIS
installer keeps its signature — so `-Package` re-signs the standalone exe before
zipping it. See `docs/signature-code-windows.md`.

When the round ends in a **published GitHub release**, build with `.uild.ps1 -Package`
and attach **both** assets: the NSIS `…-setup.exe` *and*
`SkillManager_<version>_x64_portable.zip`. The zip is what the in-place self-update
downloads (`app_updater.rs`); a release without it falls back to running the installer —
exactly the uninstall/reinstall experience the in-place path exists to avoid.

Defaults that ship by default (changed from the originals): PR-status polling
(`polling.enabled`) is ON; adding a marketplace (the AddMarketplaceDialog) sets both
`autoUpdate` and `track_prs` ON; and marketplace PR tracking also auto-enables on forge
push rights (`can_push`) even when the `track_prs` flag is off.

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
├── update/                    ← self-update scratch: the freshly downloaded binary,
│                             then the replaced one until the next launch can
│                             delete it (created on demand, swept at startup)
├── config/
│   ├── config.properties      ← token + polling + UI prefs (Java-style key=value)
│   ├── logging.properties     ← logger config (enabled, level, max files)
│   ├── marketplaces.json      ← list of registered marketplaces
│   ├── gitea.json             ← registered Gitea instances (tokens stay in the vault)
│   ├── pr_history.json        ← rolling list of admin-opened PRs
│   ├── pending_prs.json       ← PR drafts awaiting merge
│   ├── skill_baselines.json   ← per-skill-folder sync references (`skill_watch.rs`)
│   ├── skill_new.json         ← skills created locally, not yet pushed
│   ├── skill_deleted.json     ← skills deleted locally, removal not yet pushed
│   └── usage_index.json       ← parsed-transcript cache (`usage_audit.rs`)
└── logs/
    └── skillmanager.YYYY-MM-DD.log
```

**Don't install into a synced folder** (OneDrive, Dropbox, a redirected Desktop).
Every write under `config/` and `logs/` then goes through the cloud filter driver
and schedules an upload — a cost that shows up as system load with nothing
attributable to `skillmanager.exe`. `atomic_write_json` / `properties::write_atomic`
skip byte-identical rewrites specifically to keep this bounded, but the right fix
is to keep the directory out of the sync root.

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

### Tray mode releases the UI

`ui.tray.release.ui` (on by default, alongside `ui.tray.close.to.tray`) makes
closing the window **destroy** it rather than hide it, so its WebView2 processes
go away: ~470 MB resident drops to ~37 MB. `RunEvent::ExitRequested` in
`lib::run` then keeps the process alive on the tray icon alone — it prevents the
exit only when `code.is_none()` (the last window closing), so `AppHandle::exit`
from the tray's Quit item or the self-updater still works. `tray::ensure_main_window`
rebuilds the window from the same `tauri.conf.json` entry, keeping the label
`main` so `capabilities/default.json` still applies.

The consequence for new code: **nothing user-visible may depend on the frontend
being alive.** Background work belongs in Rust — that is why PR polling moved to
`pr_poller.rs`, and why marketplace/plugin detection moved to `catalog_poller.rs`.
Note the trap the latter fell into: a TanStack `refetchInterval` does not merely
slow down when the window goes away, it *stops existing* along with the query.
Before adding a `setInterval` in the frontend, ask whether it
needs to keep running once the window is gone; if it does, it goes in Rust and
reaches the UI through a Tauri event.

### Refresh flow (the heart of the app)

`commands::sweep_remote` is the single pass. It has **two callers** — the `refresh_all`
command and `catalog_poller` — and a process-wide mutex keeps them from overlapping
(step 1 re-extracts marketplace directories in place). It:

1. For each marketplace flagged `auto_update` and installed → re-pull only if remote SHA
   differs (`marketplace_installer::auto_update_if_changed`).
2. `local_scanner::build_marketplaces_from_settings(...)` → builds `Marketplace` objects
   from local state, scanning install paths and falling back to directory marketplaces.
3. For each marketplace with a `source_repo` → fetch its registry
   (`marketplace_remote::fetch_marketplace_plugins`) and merge with local install state
   via `merge_local_remote` (sets `latest_version`, `source`, recomputes `InstallState`).
4. For each installed plugin with a source → **one** recursive git-tree read
   (`github_client::list_tree`) yields the whole repo file list *with every blob's git
   SHA*, plus the commit the ref points at. That single call answers three questions:
   which skills the remote has, what each of them contains, and whether the repo moved
   since install (`Plugin::remote_content_changed`).
5. `feed_skill_watch` hands `skill_watch` both halves — what is on disk, what the remote
   holds — and it settles every folder's `SkillSync` status.

Two invariants worth keeping:

- **A failed remote read is never an empty one.** `fetch_marketplace_plugins` and
  `fetch_plugin_skills` both report whether they actually read anything
  (`remote_ok` / `RemoteSkills::known`). Conflating the two makes every installed
  plugin look removed upstream and every installed skill look like a local addition.
- **Local and remote are matched on `marketplace_remote::skill_key`** — the folder path
  under `skills/`, lowercased — never on `Skill::name`, which is the frontmatter `name:`
  locally and the folder basename remotely. When those diverge the same skill appears
  twice.

Network work happens in the Rust command layer, never on the UI thread. The React side
consumes it via TanStack Query (`src/hooks/useRefresh.ts`), whose interval is now only a
safety net — see `catalog_poller`.

### Admin upload (no git binary)

`admin::submit_changes` performs: `POST /git/refs` (create branch) →
`PUT /repos/{owner}/{repo}/contents/<path>` for each file (auto-detects existing blob SHA
so create and update share one path) → `POST /repos/{owner}/{repo}/pulls`. If you add new
admin operations, follow the same Contents-API + PR pattern; never introduce a code path
that requires `git` on the user's machine.

`admin_drafts::prepare_upload_skills` is the one entry point for skill changes on a
plugin: adds, updates **and whole-skill removals** (`BulkUploadArgs::removals`) in a
single draft, with **one** manifest bump for the batch. Keep it that way — two PRs on
the same plugin repo would both bump the manifest and `detect_conflicts` would flag
them against each other. `prepare_upload_skill` (singular) is a thin wrapper over it,
and `prepare_delete_skill` remains for the one-off delete path.

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
- `github_client.rs` — clients are **pooled** by (provider, host, TLS mode, token):
  building a `reqwest::blocking::Client` spawns an OS thread with its own tokio
  runtime and an empty connection pool, and `refresh_all` builds several per run.
  Read-only JSON GETs go through `get_json_cached`, which adds `If-None-Match` and
  serves the cached body on `304` — it never skips the request, so it cannot go
  stale. Route new read endpoints through it; leave writes on `request()`.
- `installer.rs::rmtree_robust` — handles read-only files and long paths on Windows.
  Use this everywhere we delete a plugin/marketplace folder, not `std::fs::remove_dir_all`
  directly.
- `plugin_state.rs` — `~/.claude/settings.json` contains many unrelated keys (hooks,
  theme, etc.); always do a partial update preserving everything else.
- `pr_poller.rs` — background thread polling open PR statuses, emitting
  `pr-status-changed` and raising the native toast itself when no window was
  visible to show the in-app one. Re-reads settings each tick, so the Settings
  page's toggle/interval take effect without a restart.
- `app_updater.rs` — self-update **in place**, and only on a user gesture:
  downloads the release's portable binary, renames the running `skillmanager.exe`
  into `<exe_dir>/update/` (Windows allows renaming a running image, never
  overwriting it), then renames the new one onto the install slot. Two atomic
  same-volume renames, no installer, no uninstall; the session keeps running the
  old code and the new build takes over at the next launch. `config::exe_path()`
  is cached at startup precisely so post-rename resolutions still name the
  install slot. The NSIS installer is only a fallback (read-only install dir, or
  a release with no portable asset) and even then runs `/S` silent.
  `apply_update` takes a process-wide `try_lock` and refuses (rather than
  queues) a second run: it writes to a fixed scratch path and renames the
  running image aside, so two overlapping runs could delete each other's
  verified binary or rename a half-written one onto the install slot. The
  frontend's own "already installing" flag cannot hold that line — it dies with
  the webview, and tray mode destroys that on every close.
  `download()` streams in 64 KB chunks and reports through `ProgressFn`
  (`(UpdatePhase, downloaded, total)`) — a callback rather than an `AppHandle`,
  so this module keeps no `tauri` dependency. `latest_version` is normalised
  (leading `v` stripped) at the boundary, since it is printed next to
  `CARGO_PKG_VERSION`, which has no prefix. `fetch_releases()` is the separate
  read behind the in-app release-notes panel: `check_for_update` only ever sees
  `/releases/latest`, so the notes of the version you are *running* were
  otherwise unreachable.
- `update_poller.rs` — background thread **checking** on a timer
  (`update.auto.enabled`, `update.auto.interval.hours`). It detects and
  announces; it downloads nothing. Release-only: a no-op in debug builds so it
  never offers to swap a binary into `target/debug`. Emits `app-update-available`
  and raises the native toast itself when no window was visible — once per
  version for the toast, every tick for the event (a window opened later needs
  it). It also keeps the pending release in a static, readable through
  `app_update_available` — the tray destroys the window, and the announcement
  that raised the banner may be hours old; `app_apply_update` clears it once the
  offer has been taken. Dismissal lives in the same place (`app_update_dismiss`)
  for the same reason: a store-only dismissal would come straight back on the
  next window rebuild. `app-update-ready` and `app-update-progress` belong to
  the user-triggered path and are emitted by `commands::app_apply_update`, which
  also calls `notify_staged` — the download outlives the window, so the "restart
  to finish" toast cannot depend on a webview being alive.
- `authenticode.rs` — `WinVerifyTrust` wrapper gating the update path: the
  downloaded binary must carry a valid signature issued to `EXPECTED_SIGNER`, or
  it is deleted and the swap never happens. Chain validity alone would not do —
  any trusted code-signing certificate satisfies it, and those are purchasable.
  Renewing the certificate means updating `EXPECTED_SIGNER` here *and*
  `certificateThumbprint` in `tauri.conf.json`.
- `skill_watch.rs` — owns each skill folder's `SkillSync` status (`synced` /
  `modified` / `new` / `deleted` / `unknown`). **The watcher triggers, the refresh
  decides**: a filesystem event only re-hashes *metadata* (path + size + mtime) and
  moves the folder to `modified` optimistically — no bytes, no network; the sweep
  then settles it exactly by comparing `content_sig` (relative path → git blob SHA)
  against the remote tree. `content_sig` does read bytes, so it is gated behind the
  metadata hash — an unchanged `meta` reuses the cached `sig`, and a steady-state
  sweep reads nothing. `synced_sig` (the last signature confirmed equal to the
  remote) is what keeps the verdict meaningful while the forge is unreachable.
  Changing what any of the three hashes means requires bumping `BASELINE_VERSION`.
  It watches **plugin roots**, not individual skill folders: `<plugin>/skills/<new>/`
  is an event in `<plugin>/skills/`, and watching only the leaves meant additions
  were invisible. A baseline is pruned when its folder leaves the watched set, never
  merely because the directory vanished — that record is the only evidence
  distinguishing "you deleted this" from "never installed here".
  A deletion the app performs itself (`delete_skill_local`) goes through
  `mark_deleted`, which sets the status *and* records the folder in the persisted
  `pending_deleted` set. Both halves are needed: the watcher alone would report a
  vanished folder as `modified` (it hashes an empty tree), and a sweep that could
  not reach the forge produces no `MissingLocal`, so the folder would leave the
  watched set and its baseline would be pruned — losing the deletion for good.
  `mark_synced` (a PR was opened) and `forget_under` (the plugin was removed) are
  the only two things that clear it.
- `catalog_poller.rs` — background thread running `sweep_remote` on a timer
  (`catalog.poll.enabled`, `catalog.poll.interval.minutes`). It exists because the
  frontend's `refetchInterval` is paused while the window is hidden, and in tray mode
  the window is *destroyed* — so upstream detection did not slow down, it stopped.
  Emits `catalog-changed`; raises the native toast itself when no window was visible.
  It deliberately does **not** write the taskbar badge (see `taskbar.rs`).
- `claude_watch.rs` — watches `~/.claude/plugins/` and `~/.claude/` (non-recursively)
  so a `/plugin install` run from a terminal shows up in ~1 s instead of waiting for
  a window focus. Emits `claude-state-changed` and interprets nothing; the sweep does
  that. Keep it non-recursive: `plugins/marketplaces/` is rewritten by our own
  auto-update, and watching it recursively would make the app wake itself.
- `usage_audit.rs` — transcripts are append-only, so a cache entry records how far
  it parsed plus a hash of the file head; a file that only grew is parsed from
  that offset instead of whole. `line_may_hold_event` skips the JSON parse for the
  ~99 % of lines that carry no invocation. Changing the cached shape requires
  bumping `INDEX_VERSION`.
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
- `hooks/useBackendEvents.ts` — debounced bridge from the backend's three "something
  moved" events (`skills-tree-changed`, `claude-state-changed`, `catalog-changed`) to a
  refresh invalidation. The backend detects, the frontend only re-asks.
- `stores/skillSync.ts` + `hooks/useSkillWatch.ts` — mirror of `skill_watch`'s statuses,
  seeded from `skill_sync_list` after each refresh and kept live by `skill-sync-changed`.
  The hook no longer *derives* the watched set: it used to filter on `marketplace.editable`
  (i.e. forge push rights), so detection went dark whenever the VPN dropped. Push rights
  gate the push button, never the detection.
- `hooks/useAppUpdateEvents.ts` + `stores/appUpdate.ts` — the update side of the
  UI. The backend detects, the user decides: `startUpdate()` is the **single**
  implementation behind every "Installer" button (banner and Settings card both
  call it), and it re-checks on the way in rather than trusting an announcement
  that may be hours old. `restartNow()` is next to it. `installing` — not
  `progress` — is what says an install is running: it is set synchronously on
  click, and the `app-update-progress` listener drops events that arrive while
  it is false, since event delivery is not ordered against the command's own
  response and a trailing tick would otherwise freeze the bar.
  `components/UpdateBanner.tsx` is the top bar: one element, three faces, in
  priority order — installing (phase label + progress bar, no dismiss), staged
  (restart button), available (Installer / Notes de version / dismiss).
  Dismissal applies to the "available" face only and hides it outright — the
  sidebar pill covers `staged`, never `available` — so it goes through
  `dismissUpdate()`, which records it in Rust as well as in the store.
  `components/UpdateProgressBar.tsx` is the one rendering of the installing
  state, shared by the banner and the Settings card; keep it that way, the two
  copies it replaced had already drifted. It is deliberately **not** an
  `aria-live` region (ticks arrive every 120 ms) — the named `role="progressbar"`
  plus `aria-valuetext` is what carries the value. `App.tsx` is a flex
  **column** for the bar, so don't turn the root back into a row.
- `components/ReleaseNotesDialog.tsx` + `stores/releaseNotes.ts` — the "Notes de
  mise à jour" panel, opened from Settings → À propos and from the banner. Reads
  `app_release_notes` (the release *history*, newest first) and renders bodies
  through `SkillMarkdown`; `App.tsx` mounts it only while open so the markdown
  chunk stays out of startup.
- `stores/ui.ts` — single source of truth for theme/density/sidebar/polling prefs.
  `stores/theme.ts` is a thin re-export alias kept for legacy imports.
- `stores/notifications.ts` — in-app toast queue. The polling hook and Settings page
  push success/error toasts here; `NotificationStack` renders them.
- `pages/` — one file per top-level tab (Overview, Skills, Changes, Suivi
  marketplace, Audit; Settings is a dialog). `pages/Admin.tsx` is the "Suivi
  marketplace" tab, on route `/tracking` (`/admin` redirects to it); it holds
  nothing but the PR tracking view. Every PR on a plugin is built from the Changes
  tab, so `AdminWizards.tsx` is down to `AddSkillDialog`.
- `stores/treeSelection.ts` + the `RowCheckbox` in `pages/Skills.tsx` — multi-selection
  in the tree, feeding `components/BulkActionBar.tsx`. Keys are `mp:`/`pl:`/`sk:`
  prefixed, and a **skill is keyed on its folder, the same key the sync watcher
  uses** — so a locally deleted skill stays selectable. The marketplace box covers
  itself plus its *visible* plugins (filters are respected); a plugin box covers the
  plugin alone, never its skills, since the two take different actions. The page
  owns the ordered visible-row list (`setOrdered`) for shift-click, and prunes the
  selection against *every* key so a filter change never silently drops ticks.
- `delete_skill_local` (`commands/mod.rs` → `local_scanner::delete_skill_folder`) —
  removes a skill folder from disk. `classify_skill_folder` is the guard: the path
  comes from the frontend, and `starts_with(cache_root)` alone would also accept a
  version directory or the cache itself. It returns whether the removal is
  pushable — a plugin skill stays listed as `deleted`, a standalone user skill has
  no upstream and simply goes.
- `hooks/useBulkRunner.ts` — sequential, failure-tolerant runner behind every bulk
  action. Sequential is not incidental: `installPlugin` / `setPluginEnabled` rewrite
  the same JSON files, so concurrent invokes race. It never aborts on the first
  failure and invalidates queries **once**, at the end.
- `pages/Changes.tsx` + `lib/changes.ts` — the pending-changes tab. `lib/changes.ts`
  holds the grouping (one group per marketplace+plugin = one PR) so `Sidebar` can
  badge the count without pulling the diff viewer into the entry chunk. Groups whose
  marketplace has no push rights are listed **read-only, never hidden** — push rights
  gate the button, never the detection. Ticks are seeded once per navigation, not on
  every refresh, and are frozen once drafts are prepared so the PR always matches the
  preview.
- `components/FileDiff.tsx` — per-file diff + the split/unified toggle, used by the
  Changes tab. It is the only diff renderer left: the single-draft preview dialog
  went with the Admin "Proposer une amélioration" section.
- `components/ResizableSplit.tsx` — wraps `react-resizable-panels` with persistent
  layout via `autoSaveId`. Use it for any two-pane page; never grid `[fixed_px]_1fr`
  again — that broke responsiveness on small windows.

## Conventions worth preserving

- All JSON writes that matter go through `installer::atomic_write_json` (write `.tmp`
  then `rename`) — don't write JSON in place. `properties::write_atomic` does the same
  for `.properties` files. Both **skip the write when the bytes already match** the
  file on disk, so callers may re-save unconditionally without generating churn.
- Timestamps in install records use `installer::now_iso()` (UTC, milliseconds, `Z`
  suffix) to match Claude Code's own format.
- New plugins are auto-enabled on install only if `enabledPlugins` has no existing entry
  (mirrors `/plugin install`).
- Domain types live in `models.rs` + `config.rs` (Rust) and `lib/types.ts` (TS). Keep
  these in lockstep, not scattered.
- `serde` derives use `rename_all = "camelCase"` so the Rust → TS boundary doesn't need
  manual translation.
- App-state files (`config.properties`, `logging.properties`, `marketplaces.json`,
  `gitea.json`, `pr_history.json`, `pending_prs.json`, `skill_baselines.json`,
  `skill_new.json`, `skill_deleted.json`, `usage_index.json`, `logs/`) sit under
  `<exe_dir>/`. Never write
  to `%APPDATA%` directly — go through `config::app_settings_dir()` or
  `config::logs_dir()`.
- TanStack Query runs with `refetchOnWindowFocus: false` globally (`main.tsx`).
  Opt a query back in only when returning to the window genuinely should refetch
  it, and pair that with a staleTime that matches what the call costs — the
  default fired every stale query, including the multi-request `refresh_all`, on
  each alt-tab.
- Heavy dependency trees sit behind `React.lazy` boundaries (`SkillMarkdown`, the
  Admin and Audit pages, the Settings dialog), with `markdown` and `diff` pinned
  to their own Rollup chunks in `vite.config.ts`. Keep new heavyweight imports off
  the entry chunk.
- Backend events worth keeping in a log file use `tracing::info!`/`warn!`/`error!`.
  Frontend events use `createLogger("<target>")` from `lib/logger.ts`. Don't sprinkle
  `println!` or `console.log` in shipped code — they bypass the log file.

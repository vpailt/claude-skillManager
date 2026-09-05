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
│   ├── gitea.json             ← registered Gitea instances (tokens stay in the vault;
│   │                             the internal AlmaviaCX host defaults to
│   │                             `insecureTls: true` — internal CA)
│   ├── pr_history.json        ← rolling list of admin-opened PRs
│   ├── pending_prs.json       ← PR drafts awaiting merge
│   ├── skill_baselines.json   ← per-skill-folder sync references (`skill_watch.rs`)
│   ├── skill_new.json         ← skills created locally, not yet pushed
│   ├── skill_deleted.json     ← skills deleted locally, removal not yet pushed
│   ├── plugin_versions.json   ← memoised manifest versions of *not installed*
│   │                             plugins (6 h TTL); survives a restart so the
│   │                             first sweep after launch re-probes nothing
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
`save_settings` **overlays** the keys it owns onto what is already on disk rather
than rendering the file fresh, so a hand-added key — or a one-shot migration
marker such as `gitea.acx.tls.default.applied` — survives the next save. Without
that, the marker vanished and its migration re-ran on the following launch,
undoing whatever the user had changed in between.

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

The sweep is **bounded on three axes**, because it used not to be. A catalogue
like `claude-plugins-official` lists 168 plugins and step 3 probes a manifest for
every one of them that carries a source; each read that has to time out costs
seconds, so an offline machine turned one refresh into hours — with the UI
spinner spinning throughout, since a finished sweep is its only end condition.
The three bounds, in the order they bite:

- **A circuit breaker per host** (`github_client::send_read` / `HostHealth`).
  Two consecutive transport failures write a host off for 90 s and every
  subsequent *read* against it returns `Error::Unreachable` without touching the
  network. It guards reads only: a user-initiated write always goes out and
  reports the forge's real error. A short-circuited read is still a *failed*
  read, so `remote_ok` stays false and the local view is kept. A `403`/`429`
  carrying `x-ratelimit-remaining: 0` (or a `retry-after`) trips it too, for as
  long as the header says. `reset_host_health()` clears every tally and is what
  a **forced** refresh calls, so "reconnect the VPN, press Rafraîchir" works
  there and then.
- **A 75 s budget on the remote half** (`SWEEP_BUDGET_SECS`). Past it the sweep
  stops making *new* remote calls and returns what it has. Marketplaces are
  visited **installed-first**, so a large catalogue nobody installed from cannot
  spend the budget ahead of the two the user actually works in.
- **A cap on not-installed manifest probes** (40 per pass) plus a 6-hour memo
  keyed on `host|repo|ref`. An installed plugin's version drives the "obsolète"
  badge and is never capped or memoised; a not-installed one only decides what a
  catalogue row reads, and paying hundreds of requests every half hour for that
  label is what made the sweep expensive in the *online* case.

Two callers, **one pass**: `commands::sweep_or_reuse` is the door both the
frontend command and `catalog_poller` come through, and it hands back the last
result while it is younger than `SWEEP_REUSE_SECS` (45 s). The mutex only ever
serialised those two; it never stopped them being duplicates — the poller
finished a sweep, emitted `catalog-changed`, and the frontend answered by asking
for the same sweep again.

`refresh_all` takes a **`RefreshMode`**, and picking the right one is what keeps
a click responsive:

- `auto` — a background trigger. Answerable from the reuse window.
- `local` — this app just changed the install state on disk (install,
  uninstall, enable/disable, marketplace added, skill deleted). The window is
  bypassed (a reused result predates the marketplace you just added, which is
  exactly how an added marketplace ends up appearing nowhere) **and** the
  manifest probes for not-installed plugins are dropped entirely. Those probes
  were 22 s of a measured 24 s sweep — 40 sequential reads whose only product
  is whether a catalogue row reads "1.2.0" or "version inconnue" — so every
  install used to freeze the tree for that long. Versions already memoised are
  still served, so the mode acquires no new labels rather than losing the ones
  it had; the next poller pass fills them in.
- `user` — the Rafraîchir button (sidebar or tray). Full probing, and every
  host's failure tally is cleared.

`forceRefresh(qc, mode)` in `hooks/useRefresh.ts` is the frontend door, and it
defaults to `local`; a pending `user` is never downgraded by a `local` that
lands before the query runs. Nothing invalidates `["refresh"]` directly after a
local change — `useBulkRunner` routes that key through `forceRefresh` for the
same reason.

**One sweep runs at a time, but the loser no longer waits it out.** The
process-wide mutex is still there (step 1 re-extracts marketplace directories in
place, and a concurrent reader would see a half-empty marketplace), but a
`SweepPriority::Foreground` sweep — a click, or the refresh behind one —
announces itself *before* queueing, and a `Background` one holding the lock
reads that and stops making new remote calls. It is the same exit as running out
of budget, a path that already returns a usable partial view, so the waiting
sweep gets the lock in seconds instead of up to a minute. Two foreground sweeps
still serialise in full: neither is disposable. And a background sweep that did
wait re-tests the reuse window on the far side of it — the pass it queued behind
usually just answered its question.

**The sweep is not the only thing that may update the view.** A click's own
outcome is applied to the store immediately (`markPluginInstalled` /
`markPluginUninstalled` / `markPluginEnabled` in `stores/app.ts`), and the sweep
overwrites the whole tree behind it. Keep those patches to what the click
certainly did: a freshly installed plugin's *skills* are left to the local
scan — guessing them would put rows in the tree that may not exist.

The sweep also **deafens both filesystem watchers while it runs**.
`claude_watch::quiet_guard` is held across `auto_update_if_changed`: re-extracting
a marketplace rewrites `~/.claude/plugins/`, the watcher reported that as an
outside change, and the refresh it triggered made the same writes again.
`skill_watch::quiet_guard` is held across the **whole** sweep, because the sweep
walks every plugin directory and the user's `skills/` and reads every file it
compares — those reads came straight back as events, and `rescan` called any of
them a change to the *set* of skill folders, which is a `skills-tree-changed`,
which is another refresh. Measured on a shipped build: a sweep started exactly
45 s after the previous one finished, forever, which is the reuse window
lapsing — the loop had not stopped, it had merely gone quiet in the log.
`rescan` now counts a tree change only inside a `skills/` directory, not anywhere
under a plugin root (which matched the root itself and every file outside
`skills/`), and `useBackendEvents` keeps a 15 s floor between two refresh
invalidations as a backstop.

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

### Adding a marketplace: the forge comes from the URL

`AddMarketplaceDialog` reads the provider off the pasted URL
(`commands::guess_forge_for_url`), it does not take it from the toggle. The
toggle defaulted to Gitea and `owner/repo` parses identically on both forges, so
pasting a `github.com` URL without noticing registered the marketplace against
the internal Gitea instance and tried to download the repo from *there* — the
mismatch stayed invisible until the archive request. A host matching neither
`github.com` nor a registered Gitea instance blocks the dialog rather than being
guessed at. The branch likewise comes from the repo
(`commands::resolve_default_branch`), never from a hard-coded `main`.

### Admin upload (no git binary)

`admin::submit_changes` performs: `POST /git/refs` (create branch) → **one** recursive
`list_tree` read → `github_client::apply_file_ops` → `POST /repos/{owner}/{repo}/pulls`.
If you add new admin operations, follow the same Contents-API + PR pattern; never
introduce a code path that requires `git` on the user's machine.

**Nothing here goes one-request-per-file, and that is the point.** It used to: a GET for
each file's blob SHA (through `get_file`, which downloads the whole file to derive it)
plus a PUT to write it — 182 sequential requests for a 91-file PR over a VPN-gated
Gitea, where a single dropped connection aborted the lot via `?` and left an orphan
branch with no PR. So:

- **SHAs** come from one `list_tree` call, which returns every blob's git SHA and is
  ETag-cached on the immutable commit SHA (it cannot go stale). A `truncated` tree or a
  read failure falls back to per-file lookups — never to guessing, since "absent" would
  silently turn an update into a create.
- **Writes** go through `apply_file_ops`, which on **Gitea** batches into ChangeFiles
  (`POST /repos/{repo}/contents`, an array of `{operation, path, content, sha}`, one
  commit per call) and on **GitHub** keeps the per-file loop — GitHub has no equivalent
  endpoint, and the Git Data API is a different write model. Batching also subsumes the
  `path_has_dot_segment` workaround, since the path travels in the body.
- **Chunking is not optional.** These Gitea instances sit behind a reverse proxy, and
  nginx's `client_max_body_size` defaults to 1 MB; base64 inflates content by 4/3, so a
  91-file batch is ~1.9 MB and would 413. `apply_file_ops` splits on a byte budget, and
  `gitea_apply_chunk` halves again on an actual 413 — down to falling back to the
  per-file endpoint for a single oversized op. A 413 is refused by the proxy before
  Gitea sees the body, so re-sending the halves is safe.

Duplicate paths in one batch are collapsed to the last occurrence: every op is resolved
against the same pre-batch tree, so sending a path twice would write the second with a
SHA the first already invalidated.

`admin_drafts::prepare_upload_skills` is the one entry point for skill changes on a
plugin: adds, updates **and whole-skill removals** (`BulkUploadArgs::removals`) in a
single draft, with **one** manifest bump for the batch. Keep it that way — two PRs on
the same plugin repo would both bump the manifest and `detect_conflicts` would flag
them against each other. `prepare_upload_skill` (singular) is a thin wrapper over it,
and `prepare_delete_skill` remains for the one-off delete path.

The manifest bump is unconditional, so the draft must refuse an empty batch
*before* it: a removal the repo no longer holds resolves to zero file ops, and
falling through published a release whose entire diff was a version bump.

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
  idempotent. The filter names **both** `skillmanager_lib` and `frontend`:
  `logging_log` emits under the latter, so a filter naming only the crate
  silently dropped every line the React side sent, and the file logging
  `lib/logger.ts` exists to provide recorded nothing. `purge()` handles the Windows file-lock case by truncating in place when
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
  `modified` / `outdated` / `new` / `deleted` / `unknown`).
  **`modified` and `outdated` are the same difference with opposite causes**, and
  conflating them was a real bug: the remote tree is read at the plugin's tracked
  ref (branch HEAD) while the local copy is the version actually *installed*, so
  every upstream release turned every skill in the plugin amber — and
  `is_actionable` then offered them all up in the Changes tab, one click from
  pushing the older content back over the release that superseded it.
  `synced_sig` is the discriminator: a folder still hashing to the last
  signature confirmed against the remote was not touched here, so the difference
  is upstream's (`outdated`, not pushable, wants a plugin upgrade). Anything else
  is a real local edit (`modified`). Apply the same test in `rescan`, or a stray
  filesystem event relabels an `outdated` folder as the user's work.
  **The watcher triggers, the refresh decides**: a filesystem event only re-hashes *metadata* (path + size + mtime) and
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
  It is cleared by `mark_synced` (a PR was opened), `forget_under` (the plugin was
  removed), `forget` (see below), and by the sweep itself once the forge confirms
  the skill is not there: `sync` takes `remote_known_roots`, and under a root whose
  listing *was* read, absence from `MissingLocal` means there is nothing left to
  remove upstream, so the pending deletion is retired rather than parked forever.
  **A deletion is only a change while the remote still holds the skill.** Deleting a
  folder still flagged `New` undoes a creation, it does not start a removal — so
  `delete_skill_local` routes it to `forget` (drop baseline, status, both pending
  flags) and returns `tracked = false`, which is the frontend's cue that the row
  simply leaves the tree. Marking it `Deleted` instead left a red badge nothing
  could clear and offered a PR whose only real content was a manifest bump.
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
- `org_sync.rs` — incremental mirror of the Gitea `Claude` org into the GitHub
  `sforge-labs` org, behind a **hidden** entry point: typing `sforge-labs` in the
  command palette matches nothing, and Enter on the empty result list opens the
  comparison (`CommandPalette.tsx` → `stores/orgSync`). It carries the same two
  rewrite rules the one-shot migration used (`scripts/migrate-gitea-to-github.ps1`):
  `acx-cl` → `cl`, and forge references repointed at `github.com/sforge-labs`.
  Rewriting is **byte-level** — decoding to UTF-8 would mangle non-UTF-8 files and
  lose BOMs and mixed line endings.
  **Nothing links a GitHub commit to its Gitea origin but the commit message**, so
  every mirrored commit carries a `Gitea-Source-Sha:` trailer; `anchor_from_message`
  also accepts the `Imported from … at <sha>.` wording the migration script left
  behind, which is what lets the seven already-migrated repos join without a rewrite.
  Reading that anchor **from `HEAD` specifically** is also the divergence test: a
  `HEAD` with no trailer means someone committed straight to GitHub, and the repo is
  refused rather than buried. Commits are replayed one by one through GitHub's Git
  Data API (blobs → tree → commit), which is the only way to keep the original
  author, date and message; `apply_file_ops` cannot serve here, since on GitHub it
  writes one commit per file. The branch ref moves **once, at the end** — a failure
  part-way leaves unreferenced objects GitHub collects on its own, and `main` intact.
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
  `Error::Forge` carries **no hard-coded forge name**: the same `GitHubClient`
  type serves GitHub and every registered Gitea instance, so the old
  `#[error("github: {0}")]` labelled every Gitea 401/403/5xx as a GitHub
  problem — printed under a Gitea heading, telling the user to fix the wrong
  token. Build it through `GitHubClient::forge_err`, which prefixes
  `GitHub: ` or `Gitea (host): ` from the client that made the call; the same
  applies to the 404 → `Error::NotFound` split and to `zipball_error_message`,
  whose "check your token" wording is provider-specific. `Error::Unreachable` is
  the circuit breaker's: a request that was never sent, as opposed to
  `Error::Http`, which is one that failed.

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
  consume the resulting query state, not the raw command. It exports
  `forceRefresh(qc)`, which is what every trigger following a local change must
  call — TanStack has nowhere to carry a per-invocation argument, so the flag is
  module-scoped and consumed by the next `queryFn` run. `refetchOnWindowFocus`
  is deliberately **off**: `claude_watch` reports a CLI install within a second
  and `catalog_poller` covers upstream changes with no window at all, so
  alt-tabbing had nothing left to discover and only cost forge traffic. For the
  same reason, never `invalidateQueries(["refresh"])` from a page mount —
  invalidation ignores `staleTime`, and both `["refresh"]` and `["tracked-prs"]`
  are mounted at App level, so it turned every visit to the dashboard into a
  full sweep. Use `refetchQueries({ stale: true })`.
- `hooks/useForgeStatus.ts` — the one place the three connection probes
  (`github-auth`, `github-rate`, `gitea-status`) are declared. Five components
  used to mount them with their own options; a query key with mixed staleness
  refetches on the most aggressive observer's mount, so every dashboard visit
  cost a GitHub `/user`, a `/rate_limit` and one Gitea `/user` per instance —
  the last of them VPN-gated. It is rendered in exactly one place, and that
  place is now `components/StatusBar.tsx` — it was a strip on the dashboard,
  then a block in the sidebar, and each move was made for the same reason: it
  is chrome, identical on every page, read only when something needs fixing.
  The status bar is the first host that is neither in the way of the content
  nor hostage to the sidebar being collapsed.
- `components/StatusBar.tsx` + `stores/progress.ts` — the permanent bar across
  the bottom. It carries the running version (clicking it opens the release
  notes), the forge connection segments (GitHub / Gitea mark, green connected,
  red not), and **the one progress slot in the app**. Anything slow registers a
  task in `stores/progress.ts` and the bar renders the winner on priority
  (`publish` > install/uninstall/marketplace > audit/tracking > `refresh`),
  counting the rest as `+N` so its height never moves. The self-update is the
  one thing *not* mirrored into that store: it already has `stores/appUpdate.ts`
  fed by backend events that outlive the window, and the bar reads it directly.
  Two queries are derived from `useIsFetching` rather than wrapped
  (`usage-audit`, `tracked-prs`) — they are owned by their pages and a task
  wrapper would have to be threaded through every call site. `withTask()` is
  the wrapper for everything else, and it works outside React, which is what
  matters: install/uninstall live in `mutationFn`s, not in components.
- `hooks/usePrPolling.ts` — gated by `ui.prPollingEnabled` in settings; min interval 15s.
  Its `["tracked-prs"]` timer is additionally gated on `useTrackingView` being
  active. "Invalidate-only, so it is free while you're elsewhere" was wrong:
  `useTaskbarBadge` keeps that query mounted at App level whenever any
  marketplace is tracked, so it was always active and the invalidation always
  refetched — `can_push` + `/user` + a PR listing per tracked repo, and the same
  again per plugin repo, every minute, on every tab.
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
  `components/UpdateBanner.tsx` is the top bar, and it exists to offer an
  *action*: staged (restart button) or available (Installer / Notes de version /
  dismiss). While the download runs it renders **nothing** — the status bar has
  the phase, the bar and the byte counter, like every other long-running
  operation. Two progress bars for the same download, one at each end of the
  window, is the same information competing with itself, and there is nothing to
  act on while it runs. Dismissal applies to the "available" face only and hides
  it outright — the sidebar pill covers `staged`, never `available` — so it goes
  through `dismissUpdate()`, which records it in Rust as well as in the store.
  `components/UpdateProgressBar.tsx` is what is left of that face: the Settings
  card's stacked rendering. It is deliberately **not** an `aria-live` region
  (ticks arrive every 120 ms) — the named `role="progressbar"` plus
  `aria-valuetext` is what carries the value, and the status bar's own bar
  follows the same rule. `App.tsx` is a flex **column** for the banner *and* the
  status bar, so don't turn the root back into a row.
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
  `skill_new.json`, `skill_deleted.json`, `plugin_versions.json`,
  `usage_index.json`, `logs/`) sit under
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

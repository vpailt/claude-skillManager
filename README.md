# Claude SkillManager

Desktop app that manages [Claude Code](https://claude.com/claude-code) skills and plugins
installed locally and lets you browse a GitHub-hosted marketplace, install/update plugins,
and (admin) submit new skills or new versions back via GitHub PR.

Built with **Tauri 2 + React + Tailwind + shadcn/ui**. Distributed as a **portable
directory** (zip the `SkillManager/` folder) — the executable, its config, and its
logs sit side by side. **No Python, git, gh, or Claude CLI required at runtime.**

## What it does

- Scans `%USERPROFILE%\.claude\plugins\` for installed plugins, their version, and bundled skills.
- Scans `%USERPROFILE%\.claude\skills\` for user-level standalone skills.
- For each known marketplace, fetches the catalog via the GitHub REST API and reconciles it
  against the local install so you can see at a glance:
  - **Installed (up to date)** — green
  - **Update available** — orange
  - **Not installed** — grey
  - **Local only** — blue (installed locally but not in the remote marketplace)
- One-click install / update / uninstall, single plugin or whole marketplace.
- SKILL.md preview in the Skills tab.
- Admin tab: create a new skill, bump a plugin version, add/remove plugins on a marketplace
  you own — all via a GitHub branch + Contents API + PR (no git binary needed).

## Prerequisites

| Tool | Install |
|---|---|
| Rust 1.77+ | `winget install Rustlang.Rustup` |
| MSVC linker | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| Node.js 20+ | required for the Vite frontend |

## Commands

```pwsh
.\build.ps1 -Dev          # hot-reload dev (Vite + Tauri)
.\build.ps1 -NoBundle     # just the .exe (~5 min on first build, cached after)
.\build.ps1               # .exe + NSIS installer
```

Output: `src-tauri\target\release\skillmanager.exe`. Bundles land in
`src-tauri\target\release\bundle\`.

## First-time setup

1. Launch `skillmanager.exe`. A `config/` and a `logs/` folder are created next to it
   on first run.
2. Open **Settings** and paste a GitHub Personal Access Token. Required scopes:
   - `repo` (full repo access) if you want admin uploads (branch + PR)
   - public read works without a token but is heavily rate-limited
3. Add marketplaces from **Admin → Admin local → Add from URL** (paste the
   marketplace repo's Git URL). The Admin distant tab auto-shows marketplaces
   where the token has push access (detected via `/repos/{repo}/permissions`).
4. Refresh → the catalog reconciles remote + local install state.

## Portable layout

After first launch the install directory looks like this:

```
SkillManager/
├── skillmanager.exe
├── config/
│   ├── config.properties     # token + polling + UI prefs (hand-editable)
│   ├── logging.properties    # log enable / level / rotation count
│   ├── marketplaces.json     # registered marketplaces
│   ├── pr_history.json       # rolling list of admin-opened PRs
│   └── pending_prs.json      # PR drafts awaiting merge
└── logs/
    └── skillmanager.YYYY-MM-DD.log
```

Both `.properties` files are plain `key=value`; restart the app to pick up changes
made by hand. Logging level, enable toggle, max-files (daily rotation), in-app log
viewer and a one-click **Purge logs** button live in **Settings → Logging**.

Migrating from an older install? If `%APPDATA%\SkillManager\settings.json` exists,
its token + marketplaces are imported once on first launch.

## How install works

The Rust `installer` does the same thing the official `claude plugin install` does:

1. Downloads the plugin's source repo zipball at the configured ref/branch via the GitHub API.
2. Extracts it to `%USERPROFILE%\.claude\plugins\cache\<marketplace>\<plugin>\<version>\`,
   stripping the top-level commit folder GitHub adds.
3. Patches `installed_plugins.json` with a new install record (scope, installPath,
   version, gitCommitSha, timestamps).

For directory-source marketplaces (e.g. a local clone), files are copied instead of
downloaded.

## How admin upload works

`admin::submit_changes` makes a branch + PR via the GitHub REST API:

1. `POST /git/refs` to create `refs/heads/skillmanager/<slug>-<timestamp>` from the
   default branch.
2. `PUT /repos/{owner}/{repo}/contents/<path>` for each new/updated file (auto-detects
   the existing blob SHA so it works for both create and update).
3. `POST /repos/{owner}/{repo}/pulls` to open a PR back to the default branch.

No git CLI, no gh CLI — just HTTPS calls.

## Admin wizards

| Wizard | Trigger | What it does |
|---|---|---|
| **Add plugin** | "Add plugin" on a marketplace | Fetches `manifest.json` from the source repo, prepares a registry update, optionally creates the missing tag, opens a PR. |
| **Bump plugin** | "Bump" on a plugin row | Suggests patch/minor/major bumps, optionally creates a tag on the plugin's source repo, opens a registry-bump PR. |
| **Remove plugin** | "Remove" on a plugin row | Drops the entry from `marketplace.json`, opens a PR. |
| **Upload skill** | "Upload skill" on a plugin row, or "Upgrade" on a remote skill row | Picks a local folder (auto-listed from `~/.claude/skills/`), validates SKILL.md frontmatter, optionally bumps version + companion marketplace PR, opens the skill PR. |
| **Delete remote skill** | "Trash" on a remote skill row | Lists files under `skills/<name>/`, opens a deletion PR. |

Every wizard funnels into a single `<DiffPreviewDialog>` that shows per-file unified
diffs (via `react-diff-viewer-continued`), validation problems, conflicts (open PRs
touching the same paths), a tag-creation prompt when needed, and an "Open PR"
button that surfaces the resulting URL via toast.

## Project layout

```
SkillManager/
├── build.ps1                 # one-shot build script (dev / nobundle / full bundle)
├── package.json              # Vite + React + shadcn/ui deps
├── vite.config.ts            # Vite config (port 1420 for Tauri)
├── tailwind.config.ts
├── tsconfig.json
├── index.html
├── src/                      # React + TypeScript frontend
│   ├── App.tsx
│   ├── main.tsx
│   ├── pages/                # Overview, Plugins, Skills, Admin, Settings
│   ├── components/           # shadcn/ui primitives + app components
│   ├── hooks/                # TanStack Query bridges (refresh, PR polling)
│   ├── lib/                  # api.ts, types.ts, logger.ts, utils.ts
│   ├── stores/               # Zustand: UI prefs, app selection, notifications
│   └── styles.css
└── src-tauri/                # Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── icons/
    └── src/
        ├── main.rs           # binary entry
        ├── lib.rs            # tauri::generate_handler!
        ├── commands/         # #[tauri::command] handlers
        ├── models.rs         # domain types
        ├── config.rs         # paths + portable config.properties / marketplaces.json
        ├── properties.rs     # tiny Java-style .properties parser/serializer
        ├── logger.rs         # tracing → logs/skillmanager.<date>.log
        ├── frontmatter.rs    # tiny YAML-frontmatter parser
        ├── github_client.rs  # REST API client
        ├── plugin_state.rs   # ~/.claude/settings.json patch
        ├── installer.rs      # install / update / uninstall
        ├── marketplace_installer.rs
        ├── marketplace_remote.rs
        ├── local_scanner.rs  # ~/.claude scan
        ├── registry.rs
        ├── admin.rs          # branch + PR
        ├── admin_drafts.rs
        ├── pr_history.rs
        ├── pending_prs.rs
        └── error.rs
```

The shipped `.exe` is around **6.8 MB**. Release profile is tuned for size
(`opt-level = "s"`, `lto = true`, `codegen-units = 1`, `strip = true`,
`panic = "abort"`) and all dependencies are pure-Rust (no OpenSSL/C deps).

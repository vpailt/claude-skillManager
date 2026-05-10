# Claude SkillManager

Desktop app that manages [Claude Code](https://claude.com/claude-code) skills and plugins
installed locally and lets you browse a GitHub-hosted marketplace, install/update plugins,
and (admin) submit new skills or new versions back via GitHub PR.

Ships as a single-file Windows `.exe` — **no Python, git, gh, or Claude CLI required at runtime.**

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
- Inline editor for `SKILL.md` (frontmatter + body).
- Admin tab: create a new skill or bump a plugin version on a marketplace you own —
  done via a GitHub branch + Contents API + PR (no git binary needed).

## Run from source (development)

```
python -m pip install -r requirements.txt
python run.py
```

## Build the standalone .exe

```
.\build.ps1
```

This produces `dist\SkillManager.exe` (~50–80 MB, single file).
The exe writes user settings to `%APPDATA%\SkillManager\settings.json` — nothing
is written next to the executable, so you can copy it anywhere.

## First-time setup

1. Launch the exe.
2. Open **Settings**.
3. Paste a GitHub Personal Access Token. Required scopes:
   - `repo` (full repo access) if you want admin uploads (branch + PR)
   - public read works without a token but is heavily rate-limited
4. For each marketplace listed, fill the `owner/repo` field. Tick **Owned** for
   marketplaces where you want admin upload to be available.
5. Save → the catalog refreshes with remote info.

## How the install mechanism works

`install_from_github` does the same thing the official `claude plugin install` does, but
in pure Python:

1. Downloads the repo zipball at the configured ref/branch via the GitHub API.
2. Extracts it to `%USERPROFILE%\.claude\plugins\cache\<marketplace>\<plugin>\<version>\`,
   stripping the top-level commit folder added by GitHub.
3. Patches `installed_plugins.json` with a new install record (scope, installPath,
   version, gitCommitSha, timestamps).

For directory-source marketplaces (e.g. a local clone), files are copied instead of
downloaded.

## How admin upload works

`admin.submit_changes` makes a branch + PR via the GitHub REST API:

1. `POST /git/refs` to create `refs/heads/skillmanager/<slug>-<timestamp>` from the
   default branch.
2. `PUT /repos/{owner}/{repo}/contents/<path>` for each new/updated file (auto-detects
   the existing blob SHA so it works for both create and update).
3. `POST /repos/{owner}/{repo}/pulls` to open a PR back to the default branch.

No git CLI, no gh CLI — just HTTPS calls.

## Project layout

```
SkillManager/
├── run.py                        # dev entry point
├── SkillManager.spec             # PyInstaller spec (--onefile, windowed)
├── build.ps1                     # one-shot build script
├── requirements.txt              # build-time deps (PySide6, requests, PyInstaller)
└── src/
    ├── main.py                   # QApplication entry
    ├── config.py                 # paths, settings.json
    ├── models.py                 # domain types
    ├── frontmatter.py            # tiny YAML-frontmatter parser
    ├── _frontmatter_util.py      # editor save helper
    ├── local_scanner.py          # ~/.claude scan
    ├── github_client.py          # REST API client
    ├── marketplace_remote.py     # remote-catalog fetch + local/remote merge
    ├── installer.py              # install / update / uninstall
    ├── admin.py                  # branch + PR
    └── ui/
        ├── main_window.py        # QMainWindow, refresh worker, detail panel
        ├── plugins_tree.py       # tree grouping mp -> plugin -> skill
        ├── skill_editor.py       # SKILL.md editor dialog
        ├── settings_dialog.py    # token + marketplace config
        ├── admin_dialog.py       # new skill / bump version
        └── common.py             # state colors, busy cursor
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build / run

Dev (from project root):
```
python -m pip install -r requirements.txt
python run.py
```

Single-file Windows exe:
```
.\build.ps1            # cleans build/ + dist/, pip-installs deps, runs PyInstaller --onefile (windowed)
```

There is no test suite, no linter, no formatter configured. Don't add one without asking.

## Hard constraint: standalone .exe, no runtime deps

The shipped artifact is `dist\SkillManager.exe` and it must run on a machine with **no Python, no git, no gh CLI, no Claude CLI**. All operations on GitHub go through `requests` against the REST API. All filesystem mutations on the Claude install go through Python stdlib. Never import a module that shells out to `git`/`gh`/`claude`, and never add a runtime dep that PyInstaller can't bundle into one file.

`SkillManager.spec` excludes large unused Qt modules (`QtWebEngine*`, `QtMultimedia`, `Qt3D*`, `QtCharts`, `QtPdf`, `QtQuick3D`) to keep the bundle small — keep that list pruned if you add features that don't need them.

## Mental model

The app is a GUI over **Claude Code's plugin install state**. Every important file it reads/writes lives under `%USERPROFILE%\.claude\`:

| File | Purpose | Module |
|---|---|---|
| `~/.claude/plugins/installed_plugins.json` | per-plugin install records | `installer.py` |
| `~/.claude/plugins/known_marketplaces.json` | registered marketplaces (incl. `autoUpdate` flag) | `marketplace_installer.py` |
| `~/.claude/plugins/cache/<mp>/<plugin>/<version>/` | actual extracted plugin contents | `installer.py` |
| `~/.claude/plugins/marketplaces/<name>/` | extracted marketplace repo | `marketplace_installer.py` |
| `~/.claude/settings.json` → `enabledPlugins["<plugin>@<marketplace>"]` | enable/disable | `plugin_state.py` |
| `~/.claude/skills/<name>/` | standalone user skills | `local_scanner.py` |

App's own settings live separately at `%APPDATA%\SkillManager\settings.json` (see `config.app_settings_dir()`) — token + per-marketplace config. Nothing is written next to the .exe; that's intentional so the exe stays portable.

### Marketplace = index, not container

A marketplace repo holds `.claude-plugin/marketplace.json` listing plugins. **Each plugin's `source` points to where the plugin actually lives** (almost always a different GitHub repo). So installing a plugin means: read marketplace.json → resolve plugin's `source.repo`/`source.ref` → download *that* repo's zipball → extract to the cache path. Don't conflate "install marketplace" (clone the index) with "install plugin" (fetch the plugin's own repo). `installer.py` and `marketplace_installer.py` are separate for this reason.

### Refresh flow (the heart of the UI)

`ui/main_window.py:RefreshWorker` runs in a `QThread`:
1. For each marketplace flagged `auto_update` and installed → re-pull only if remote SHA differs (`marketplace_installer.auto_update_if_changed`).
2. `local_scanner.build_marketplaces_from_settings(...)` → builds `Marketplace` objects from local state, scanning install paths and falling back to directory marketplaces.
3. For each marketplace with a `source_repo` → fetch its registry (`marketplace_remote.fetch_marketplace_plugins`) and merge with local install state via `merge_local_remote` (sets `latest_version`, `source`, recomputes `InstallState`).
4. For each installed plugin with a GitHub source → fetch its remote skills list and merge so the tree shows remote-only skills too.

Keep this pipeline async — the UI must stay responsive. New network work belongs in the worker, not on the main thread.

### Admin upload (no git binary)

`admin.submit_changes` performs: `POST /git/refs` (create branch) → `PUT /repos/{owner}/{repo}/contents/<path>` for each file (auto-detects existing blob SHA so create and update share one path) → `POST /repos/{owner}/{repo}/pulls`. If you add new admin operations, follow the same Contents-API + PR pattern; never introduce a code path that requires `git` on the user's machine.

## Module map (only the non-obvious bits)

- `frontmatter.py` — minimal YAML-frontmatter parser (avoids pulling PyYAML into the bundle). Only `name`/`description`/`type` are used. If you need richer YAML, weigh that against the bundle-size constraint.
- `github_client.py:GitHubClient.extract_zipball` — strips the top-level `<repo>-<sha>/` folder GitHub adds, and uses the `\\?\` long-path prefix on Windows to bypass MAX_PATH. Don't replace with naive `zipfile.extractall`.
- `installer.py:_rmtree_robust` — handles read-only files and long paths on Windows. Use this everywhere we delete a plugin/marketplace folder, not `shutil.rmtree` directly.
- `plugin_state.py` — `~/.claude/settings.json` contains many unrelated keys (hooks, theme, etc.); always do a partial update preserving everything else.
- `local_scanner.py:build_marketplaces_from_settings` — also surfaces "orphan" marketplaces (installed locally but missing from app settings) so the user can still see/act on them.

## Conventions worth preserving

- All JSON writes that matter go through `installer._atomic_write_json` (write `.tmp` then `replace`) — don't write JSON in place.
- Timestamps in install records use `_now_iso()` (UTC, milliseconds, `Z` suffix) to match Claude Code's own format.
- New plugins are auto-enabled on install only if `enabledPlugins` has no existing entry (mirrors `/plugin install`).
- Type hints + dataclasses throughout `models.py` / `config.py`. Keep new domain types here, not scattered.

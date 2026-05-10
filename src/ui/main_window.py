"""Main window. 3-column layout: nav rail | items list | detail panel.

The window itself is a thin shell: it owns the refresh worker and the
top-level data state, then dispatches actions to the installer / state
modules. UI rendering is delegated to the three column widgets.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import Qt, QThread, QTimer, Signal
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QMainWindow, QWidget, QHBoxLayout, QSplitter,
    QToolBar, QStatusBar, QPushButton, QLabel, QSizePolicy,
    QMessageBox, QDialog, QVBoxLayout, QCheckBox, QInputDialog,
)

from .. import config, local_scanner, installer, marketplace_installer, plugin_state
from ..config import Settings, MarketplaceConfig, load_settings, save_settings
from ..github_client import GitHubClient
from ..marketplace_remote import (
    fetch_marketplace_plugins, merge_local_remote, fetch_plugin_skills, merge_skills,
)
from ..models import Marketplace, Plugin, Skill, SkillFile, InstallState
from ..registry import parse_github_marketplace_url
from .common import busy_cursor
from .nav_rail import NavRail, SEL_ALL
from .items_list import ItemsList
from .detail_panel import DetailPanel
from .settings_dialog import SettingsDialog
from .admin_dialog import AdminPanel
from .help_dialog import HelpDialog
from . import theme


class RefreshWorker(QThread):
    """Loads local marketplaces and (optionally) merges with remote data."""
    finished_with_data = Signal(list, str)
    progress = Signal(str)
    auth_status = Signal(bool, str)

    def __init__(self, settings: Settings, parent=None):
        super().__init__(parent)
        self._settings = settings

    def run(self) -> None:
        errors: list[str] = []
        gh = GitHubClient(self._settings.github_token)

        self.progress.emit("Checking GitHub authentication")
        ok, info = gh.auth_check()
        self.auth_status.emit(ok, info)

        auto_targets = [m for m in self._settings.marketplaces
                        if m.auto_update and m.github_repo
                        and marketplace_installer.is_marketplace_installed(m.name)]
        for i, cfg in enumerate(auto_targets, 1):
            self.progress.emit(f"[auto-update {i}/{len(auto_targets)}] {cfg.name}")
            try:
                updated, msg = marketplace_installer.auto_update_if_changed(
                    gh, cfg.name, cfg.github_repo, ref=cfg.default_branch or "main",
                )
                if not updated and msg not in ("up to date", "no repo"):
                    errors.append(f"{cfg.name} auto-update: {msg}")
            except Exception as e:
                errors.append(f"{cfg.name} auto-update: {e}")

        self.progress.emit("Scanning local install")
        try:
            marketplaces = local_scanner.build_marketplaces_from_settings(self._settings.marketplaces)
        except Exception as e:
            self.finished_with_data.emit([], f"Local scan failed: {e}")
            return

        try:
            local_mp = local_scanner.build_local_only_marketplace()
            if local_mp.plugins:
                marketplaces.append(local_mp)
        except Exception as e:
            errors.append(f"local skills scan: {e}")

        perm_cache: dict[str, bool] = {}
        total = sum(1 for mp in marketplaces if mp.source_repo)
        idx = 0
        for mp in marketplaces:
            if not mp.source_repo:
                continue
            idx += 1
            self.progress.emit(f"[{idx}/{total}] Fetching marketplace {mp.name}")
            if mp.source_repo not in perm_cache:
                try:
                    perm_cache[mp.source_repo] = gh.can_push(mp.source_repo)
                except Exception:
                    perm_cache[mp.source_repo] = False
            mp.editable = perm_cache[mp.source_repo]
            try:
                cfg = self._settings.get_marketplace(mp.name)
                branch = (cfg.default_branch if cfg else "") or "main"
                remote = fetch_marketplace_plugins(gh, mp.source_repo, ref=branch, marketplace_name=mp.name)
                for p in remote:
                    p.marketplace_name = mp.name
                mp.plugins = merge_local_remote(mp.plugins, remote)
            except Exception as e:
                errors.append(f"{mp.name}: {e}")
                continue
            installed_count = sum(1 for p in mp.plugins if p.installed_version)
            for j, p in enumerate(mp.plugins):
                if not p.installed_version or not p.source or not p.source.repo:
                    continue
                self.progress.emit(
                    f"[{idx}/{total}] {mp.name} — fetching skills for {p.name} ({j+1}/{installed_count})"
                )
                try:
                    remote_skills = fetch_plugin_skills(gh, p.source, plugin_name=p.name,
                                                       marketplace_name=mp.name)
                except Exception:
                    continue
                p.skills = merge_skills(p.skills, remote_skills)
        self.finished_with_data.emit(marketplaces, "; ".join(errors))


class AuthCheckWorker(QThread):
    """One-shot GET /user used to refresh the GitHub indicator on demand."""
    finished_with_status = Signal(bool, str)

    def __init__(self, token: str, parent=None):
        super().__init__(parent)
        self._token = token

    def run(self) -> None:
        ok, info = GitHubClient(self._token).auth_check()
        self.finished_with_status.emit(ok, info)


class AdminDialog(QDialog):
    """Wraps the existing AdminPanel widget in a modal-like dialog."""

    def __init__(self, settings: Settings, marketplaces: list[Marketplace], parent=None):
        super().__init__(parent)
        self.setWindowTitle("Admin")
        self.resize(1100, 760)
        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        self.panel = AdminPanel(settings, marketplaces, parent=self)
        v.addWidget(self.panel)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Claude SkillManager")
        self.resize(1280, 800)

        self._settings: Settings = load_settings()
        self._marketplaces: list[Marketplace] = []
        self._worker: RefreshWorker | None = None
        self._auth_worker: AuthCheckWorker | None = None
        self._admin_dialog: AdminDialog | None = None

        self._build_menubar()
        self._build_toolbar()
        self._build_central()
        self._build_status()

        self._sync_settings_with_known_marketplaces()
        self.refresh()

    # ---------- UI scaffold ----------
    def _build_menubar(self) -> None:
        mb = self.menuBar()
        settings_menu = mb.addMenu("&Settings")
        git_auth = QAction("Git authentication…", self)
        git_auth.triggered.connect(self.open_settings)
        settings_menu.addAction(git_auth)

        help_menu = mb.addMenu("&Help")
        how_it_works = QAction("How it works…", self)
        how_it_works.triggered.connect(self.open_help)
        help_menu.addAction(how_it_works)

    def _build_toolbar(self) -> None:
        tb = QToolBar("Main", self)
        tb.setMovable(False)
        self.addToolBar(tb)

        refresh = QAction("Refresh", self)
        refresh.setShortcut("F5")
        refresh.triggered.connect(self.refresh)
        tb.addAction(refresh)

        spacer = QWidget()
        spacer.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        tb.addWidget(spacer)

        self.gh_status = QLabel("● GitHub: …")
        self.gh_status.setStyleSheet(
            f"padding: 2px 12px; color: {theme.TEXT_SECONDARY}; font-weight: 500;"
        )
        self.gh_status.setToolTip("GitHub authentication status. Click to open Settings.")
        self.gh_status.setCursor(Qt.PointingHandCursor)
        self.gh_status.mousePressEvent = lambda _e: self.open_settings()
        tb.addWidget(self.gh_status)

    def _build_central(self) -> None:
        splitter = QSplitter(Qt.Horizontal, self)
        splitter.setHandleWidth(1)
        splitter.setChildrenCollapsible(False)

        self.nav_rail = NavRail()
        self.nav_rail.selectionChanged.connect(self._on_nav_changed)
        self.nav_rail.openAdminRequested.connect(self.open_admin)
        self.nav_rail.openSettingsRequested.connect(self.open_settings)
        self.nav_rail.addMarketplaceRequested.connect(self._add_marketplace_from_url)
        splitter.addWidget(self.nav_rail)

        self.items = ItemsList()
        self.items.selectionChanged.connect(self._on_items_selection)
        self.items.actionRequested.connect(self._on_action)
        self.items.batchActionRequested.connect(self._on_batch)
        splitter.addWidget(self.items)

        self.detail = DetailPanel()
        self.detail.editInVSCodeRequested.connect(self._open_in_vscode)
        self.detail.openFolderRequested.connect(self._open_folder)
        self.detail.installRequested.connect(self._install_plugin)
        self.detail.updateRequested.connect(self._install_plugin)
        self.detail.uninstallRequested.connect(self._uninstall_plugin)
        self.detail.installAllRequested.connect(self._install_all_for_plugin)
        self.detail.installAllMarketplaceRequested.connect(self._install_all_for_marketplace)
        self.detail.installMarketplaceRequested.connect(self._install_marketplace)
        self.detail.uninstallMarketplaceRequested.connect(self._uninstall_marketplace)
        self.detail.enableRequested.connect(lambda p: self._set_plugin_enabled(p, True))
        self.detail.disableRequested.connect(lambda p: self._set_plugin_enabled(p, False))
        self.detail.uploadLocalRequested.connect(self._upload_local_plugin)
        splitter.addWidget(self.detail)

        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 2)
        splitter.setStretchFactor(2, 3)
        splitter.setSizes([240, 360, 680])
        self.setCentralWidget(splitter)

    def _build_status(self) -> None:
        self.setStatusBar(QStatusBar(self))
        self._loading_label = QLabel("")
        self._loading_label.setStyleSheet(f"color: {theme.INFO}; padding-right: 8px;")
        self.statusBar().addPermanentWidget(self._loading_label)
        self.statusBar().showMessage("Ready")

        self._loading_text = ""
        self._loading_dots = 0
        self._loading_timer = QTimer(self)
        self._loading_timer.setInterval(450)
        self._loading_timer.timeout.connect(self._tick_loading)

    def _tick_loading(self) -> None:
        self._loading_dots = (self._loading_dots + 1) % 4
        dots = "." * self._loading_dots
        self._loading_label.setText(f"⏳ {self._loading_text}{dots}")

    def _start_loading(self, text: str) -> None:
        self._loading_text = text
        self._loading_dots = 0
        self._loading_label.setText(f"⏳ {text}")
        if not self._loading_timer.isActive():
            self._loading_timer.start()

    def _stop_loading(self) -> None:
        self._loading_timer.stop()
        self._loading_label.setText("")

    # ---------- refresh ----------
    def refresh(self) -> None:
        if self._worker is not None:
            return
        self._start_loading("Loading marketplaces")
        self.statusBar().showMessage("")
        self._set_gh_status_checking()
        self._worker = RefreshWorker(self._settings, parent=self)
        self._worker.finished_with_data.connect(self._on_refreshed)
        self._worker.progress.connect(self._on_refresh_progress)
        self._worker.auth_status.connect(self._set_gh_status)
        self._worker.start()

    def _on_refresh_progress(self, text: str) -> None:
        self._loading_text = text
        self._loading_dots = 0
        self._loading_label.setText(f"⏳ {text}")

    def _on_refreshed(self, marketplaces: list[Marketplace], errors: str) -> None:
        self._stop_loading()
        self._marketplaces = marketplaces
        self.nav_rail.populate(marketplaces)
        # nav_rail.populate() emits selectionChanged via its set_selection;
        # but if no selection was set we manually drive the items list.
        sel = self.nav_rail.current_selection() or SEL_ALL
        self.items.show_for(marketplaces, sel)
        if self._admin_dialog is not None:
            self._admin_dialog.panel.set_state(self._settings, self._marketplaces)
        msg = f"{sum(len(m.plugins) for m in marketplaces)} plugin(s) across {len(marketplaces)} marketplace(s)"
        if errors:
            msg += f"   |   Remote errors: {errors}"
        self.statusBar().showMessage(msg)
        self._worker = None

    # ---------- nav rail / items list ----------
    def _on_nav_changed(self, selection: str) -> None:
        self.items.show_for(self._marketplaces, selection)
        self.detail.show_object(None)

    def _on_items_selection(self, obj) -> None:
        self.detail.show_object(obj)

    # ---------- GitHub status indicator ----------
    def _kick_auth_check(self) -> None:
        if self._worker is not None or self._auth_worker is not None:
            return
        self._set_gh_status_checking()
        self._auth_worker = AuthCheckWorker(self._settings.github_token, parent=self)
        self._auth_worker.finished_with_status.connect(self._on_auth_check_done)
        self._auth_worker.start()

    def _on_auth_check_done(self, ok: bool, info: str) -> None:
        self._set_gh_status(ok, info)
        self._auth_worker = None

    def _set_gh_status_checking(self) -> None:
        self.gh_status.setText("● GitHub: checking…")
        self.gh_status.setStyleSheet(
            f"padding: 2px 12px; color: {theme.WARNING}; font-weight: 500;"
        )

    def _set_gh_status(self, ok: bool, info: str) -> None:
        if not self._settings.github_token:
            self.gh_status.setText("● GitHub: no token")
            self.gh_status.setStyleSheet(
                f"padding: 2px 12px; color: {theme.TEXT_MUTED}; font-weight: 500;"
            )
            self.gh_status.setToolTip("No token configured — click to open Settings.")
            return
        if ok:
            self.gh_status.setText(f"● GitHub: @{info}")
            self.gh_status.setStyleSheet(
                f"padding: 2px 12px; color: {theme.SUCCESS}; font-weight: 500;"
            )
            self.gh_status.setToolTip(f"Authenticated as @{info}. Click to open Settings.")
        else:
            self.gh_status.setText("● GitHub: error")
            self.gh_status.setStyleSheet(
                f"padding: 2px 12px; color: {theme.DANGER}; font-weight: 500;"
            )
            self.gh_status.setToolTip(f"Authentication failed: {info}\nClick to open Settings.")

    def _sync_settings_with_known_marketplaces(self) -> None:
        from ..config import save_settings
        from ..registry import read_git_remote_origin

        by_name = {m.name: m for m in self._settings.marketplaces}
        changed = False

        for name, info in local_scanner.load_known_marketplaces().items():
            src = info.get("source", {}) if isinstance(info, dict) else {}
            kind = src.get("source", "")
            inferred_repo = src.get("repo", "") if kind == "github" else ""
            local_path = src.get("path", "") if kind == "directory" else ""
            if not inferred_repo and local_path:
                inferred_repo = parse_github_marketplace_url(read_git_remote_origin(local_path)) or ""

            if name not in by_name:
                self._settings.marketplaces.append(MarketplaceConfig(
                    name=name, github_repo=inferred_repo, source_path=local_path,
                ))
                changed = True
            else:
                cfg = by_name[name]
                if inferred_repo and not cfg.github_repo:
                    cfg.github_repo = inferred_repo
                    changed = True
                if local_path and not cfg.source_path:
                    cfg.source_path = local_path
                    changed = True

        for marketplace_name in {k.split("@", 1)[1] for k in local_scanner.load_installed_plugins() if "@" in k}:
            if marketplace_name not in by_name and not any(m.name == marketplace_name for m in self._settings.marketplaces):
                self._settings.marketplaces.append(MarketplaceConfig(name=marketplace_name))
                changed = True

        if changed:
            save_settings(self._settings)

    # ---------- actions dispatched from items list ----------
    def _on_action(self, action: str, obj) -> None:
        if action == "install" and isinstance(obj, Plugin):
            self._install_plugin(obj)
        elif action == "update" and isinstance(obj, Plugin):
            self._install_plugin(obj)
        elif action == "uninstall" and isinstance(obj, Plugin):
            self._uninstall_plugin(obj)
        elif action == "install-all" and isinstance(obj, Plugin):
            self._install_all_for_plugin(obj)
        elif action == "install-all-mp" and isinstance(obj, Marketplace):
            self._install_all_for_marketplace(obj)
        elif action == "install-mp" and isinstance(obj, Marketplace):
            self._install_marketplace(obj)
        elif action == "uninstall-mp" and isinstance(obj, Marketplace):
            self._uninstall_marketplace(obj)
        elif action == "enable" and isinstance(obj, Plugin):
            self._set_plugin_enabled(obj, True)
        elif action == "disable" and isinstance(obj, Plugin):
            self._set_plugin_enabled(obj, False)
        elif action == "edit-vscode" and isinstance(obj, Skill):
            self._open_in_vscode(obj)
        elif action == "upload-local" and isinstance(obj, Plugin):
            self._upload_local_plugin(obj)
        elif action == "open-folder":
            self._open_folder(obj)
        elif action == "open-file" and isinstance(obj, SkillFile):
            self.detail.show_object(obj)
        elif action == "open-file-folder" and isinstance(obj, SkillFile):
            self._reveal_skill_file(obj)

    def _on_batch(self, action: str, plugins: list) -> None:
        if action == "install-many":
            self._install_many(plugins)
        elif action == "uninstall-many":
            self._uninstall_many(plugins)

    def _install_many(self, plugins: list[Plugin]) -> None:
        if not plugins:
            return
        ans = QMessageBox.question(
            self, "Install / update plugins",
            f"Install or update {len(plugins)} plugin(s)?\n\n"
            + "\n".join(f"  - {p.name}" for p in plugins[:15])
            + ("\n  ..." if len(plugins) > 15 else ""),
        )
        if ans != QMessageBox.Yes:
            return
        gh = GitHubClient(self._settings.github_token)
        failures: list[str] = []
        with busy_cursor():
            for p in plugins:
                if not p.source or not (p.source.repo or p.source.path):
                    failures.append(f"{p.name}: no resolvable source")
                    continue
                try:
                    installer.install_plugin(gh, p)
                except Exception as e:
                    failures.append(f"{p.name}: {e}")
        if failures:
            QMessageBox.warning(
                self, "Install completed with errors",
                f"{len(plugins) - len(failures)}/{len(plugins)} succeeded.\n\n" + "\n".join(failures),
            )
        else:
            self.statusBar().showMessage(f"Installed/updated {len(plugins)} plugin(s)")
        self.refresh()

    def _uninstall_many(self, plugins: list[Plugin]) -> None:
        if not plugins:
            return
        ans = QMessageBox.question(
            self, "Uninstall plugins",
            f"Uninstall {len(plugins)} plugin(s)?\n\n"
            + "\n".join(f"  - {p.name}" for p in plugins[:15])
            + ("\n  ..." if len(plugins) > 15 else ""),
        )
        if ans != QMessageBox.Yes:
            return
        failures: list[str] = []
        with busy_cursor():
            for p in plugins:
                try:
                    installer.uninstall(p)
                except Exception as e:
                    failures.append(f"{p.name}: {e}")
        if failures:
            QMessageBox.warning(
                self, "Uninstall completed with errors",
                f"{len(plugins) - len(failures)}/{len(plugins)} succeeded.\n\n" + "\n".join(failures),
            )
        else:
            self.statusBar().showMessage(f"Uninstalled {len(plugins)} plugin(s)")
        self.refresh()

    def _reveal_skill_file(self, sf: SkillFile) -> None:
        target = sf.path if sf.is_dir else sf.path.parent
        if not target.exists():
            QMessageBox.information(self, "Open folder", f"{target} does not exist.")
            return
        if sys.platform == "win32":
            os.startfile(str(target))  # noqa
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])

    def _set_plugin_enabled(self, plugin: Plugin, value: bool) -> None:
        try:
            plugin_state.set_enabled(plugin.name, plugin.marketplace_name, value)
        except Exception as e:
            QMessageBox.critical(self, "Toggle plugin failed", str(e))
            return
        plugin.enabled = value
        self.statusBar().showMessage(
            f"{plugin.name}: {'enabled' if value else 'disabled'}"
        )
        # Avoid full refresh for toggle — just update the detail card.
        self.detail.show_object(plugin)

    # ---------- top-level commands ----------
    def open_settings(self) -> None:
        dlg = SettingsDialog(self._settings, parent=self)
        if dlg.exec() == dlg.Accepted:
            self._settings = load_settings()
            self.refresh()

    def open_help(self) -> None:
        HelpDialog(parent=self).exec()

    def open_admin(self) -> None:
        if self._admin_dialog is None:
            self._admin_dialog = AdminDialog(self._settings, self._marketplaces, parent=self)
            self._admin_dialog.panel.marketplaces_changed.connect(self.refresh)
            self._admin_dialog.panel.refresh_requested.connect(self.refresh)
        else:
            self._admin_dialog.panel.set_state(self._settings, self._marketplaces)
        self._admin_dialog.show()
        self._admin_dialog.raise_()
        self._admin_dialog.activateWindow()
        self._kick_auth_check()

    def _add_marketplace_from_url(self) -> None:
        url, ok = QInputDialog.getText(
            self, "Add marketplace",
            "Git URL of the marketplace repo (e.g. https://github.com/owner/repo.git):",
        )
        if not ok or not url.strip():
            return
        repo = parse_github_marketplace_url(url.strip())
        if not repo:
            QMessageBox.warning(self, "Invalid URL", f"Cannot parse owner/repo from:\n{url}")
            return
        suggested = repo.split("/")[-1]
        name, ok = QInputDialog.getText(
            self, "Marketplace name", "Marketplace name:", text=suggested,
        )
        if not ok or not name.strip():
            return
        name = name.strip()
        existing = self._settings.get_marketplace(name)
        if existing:
            existing.github_repo = repo
        else:
            self._settings.marketplaces.append(MarketplaceConfig(name=name, github_repo=repo))
        save_settings(self._settings)
        self.statusBar().showMessage(f"Marketplace '{name}' added")
        self.refresh()

    def _upload_local_plugin(self, plugin: Plugin) -> None:
        self.open_admin()
        if self._admin_dialog:
            self._admin_dialog.panel.select_skills_tab_with_preselect(plugin)

    def _open_in_vscode(self, skill: Skill) -> None:
        folder = skill.folder
        if not folder or not folder.exists():
            QMessageBox.information(
                self, "Edit in VS Code",
                "This skill has no local folder yet — install the plugin first.",
            )
            return
        try:
            if sys.platform == "win32":
                subprocess.Popen(["code", str(folder)], shell=True)
            else:
                subprocess.Popen(["code", str(folder)])
        except FileNotFoundError:
            QMessageBox.warning(
                self, "VS Code not found",
                "Could not launch 'code'. Make sure Visual Studio Code is installed "
                "and the 'code' command is on your PATH.",
            )

    def _open_folder(self, obj) -> None:
        path: Path | None = None
        if isinstance(obj, Plugin):
            path = obj.install_path
        elif isinstance(obj, Skill):
            path = obj.folder
        elif isinstance(obj, Marketplace):
            if obj.source_path:
                path = Path(obj.source_path)
            elif obj.install_location:
                path = Path(obj.install_location)
        if not path or not path.exists():
            QMessageBox.information(self, "Open folder", "No local folder for that item.")
            return
        if sys.platform == "win32":
            os.startfile(str(path))  # noqa
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])

    def _install_plugin(self, plugin: Plugin) -> None:
        if not plugin.source or not (plugin.source.repo or plugin.source.path):
            QMessageBox.warning(
                self, "Install",
                f"Plugin '{plugin.name}' has no resolvable source.\n\n"
                f"Configure the marketplace's GitHub repo so the registry "
                f"can be fetched.",
            )
            return
        gh = GitHubClient(self._settings.github_token)
        try:
            with busy_cursor():
                installer.install_plugin(gh, plugin)
        except Exception as e:
            QMessageBox.critical(self, "Install failed", str(e))
            return
        self.statusBar().showMessage(f"Installed {plugin.name} {plugin.latest_version or ''}")
        self.refresh()

    def _uninstall_plugin(self, plugin: Plugin) -> None:
        ans = QMessageBox.question(self, "Uninstall",
            f"Uninstall {plugin.name} ({plugin.installed_version})?\n\n"
            f"This removes the cache folder and the entry in installed_plugins.json.")
        if ans != QMessageBox.Yes:
            return
        try:
            installer.uninstall(plugin)
        except Exception as e:
            QMessageBox.critical(self, "Uninstall failed", str(e))
            return
        self.statusBar().showMessage(f"Uninstalled {plugin.name}")
        self.refresh()

    def _install_all_for_plugin(self, plugin: Plugin) -> None:
        if plugin.install_state in (InstallState.NOT_INSTALLED, InstallState.OUTDATED):
            self._install_plugin(plugin)
        else:
            QMessageBox.information(self, "Install all", "Plugin already up to date.")

    def _install_all_for_marketplace(self, mp: Marketplace) -> None:
        targets = [p for p in mp.plugins if p.install_state in (InstallState.NOT_INSTALLED, InstallState.OUTDATED)]
        if not targets:
            QMessageBox.information(self, "Install all", "Everything in this marketplace is already up to date.")
            return
        for plugin in targets:
            self._install_plugin(plugin)

    def _install_marketplace(self, mp: Marketplace) -> None:
        if not mp.source_repo:
            QMessageBox.warning(
                self, "Install marketplace",
                f"'{mp.name}' has no GitHub repo configured. Open Admin, set the "
                f"GitHub repo for this marketplace, then try again.",
            )
            return
        cfg = self._settings.get_marketplace(mp.name)
        branch = (cfg.default_branch if cfg else "") or "main"
        auto_update = bool(cfg.auto_update) if cfg else None
        gh = GitHubClient(self._settings.github_token)
        try:
            with busy_cursor():
                marketplace_installer.install_marketplace(
                    gh, mp.name, mp.source_repo, ref=branch, auto_update=auto_update,
                )
        except Exception as e:
            QMessageBox.critical(self, "Install marketplace failed", str(e))
            return
        self.statusBar().showMessage(f"Marketplace '{mp.name}' installed")
        self.refresh()

    def _uninstall_marketplace(self, mp: Marketplace) -> None:
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Question)
        box.setWindowTitle("Uninstall marketplace")
        box.setText(f"Uninstall marketplace '{mp.name}'?")
        box.setInformativeText(
            f"This removes the entry from known_marketplaces.json and deletes "
            f"~/.claude/plugins/marketplaces/{mp.name}/.\n\n"
            f"Plugin install records (installed_plugins.json) are NOT touched."
        )
        forget = QCheckBox("Also remove from this app's marketplace list")
        forget.setToolTip(
            "Drops the entry from SkillManager's settings so the marketplace "
            "no longer appears in the rail. You can re-add it later via the "
            "+ button next to 'Marketplaces'."
        )
        box.setCheckBox(forget)
        box.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
        box.setDefaultButton(QMessageBox.No)
        if box.exec() != QMessageBox.Yes:
            return
        try:
            marketplace_installer.uninstall_marketplace(mp.name)
        except Exception as e:
            QMessageBox.critical(self, "Uninstall marketplace failed", str(e))
            return
        if forget.isChecked():
            self._settings.marketplaces = [
                m for m in self._settings.marketplaces if m.name != mp.name
            ]
            save_settings(self._settings)
        self.statusBar().showMessage(f"Marketplace '{mp.name}' uninstalled")
        self.refresh()

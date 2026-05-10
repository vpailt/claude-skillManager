"""Admin panel: full management of marketplaces, plugins and skills.

This is a `QWidget` embedded as a top-level tab of the main window — not a
dialog. Three sub-tabs:

  * **Marketplaces** — install/uninstall, auto-update toggle, edit name/repo,
    add a new marketplace from a Git URL. The "Editable" column is auto-detected
    from the active GitHub token's permissions on the marketplace repo and is
    read-only.

  * **Plugins** — for an editable marketplace, edit the plugin list:
    add a new plugin entry, bump a plugin's version, remove a plugin (with
    confirmation). All edits go through a PR against `marketplace.json`.

  * **Skills** — upload a local skill folder from `~/.claude/skills/<name>/`
    into one of the plugins of an editable marketplace (single flow that
    creates a new skill or overwrites an existing one), optionally bumping
    the plugin's manifest.json version + the skill's SKILL.md frontmatter
    `version` in the same PR; or delete a skill from a plugin. The PR
    targets the *plugin's* source repo when it's a separate repo; otherwise
    it targets the marketplace repo (monorepo).
"""
from __future__ import annotations

import json
import traceback
from typing import Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QLineEdit,
    QPushButton, QLabel, QMessageBox, QTabWidget,
    QComboBox, QTableWidget, QTableWidgetItem, QHeaderView, QCheckBox,
    QGroupBox, QInputDialog, QSizePolicy,
)

from .. import marketplace_installer, local_scanner, pending_prs
from ..admin import (
    FileChange, build_manifest_bump, submit_changes,
    collect_skill_folder_changes,
    fetch_marketplace_registry, serialize_registry,
    add_plugin_to_registry, remove_plugin_from_registry,
    update_plugin_in_registry,
)
from ..config import Settings, MarketplaceConfig, save_settings
from ..frontmatter import update_frontmatter
from ..github_client import GitHubClient, GitHubError
from ..models import Marketplace, Plugin, PluginSource, InstallState
from ..pending_prs import PendingPR
from ..registry import parse_github_marketplace_url
from .common import busy_cursor


_LOCAL_MP_NAME = local_scanner.LOCAL_MARKETPLACE_NAME


class AdminPanel(QWidget):
    """Embedded admin panel. Lives in a tab of the main window."""

    # Emitted when the user saved changes that affect the global marketplace
    # list (rename / add / remove / repo change). Main window listens to refresh.
    marketplaces_changed = Signal()

    # Emitted when the user clicks Refresh inside the panel — main window
    # listens and re-runs the full RefreshWorker so registry status (incl.
    # pending PRs that have just been merged) is brought up to date.
    refresh_requested = Signal()

    def __init__(self, settings: Settings, marketplaces: list[Marketplace], parent=None):
        super().__init__(parent)
        self._settings = settings
        self._marketplaces: list[Marketplace] = list(marketplaces)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)

        intro = QLabel(
            "Edits go through the GitHub API: a fresh branch is created on the "
            "target repo, the changed files are pushed via the Contents API, "
            "and a pull request is opened. No git CLI required."
        )
        intro.setWordWrap(True)
        intro.setStyleSheet("color: #555")
        layout.addWidget(intro)

        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_marketplaces_tab(), "Marketplaces")
        self.tabs.addTab(self._build_plugins_tab(), "Plugins")
        self.tabs.addTab(self._build_skills_tab(), "Skills")
        layout.addWidget(self.tabs, 1)

        self.status = QLabel("")
        self.status.setWordWrap(True)
        self.status.setStyleSheet("padding: 4px 0;")
        layout.addWidget(self.status)

    # ============================================================
    # Public API used by MainWindow
    # ============================================================
    def set_state(self, settings: Settings, marketplaces: list[Marketplace]) -> None:
        """Refresh panel-side state after a global refresh.

        Rebuilds the marketplaces table and the plugin/skill combos so the
        "Editable" column and target lists reflect the latest GitHub
        permissions and registry data.
        """
        self._settings = settings
        self._marketplaces = list(marketplaces)
        self._populate_mp_table()
        self._refresh_combos_after_mp_save()

    def select_skills_tab_with_preselect(self, plugin: Plugin) -> None:
        """Switch to Skills sub-tab and preselect a local skill for upload."""
        self.tabs.setCurrentIndex(2)
        self._preselect_skill_for_upload(plugin)

    # ============================================================
    # Helpers
    # ============================================================
    def _editable_marketplaces(self) -> list[Marketplace]:
        # Hide the synthetic "(local skills)" marketplace from upload targets.
        return [mp for mp in self._marketplaces
                if mp.editable and mp.name != _LOCAL_MP_NAME]

    def _is_editable(self, name: str) -> bool:
        for mp in self._marketplaces:
            if mp.name == name:
                return bool(mp.editable)
        return False

    def _repo_for(self, marketplace_name: str) -> tuple[str, str]:
        cfg = self._settings.get_marketplace(marketplace_name)
        if not cfg or not cfg.github_repo:
            raise RuntimeError(f"Marketplace '{marketplace_name}' has no GitHub repo configured")
        return cfg.github_repo, cfg.default_branch or "main"

    def _post_status(self, text: str, ok: bool = True) -> None:
        color = "#2e7d32" if ok else "#c62828"
        self.status.setStyleSheet(f"color: {color}; padding: 4px 0;")
        self.status.setText(text)

    @staticmethod
    def _plugin_target_repo(plugin: Plugin, marketplace_repo: str) -> tuple[str, str]:
        """Return (repo, subpath_in_repo) where the plugin's files live.

        - Separate plugin source repo (most common) → (plugin.source.repo, "").
        - Monorepo marketplace (no plugin.source.repo, or same repo) →
          (marketplace_repo, "<plugin>/" if multi-plugin else "").
        """
        src = plugin.source
        plugin_repo = (src.repo if src else "") or ""
        if plugin_repo and plugin_repo != marketplace_repo:
            return plugin_repo, ""
        return marketplace_repo, ""

    @staticmethod
    def _plugin_subpath_in_marketplace(plugin: Plugin, mp: Marketplace) -> str:
        """Where the plugin's files live *inside* the marketplace repo (monorepo)."""
        if len(mp.plugins) <= 1:
            return ""
        return f"{plugin.name}/"

    # ============================================================
    # Tab 1: Marketplaces
    # ============================================================
    def _build_marketplaces_tab(self) -> QWidget:
        page = QWidget()
        v = QVBoxLayout(page)

        self.mp_table = QTableWidget(0, 6)
        self.mp_table.setHorizontalHeaderLabels(
            ["Name", "GitHub repo", "Branch", "Editable", "Auto-update", "Installed"]
        )
        h = self.mp_table.horizontalHeader()
        h.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(1, QHeaderView.Stretch)
        h.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(4, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(5, QHeaderView.ResizeToContents)
        v.addWidget(self.mp_table)
        self._populate_mp_table()

        row = QHBoxLayout()
        add_url = QPushButton("Add from Git URL…")
        add_url.clicked.connect(self._mp_add_from_url)
        rename = QPushButton("Rename selected")
        rename.clicked.connect(self._mp_rename_selected)
        remove = QPushButton("Remove from list")
        remove.clicked.connect(self._mp_remove_selected)
        save_btn = QPushButton("Save changes")
        save_btn.clicked.connect(self._mp_save_changes)
        save_btn.setDefault(True)
        row.addWidget(add_url)
        row.addWidget(rename)
        row.addWidget(remove)
        row.addStretch(1)
        row.addWidget(save_btn)
        v.addLayout(row)

        hint = QLabel(
            "Edit the name / GitHub repo / branch directly in the table. "
            "The 'Editable' column is auto-detected from your GitHub token's "
            "permissions on each repo (refresh to re-check). Tick 'Auto-update' "
            "to re-pull on every refresh when the remote SHA changes. Use the "
            "Install / Uninstall button on the right to put the marketplace on "
            "disk under ~/.claude/plugins/marketplaces/."
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #555")
        v.addWidget(hint)
        return page

    def _populate_mp_table(self) -> None:
        cfgs = list(self._settings.marketplaces)
        self.mp_table.setRowCount(len(cfgs))
        for row, cfg in enumerate(cfgs):
            self._fill_mp_row(row, cfg)

    def _fill_mp_row(self, row: int, cfg: MarketplaceConfig) -> None:
        self.mp_table.setItem(row, 0, QTableWidgetItem(cfg.name))
        self.mp_table.setItem(row, 1, QTableWidgetItem(cfg.github_repo))
        self.mp_table.setItem(row, 2, QTableWidgetItem(cfg.default_branch or "main"))
        self.mp_table.setCellWidget(row, 3, self._build_editable_cell(cfg.name))
        cb_auto = QCheckBox()
        cb_auto.setChecked(cfg.auto_update)
        cb_auto.setStyleSheet("margin-left:10px;")
        cb_auto.setToolTip(
            "Re-pull on every refresh when the remote commit SHA differs."
        )
        self.mp_table.setCellWidget(row, 4, cb_auto)
        self.mp_table.setCellWidget(row, 5, self._build_install_cell(cfg.name))

    def _build_editable_cell(self, name: str) -> QWidget:
        editable = self._is_editable(name)
        cb = QCheckBox()
        cb.setChecked(editable)
        cb.setStyleSheet("margin-left:10px;")
        cb.setAttribute(Qt.WA_TransparentForMouseEvents)
        cb.setFocusPolicy(Qt.NoFocus)
        cb.setToolTip(
            "Auto-detected from GitHub permissions: checked if your token has "
            "write access (push/maintain/admin) on the marketplace repo. "
            "Refresh to re-check."
        )
        return cb

    def _build_install_cell(self, name: str) -> QWidget:
        installed = marketplace_installer.is_marketplace_installed(name)
        cell = QWidget()
        h = QHBoxLayout(cell)
        h.setContentsMargins(4, 0, 4, 0)
        h.setSpacing(6)
        label = QLabel("Yes" if installed else "No")
        label.setStyleSheet("color: #2e7d32" if installed else "color: #9aa3ad")
        h.addWidget(label)
        btn = QPushButton("Uninstall" if installed else "Install")
        btn.clicked.connect(lambda _=False, n=name: self._mp_toggle_install(n))
        h.addWidget(btn)
        h.addStretch(1)
        return cell

    def _refresh_install_cell(self, name: str) -> None:
        for row in range(self.mp_table.rowCount()):
            item = self.mp_table.item(row, 0)
            if item and item.text() == name:
                self.mp_table.setCellWidget(row, 5, self._build_install_cell(name))
                return

    def _mp_row_data(self, row: int) -> Optional[MarketplaceConfig]:
        try:
            name = (self.mp_table.item(row, 0).text() or "").strip()
            repo = (self.mp_table.item(row, 1).text() or "").strip()
            branch = (self.mp_table.item(row, 2).text() or "").strip() or "main"
            auto_update = bool(self.mp_table.cellWidget(row, 4).isChecked())
        except Exception:
            return None
        if not name:
            return None
        previous = self._settings.get_marketplace(name)
        source_path = previous.source_path if previous else ""
        owned = previous.owned if previous else False  # legacy field, preserved as-is
        return MarketplaceConfig(
            name=name, github_repo=repo, default_branch=branch,
            owned=owned, source_path=source_path, auto_update=auto_update,
        )

    def _mp_toggle_install(self, name: str) -> None:
        if marketplace_installer.is_marketplace_installed(name):
            self._mp_uninstall(name)
        else:
            self._mp_install(name)

    def _mp_install(self, name: str) -> None:
        cfg: Optional[MarketplaceConfig] = None
        for row in range(self.mp_table.rowCount()):
            if self.mp_table.item(row, 0) and self.mp_table.item(row, 0).text() == name:
                cfg = self._mp_row_data(row)
                break
        if not cfg or not cfg.github_repo:
            QMessageBox.warning(self, "Install marketplace",
                f"'{name}' has no GitHub repo configured. Fill the 'GitHub repo' "
                f"column first, then try again.")
            return
        gh = GitHubClient(self._settings.github_token)
        try:
            with busy_cursor():
                marketplace_installer.install_marketplace(
                    gh, name, cfg.github_repo, ref=cfg.default_branch or "",
                    auto_update=cfg.auto_update,
                )
        except Exception as e:
            QMessageBox.critical(self, "Install failed", str(e))
            return
        self._refresh_install_cell(name)
        self._post_status(f"Marketplace '{name}' installed.", ok=True)
        self.marketplaces_changed.emit()

    def _mp_uninstall(self, name: str) -> None:
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Question)
        box.setWindowTitle("Uninstall marketplace")
        box.setText(f"Uninstall marketplace '{name}'?")
        box.setInformativeText(
            f"This removes the entry from known_marketplaces.json and deletes "
            f"~/.claude/plugins/marketplaces/{name}/.\n\n"
            f"Plugin install records (installed_plugins.json) are NOT touched."
        )
        forget = QCheckBox("Also remove from this app's marketplace list")
        forget.setToolTip(
            "Drops the entry from SkillManager's settings so the marketplace "
            "no longer appears in Browse / Admin. You can re-add it later via "
            "'Add from Git URL…'."
        )
        box.setCheckBox(forget)
        box.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
        box.setDefaultButton(QMessageBox.No)
        if box.exec() != QMessageBox.Yes:
            return
        try:
            marketplace_installer.uninstall_marketplace(name)
        except Exception as e:
            QMessageBox.critical(self, "Uninstall failed", str(e))
            return
        if forget.isChecked():
            self._settings.marketplaces = [
                m for m in self._settings.marketplaces if m.name != name
            ]
            save_settings(self._settings)
        self._refresh_install_cell(name)
        self._post_status(f"Marketplace '{name}' uninstalled.", ok=True)
        self.marketplaces_changed.emit()

    def _mp_add_from_url(self) -> None:
        url, ok = QInputDialog.getText(
            self, "Add marketplace",
            "Git URL of the marketplace repo "
            "(e.g. https://github.com/owner/repo or https://github.com/owner/repo.git):",
        )
        if not ok:
            return
        url_clean = url.strip()
        if not url_clean:
            QMessageBox.warning(self, "Add marketplace",
                "URL is empty. Paste a GitHub repo URL like "
                "https://github.com/owner/repo and try again.")
            return
        repo = parse_github_marketplace_url(url_clean)
        if not repo:
            QMessageBox.warning(self, "Invalid URL",
                f"Cannot parse a GitHub owner/repo from:\n\n{url_clean}\n\n"
                f"Expected formats:\n"
                f"  • https://github.com/owner/repo\n"
                f"  • https://github.com/owner/repo.git\n"
                f"  • git@github.com:owner/repo.git")
            return
        name = repo.split("/")[-1]
        existing_row = -1
        for row in range(self.mp_table.rowCount()):
            if self.mp_table.item(row, 0) and self.mp_table.item(row, 0).text() == name:
                existing_row = row
                break
        if existing_row >= 0:
            self.mp_table.setItem(existing_row, 1, QTableWidgetItem(repo))
            self.mp_table.selectRow(existing_row)
            self.mp_table.scrollToItem(self.mp_table.item(existing_row, 0))
            self._post_status(
                f"Updated repo for existing marketplace '{name}' → {repo}. "
                f"Click 'Save changes' to persist, or 'Rename selected' to give it a different name.",
                ok=True,
            )
            return
        cfg = MarketplaceConfig(name=name, github_repo=repo)
        row = self.mp_table.rowCount()
        self.mp_table.insertRow(row)
        self._fill_mp_row(row, cfg)
        self.mp_table.selectRow(row)
        self.mp_table.scrollToItem(self.mp_table.item(row, 0))
        self._post_status(
            f"Added marketplace '{name}' ({repo}). "
            f"Click 'Save changes' to persist, or 'Rename selected' to change the name.",
            ok=True,
        )

    def _mp_rename_selected(self) -> None:
        rows = sorted({i.row() for i in self.mp_table.selectedIndexes()})
        if not rows:
            return
        row = rows[0]
        old_item = self.mp_table.item(row, 0)
        old_name = old_item.text() if old_item else ""
        new_name, ok = QInputDialog.getText(
            self, "Rename marketplace", "New name:", text=old_name,
        )
        if not ok or not new_name.strip() or new_name.strip() == old_name:
            return
        if marketplace_installer.is_marketplace_installed(old_name):
            QMessageBox.information(
                self, "Rename note",
                f"'{old_name}' is currently installed locally. The settings entry "
                f"will be renamed to '{new_name.strip()}', but the on-disk folder "
                f"and known_marketplaces.json record keep the old name until you "
                f"reinstall.",
            )
        self.mp_table.setItem(row, 0, QTableWidgetItem(new_name.strip()))

    def _mp_remove_selected(self) -> None:
        rows = sorted({i.row() for i in self.mp_table.selectedIndexes()}, reverse=True)
        for r in rows:
            name = self.mp_table.item(r, 0).text() if self.mp_table.item(r, 0) else ""
            if name and marketplace_installer.is_marketplace_installed(name):
                ans = QMessageBox.question(
                    self, "Marketplace is installed",
                    f"'{name}' is installed locally. Removing it from this list "
                    f"only removes the settings entry — the local files and the "
                    f"known_marketplaces.json record stay (use 'Uninstall' first "
                    f"if you want to clean those up).\n\nContinue?",
                )
                if ans != QMessageBox.Yes:
                    continue
            self.mp_table.removeRow(r)

    def _mp_save_changes(self) -> None:
        new_cfgs: list[MarketplaceConfig] = []
        names: set[str] = set()
        for row in range(self.mp_table.rowCount()):
            cfg = self._mp_row_data(row)
            if cfg is None:
                continue
            if cfg.name in names:
                QMessageBox.warning(self, "Duplicate name",
                    f"Two rows share the name '{cfg.name}'. Names must be unique.")
                return
            names.add(cfg.name)
            new_cfgs.append(cfg)
        self._settings.marketplaces = new_cfgs
        save_settings(self._settings)
        for cfg in new_cfgs:
            try:
                marketplace_installer.set_auto_update(cfg.name, cfg.auto_update)
            except Exception:
                pass
        self._refresh_combos_after_mp_save()
        self._post_status("Marketplace settings saved.", ok=True)
        self.marketplaces_changed.emit()

    def _refresh_combos_after_mp_save(self) -> None:
        # Plugins tab
        self.plug_mp_combo.clear()
        for mp in self._editable_marketplaces():
            self.plug_mp_combo.addItem(mp.name, mp)
        # Skills tab — every marketplace combo
        for combo in (self.skill_mp_combo, self.del_mp_combo):
            combo.clear()
            for mp in self._editable_marketplaces():
                combo.addItem(mp.name, mp)

    # ============================================================
    # Tab 2: Plugins (manage marketplace.json entries)
    # ============================================================
    def _build_plugins_tab(self) -> QWidget:
        page = QWidget()
        v = QVBoxLayout(page)

        top = QHBoxLayout()
        top.addWidget(QLabel("Editable marketplace:"))
        self.plug_mp_combo = QComboBox()
        self.plug_mp_combo.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        top.addWidget(self.plug_mp_combo, 1)
        refresh_btn = QPushButton("Refresh")
        refresh_btn.setToolTip(
            "Re-fetch marketplace registries from GitHub and re-evaluate "
            "pending PR statuses. Use after a PR has been merged to mark "
            "the plugin as Active."
        )
        refresh_btn.clicked.connect(self.refresh_requested.emit)
        top.addWidget(refresh_btn)
        v.addLayout(top)

        self.plug_table = QTableWidget(0, 5)
        self.plug_table.setHorizontalHeaderLabels(
            ["Plugin", "Version", "Source repo", "Status", "Description"])
        h = self.plug_table.horizontalHeader()
        h.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(4, QHeaderView.Stretch)
        v.addWidget(self.plug_table)

        for mp in self._editable_marketplaces():
            self.plug_mp_combo.addItem(mp.name, mp)
        self.plug_mp_combo.currentIndexChanged.connect(self._on_plug_mp_changed)

        row = QHBoxLayout()
        add_btn = QPushButton("Add new plugin…")
        add_btn.clicked.connect(self._plug_add_new)
        bump_btn = QPushButton("Bump version…")
        bump_btn.clicked.connect(self._plug_bump_selected)
        del_btn = QPushButton("Remove from marketplace…")
        del_btn.clicked.connect(self._plug_remove_selected)
        clear_pending_btn = QPushButton("Clear pending status")
        clear_pending_btn.setToolTip(
            "Drop the locally-tracked pending PR for the selected plugin "
            "(useful once the PR is merged or closed).")
        clear_pending_btn.clicked.connect(self._plug_clear_pending)
        row.addWidget(add_btn)
        row.addWidget(bump_btn)
        row.addWidget(del_btn)
        row.addWidget(clear_pending_btn)
        row.addStretch(1)
        v.addLayout(row)

        hint = QLabel(
            "Each action opens a pull request against the marketplace's "
            ".claude-plugin/marketplace.json. You can also bump a plugin's "
            "version inside its own source repo (manifest.json) from the "
            "Skills tab → Bump."
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #555")
        v.addWidget(hint)

        self._on_plug_mp_changed()
        return page

    def _on_plug_mp_changed(self) -> None:
        mp = self.plug_mp_combo.currentData()
        if not isinstance(mp, Marketplace):
            self.plug_table.setRowCount(0)
            self._plug_table_rows = []
            return
        self._auto_clear_resolved_pending(mp)
        rows = self._build_plug_table_rows(mp)
        self._plug_table_rows = rows
        self.plug_table.setRowCount(len(rows))
        for r, (plugin, pending) in enumerate(rows):
            self.plug_table.setItem(r, 0, QTableWidgetItem(plugin.name))
            version = (pending.new_version if pending else "") or \
                      plugin.latest_version or plugin.installed_version or ""
            self.plug_table.setItem(r, 1, QTableWidgetItem(version))
            src_repo = plugin.source.repo if plugin.source else ""
            self.plug_table.setItem(r, 2, QTableWidgetItem(src_repo))
            status_item = QTableWidgetItem(self._format_plugin_status(plugin, pending))
            if pending:
                status_item.setToolTip(f"Pending PR: {pending.pr_url}")
            self.plug_table.setItem(r, 3, status_item)
            self.plug_table.setItem(r, 4, QTableWidgetItem(plugin.description or ""))

    @staticmethod
    def _format_plugin_status(plugin: Plugin, pending: Optional[PendingPR]) -> str:
        if pending:
            label = {"add": "add", "bump": "bump", "remove": "remove"}.get(pending.action, pending.action)
            num = f"#{pending.pr_number}" if pending.pr_number else "PR"
            return f"Pending {label} ({num})"
        if plugin.remote_present or plugin.latest_version:
            return "Active"
        return "—"

    @staticmethod
    def _auto_clear_resolved_pending(mp: Marketplace) -> None:
        """Drop pending entries whose change is already visible in the registry.

        Heuristics:
         - "add"    → plugin name is now in the registry.
         - "bump"   → registry's latest_version matches the pending new_version.
         - "remove" → plugin name is no longer in the registry.
        """
        pending_list = pending_prs.for_marketplace(mp.name)
        if not pending_list:
            return
        by_name = {p.name: p for p in mp.plugins}
        for pending in pending_list:
            current = by_name.get(pending.plugin_name)
            resolved = False
            if pending.action == "add":
                resolved = current is not None
            elif pending.action == "bump":
                if current is not None and pending.new_version:
                    resolved = (current.latest_version or "") == pending.new_version
            elif pending.action == "remove":
                resolved = current is None
            if resolved:
                pending_prs.remove(pending.marketplace_name,
                                   pending.plugin_name, pending.action)

    def _build_plug_table_rows(self, mp: Marketplace) -> list[tuple[Plugin, Optional[PendingPR]]]:
        """Combine the registry plugins with any locally-tracked pending PRs.

        - Existing plugins get their pending PR (if any) attached.
        - Pending "add" PRs whose plugin isn't yet in the registry are surfaced
          as synthetic Plugin rows so the user sees them immediately.
        """
        pending_list = pending_prs.for_marketplace(mp.name)
        pending_by_name = {p.plugin_name: p for p in pending_list}
        out: list[tuple[Plugin, Optional[PendingPR]]] = []
        seen_names: set[str] = set()
        for plugin in mp.plugins:
            seen_names.add(plugin.name)
            out.append((plugin, pending_by_name.get(plugin.name)))
        for pending in pending_list:
            if pending.plugin_name in seen_names:
                continue
            if pending.action != "add":
                continue
            synthetic = Plugin(
                name=pending.plugin_name,
                marketplace_name=mp.name,
                latest_version=pending.new_version or None,
                description="(not yet in registry — pending PR)",
                source=PluginSource(
                    kind="url",
                    repo=pending.plugin_source_repo or "",
                ),
                install_state=InstallState.NOT_INSTALLED,
                remote_present=False,
            )
            out.append((synthetic, pending))
        return out

    def _selected_plugin_in_plug_tab(self) -> Optional[Plugin]:
        rows = sorted({i.row() for i in self.plug_table.selectedIndexes()})
        if not rows:
            QMessageBox.information(self, "Pick a plugin", "Select a plugin row first.")
            return None
        try:
            plugin, _ = self._plug_table_rows[rows[0]]
        except (AttributeError, IndexError):
            return None
        return plugin

    def _selected_pending_in_plug_tab(self) -> Optional[PendingPR]:
        rows = sorted({i.row() for i in self.plug_table.selectedIndexes()})
        if not rows:
            return None
        try:
            _, pending = self._plug_table_rows[rows[0]]
        except (AttributeError, IndexError):
            return None
        return pending

    def _ensure_plugin_ref_exists(self, gh: GitHubClient, repo_slug: str, version: str) -> bool:
        """Make sure `version` is a reachable ref on the plugin's source repo.

        Required because the marketplace.json entry will use `ref=version`, and
        `installer.install_plugin` calls `download_zipball(repo, ref)` — a ref
        that doesn't exist results in a 404 on every install attempt.

        If the ref is missing, asks the user whether to create a tag at the
        plugin repo's HEAD. Returns False if the user cancels or the tag could
        not be created (so the caller aborts the PR).
        """
        try:
            with busy_cursor():
                if gh.ref_exists(repo_slug, version):
                    return True
        except Exception as e:
            QMessageBox.warning(self, "Add plugin",
                f"Could not check refs on {repo_slug}:\n{e}")
            return False

        ans = QMessageBox.question(
            self, "Tag missing on plugin repo",
            f"The plugin repo {repo_slug} has no tag, branch, or commit "
            f"named `{version}`.\n\n"
            f"The marketplace entry will pin `ref` to `{version}`, so installs "
            f"will 404 until that ref exists.\n\n"
            f"Create tag `{version}` at the HEAD of {repo_slug}'s default "
            f"branch now?",
            QMessageBox.Yes | QMessageBox.No,
        )
        if ans != QMessageBox.Yes:
            self._post_status(
                f"Add plugin aborted: tag `{version}` missing on {repo_slug}.",
                ok=False)
            return False

        try:
            with busy_cursor():
                default_branch = gh.get_default_branch(repo_slug)
                head_sha = gh.get_branch_sha(repo_slug, default_branch)
                gh.create_tag(repo_slug, version, head_sha)
        except GitHubError as e:
            msg = str(e)
            if "404" in msg or "403" in msg:
                hint = (f"Your token may not have push access to {repo_slug}. "
                        f"Create the tag manually:\n\n"
                        f"  git tag {version}\n"
                        f"  git push origin {version}\n\n"
                        f"Then retry adding the plugin.")
            else:
                hint = "Try creating the tag manually and retry."
            QMessageBox.warning(self, "Could not create tag",
                f"Failed to tag {repo_slug}@{version}:\n{e}\n\n{hint}")
            return False
        except Exception as e:
            QMessageBox.warning(self, "Could not create tag",
                f"Unexpected error tagging {repo_slug}@{version}:\n{e}")
            return False

        self._post_status(f"Created tag {version} on {repo_slug}.", ok=True)
        return True

    def _plug_add_new(self) -> None:
        try:
            self._plug_add_new_impl()
        except Exception as e:
            tb = traceback.format_exc()
            self._post_status(f"Add plugin crashed: {e}", ok=False)
            box = QMessageBox(self)
            box.setIcon(QMessageBox.Critical)
            box.setWindowTitle("Add plugin failed")
            box.setText(f"An unexpected error occurred while adding the plugin:\n\n{e}")
            box.setDetailedText(tb)
            box.exec()

    def _plug_add_new_impl(self) -> None:
        mp = self.plug_mp_combo.currentData()
        if not isinstance(mp, Marketplace):
            QMessageBox.warning(self, "Add plugin", "Select an editable marketplace first.")
            return
        try:
            repo, branch = self._repo_for(mp.name)
        except RuntimeError as e:
            QMessageBox.warning(self, "Configuration", str(e))
            return

        source_url, ok = QInputDialog.getText(
            self, "Add new plugin",
            "Git URL of the plugin source repo (must contain manifest.json at its root):",
        )
        if not ok:
            return
        source_url = source_url.strip()
        if not source_url:
            QMessageBox.warning(self, "Add plugin",
                "URL is empty. Paste a GitHub repo URL and try again.")
            return
        repo_slug = parse_github_marketplace_url(source_url)
        if not repo_slug:
            QMessageBox.warning(self, "Invalid URL",
                f"Cannot parse a GitHub owner/repo from:\n\n{source_url}\n\n"
                f"Expected formats:\n"
                f"  • https://github.com/owner/repo\n"
                f"  • https://github.com/owner/repo.git\n"
                f"  • git@github.com:owner/repo.git")
            return
        self._post_status(f"Fetching manifest.json from {repo_slug}…", ok=True)

        gh = GitHubClient(self._settings.github_token)
        try:
            with busy_cursor():
                manifest_text, _ = gh.get_file(repo_slug, "manifest.json")
        except GitHubError as e:
            # GitHub returns 404 for both "file missing" and "repo private/no access".
            # Probe the repo itself to tell the cases apart and produce a useful message.
            if "404" in str(e):
                repo_accessible = False
                probe_err = ""
                try:
                    with busy_cursor():
                        gh.get_repo(repo_slug)
                    repo_accessible = True
                except Exception as e2:
                    probe_err = str(e2)
                if repo_accessible:
                    QMessageBox.warning(self, "manifest.json not found",
                        f"The repository {repo_slug} is accessible but has no "
                        f"manifest.json at its root.\n\n"
                        f"The plugin repository must contain a manifest.json at "
                        f"its root with `name`, `version`, and `description` fields.")
                else:
                    has_token = bool(self._settings.github_token.strip())
                    detail = ("Your GitHub token may lack access to it." if has_token
                              else "No GitHub token is configured — set one in Settings if the repo is private.")
                    QMessageBox.warning(self, "Repository not accessible",
                        f"Could not access {repo_slug}.\n\n"
                        f"This usually means one of:\n"
                        f"  • the owner/repo is misspelled,\n"
                        f"  • the repository is private and your token lacks the `repo` scope or access grant,\n"
                        f"  • the repository was renamed or deleted.\n\n"
                        f"{detail}\n\n"
                        f"GitHub said: {probe_err or e}")
            else:
                QMessageBox.warning(self, "GitHub error",
                    f"Could not read manifest.json from {repo_slug}:\n{e}")
            return
        except Exception as e:
            QMessageBox.warning(self, "Could not read manifest.json",
                f"Unexpected error fetching manifest.json from {repo_slug}:\n{e}")
            return

        try:
            manifest = json.loads(manifest_text)
            if not isinstance(manifest, dict):
                raise ValueError("root must be a JSON object")
        except (json.JSONDecodeError, ValueError) as e:
            QMessageBox.warning(self, "Invalid manifest.json",
                f"manifest.json in {repo_slug} is not valid JSON: {e}")
            return

        def _as_str(v) -> str:
            return str(v).strip() if v is not None else ""
        name = _as_str(manifest.get("name")) or repo_slug.split("/")[-1]
        version = _as_str(manifest.get("version"))
        description = _as_str(manifest.get("description"))
        if not version:
            QMessageBox.warning(self, "Missing version",
                f"manifest.json in {repo_slug} has no `version` field.")
            return

        if not self._ensure_plugin_ref_exists(gh, repo_slug, version):
            return

        source: dict = {
            "source": "url",
            "url": source_url,
            "repo": repo_slug,
            "ref": version,
        }

        try:
            with busy_cursor():
                registry, registry_path, _ = fetch_marketplace_registry(gh, repo, ref=branch)
                new_reg = add_plugin_to_registry(
                    registry, name=name, version=version,
                    description=description, source=source,
                )
                change = FileChange(path=registry_path, content=serialize_registry(new_reg))
                result = submit_changes(
                    gh, repo, branch, [change],
                    pr_title=f"Add plugin: {name}",
                    pr_body=f"Adds plugin `{name}` v{version} to the marketplace registry.\n\n{description}",
                    branch_prefix="skillmanager/add-plugin",
                )
        except Exception as e:
            self._post_status(f"Add plugin failed: {e}", ok=False)
            QMessageBox.warning(self, "Add plugin failed",
                f"Could not open a pull request to add `{name}` v{version} to "
                f"`{repo}`:\n\n{e}")
            return
        pending_prs.upsert(PendingPR(
            marketplace_name=mp.name,
            plugin_name=name,
            action="add",
            pr_url=result.pr_url,
            pr_number=result.pr_number,
            branch=result.branch,
            target_repo=repo,
            new_version=version,
            plugin_source_repo=repo_slug,
        ))
        self._on_plug_mp_changed()
        msg = (f"Pull request opened to add `{name}` v{version} to `{repo}`.\n\n"
               f"{result.pr_url}\n\n"
               f"The plugin is now listed with status \"Pending add\". "
               f"Once the PR is merged, click \"Clear pending status\" or "
               f"refresh from the main window to mark it Active.")
        self._post_status(
            f"PR opened: {result.pr_url}  (detected {name} v{version} from {repo_slug})",
            ok=True,
        )
        box = QMessageBox(QMessageBox.Information, "Plugin added", msg, QMessageBox.Ok, self)
        box.setTextInteractionFlags(Qt.TextBrowserInteraction)
        box.exec()

    def _plug_bump_selected(self) -> None:
        plugin = self._selected_plugin_in_plug_tab()
        if not plugin:
            return
        mp = self.plug_mp_combo.currentData()
        if not isinstance(mp, Marketplace):
            return
        try:
            repo, branch = self._repo_for(mp.name)
        except RuntimeError as e:
            QMessageBox.warning(self, "Configuration", str(e))
            return
        new_version, ok = QInputDialog.getText(
            self, "Bump version",
            f"New version for '{plugin.name}':",
            text=plugin.latest_version or plugin.installed_version or "",
        )
        if not ok or not new_version.strip():
            return
        gh = GitHubClient(self._settings.github_token)
        try:
            with busy_cursor():
                registry, registry_path, _ = fetch_marketplace_registry(gh, repo, ref=branch)
                new_reg = update_plugin_in_registry(registry, plugin.name, version=new_version.strip())
                change = FileChange(path=registry_path, content=serialize_registry(new_reg))
                result = submit_changes(
                    gh, repo, branch, [change],
                    pr_title=f"Bump {plugin.name} to {new_version.strip()}",
                    pr_body=f"Updates `{plugin.name}` to version `{new_version.strip()}` in the marketplace registry.",
                    branch_prefix="skillmanager/bump-mp",
                )
        except Exception as e:
            self._post_status(f"Bump failed: {e}", ok=False)
            QMessageBox.warning(self, "Bump failed",
                f"Could not open a pull request to bump `{plugin.name}` to "
                f"`{new_version.strip()}`:\n\n{e}")
            return
        pending_prs.upsert(PendingPR(
            marketplace_name=mp.name,
            plugin_name=plugin.name,
            action="bump",
            pr_url=result.pr_url,
            pr_number=result.pr_number,
            branch=result.branch,
            target_repo=repo,
            new_version=new_version.strip(),
        ))
        self._on_plug_mp_changed()
        self._post_status(f"PR opened: {result.pr_url}", ok=True)
        box = QMessageBox(QMessageBox.Information, "Bump submitted",
            f"Pull request opened to bump `{plugin.name}` to "
            f"`{new_version.strip()}`:\n\n{result.pr_url}",
            QMessageBox.Ok, self)
        box.setTextInteractionFlags(Qt.TextBrowserInteraction)
        box.exec()

    def _plug_remove_selected(self) -> None:
        plugin = self._selected_plugin_in_plug_tab()
        if not plugin:
            return
        mp = self.plug_mp_combo.currentData()
        if not isinstance(mp, Marketplace):
            return
        ans = QMessageBox.question(
            self, "Remove plugin",
            f"Remove '{plugin.name}' from the '{mp.name}' marketplace registry?\n\n"
            f"This opens a PR that drops the plugin entry from "
            f".claude-plugin/marketplace.json. The plugin's own source repo is "
            f"NOT touched.",
        )
        if ans != QMessageBox.Yes:
            return
        try:
            repo, branch = self._repo_for(mp.name)
        except RuntimeError as e:
            QMessageBox.warning(self, "Configuration", str(e))
            return
        gh = GitHubClient(self._settings.github_token)
        try:
            with busy_cursor():
                registry, registry_path, _ = fetch_marketplace_registry(gh, repo, ref=branch)
                new_reg = remove_plugin_from_registry(registry, plugin.name)
                change = FileChange(path=registry_path, content=serialize_registry(new_reg))
                result = submit_changes(
                    gh, repo, branch, [change],
                    pr_title=f"Remove plugin: {plugin.name}",
                    pr_body=f"Removes `{plugin.name}` from the marketplace registry.",
                    branch_prefix="skillmanager/remove-plugin",
                )
        except Exception as e:
            self._post_status(f"Remove failed: {e}", ok=False)
            QMessageBox.warning(self, "Remove failed",
                f"Could not open a pull request to remove `{plugin.name}`:\n\n{e}")
            return
        pending_prs.upsert(PendingPR(
            marketplace_name=mp.name,
            plugin_name=plugin.name,
            action="remove",
            pr_url=result.pr_url,
            pr_number=result.pr_number,
            branch=result.branch,
            target_repo=repo,
        ))
        self._on_plug_mp_changed()
        self._post_status(f"PR opened: {result.pr_url}", ok=True)
        box = QMessageBox(QMessageBox.Information, "Removal submitted",
            f"Pull request opened to remove `{plugin.name}`:\n\n{result.pr_url}",
            QMessageBox.Ok, self)
        box.setTextInteractionFlags(Qt.TextBrowserInteraction)
        box.exec()

    def _plug_clear_pending(self) -> None:
        rows = sorted({i.row() for i in self.plug_table.selectedIndexes()})
        if not rows:
            QMessageBox.information(self, "Pick a plugin",
                "Select a plugin row first.")
            return
        try:
            plugin, pending = self._plug_table_rows[rows[0]]
        except (AttributeError, IndexError):
            return
        if not pending:
            QMessageBox.information(self, "No pending PR",
                f"`{plugin.name}` has no locally-tracked pending PR.")
            return
        ans = QMessageBox.question(
            self, "Clear pending status",
            f"Drop the locally-tracked pending {pending.action} PR for "
            f"`{plugin.name}` (#{pending.pr_number})?\n\n"
            f"This does not touch the PR on GitHub — it only clears the "
            f"\"Pending\" badge in this table.",
        )
        if ans != QMessageBox.Yes:
            return
        pending_prs.remove(pending.marketplace_name, pending.plugin_name, pending.action)
        self._on_plug_mp_changed()

    # ============================================================
    # Tab 3: Skills (upload create-or-update, delete)
    # ============================================================
    def _build_skills_tab(self) -> QWidget:
        page = QWidget()
        v = QVBoxLayout(page)

        # ---- Subgroup A: upload a local skill folder (create or update)
        gb_local = QGroupBox(
            "Upload a skill folder (create or update — ~/.claude/skills/<name>/)"
        )
        f1 = QFormLayout(gb_local)
        self.local_skill_combo = QComboBox()
        for us in local_scanner.scan_user_skills():
            self.local_skill_combo.addItem(f"{us.name}  —  {us.folder}", us)
        if self.local_skill_combo.count() == 0:
            self.local_skill_combo.addItem("(no local skills found)", None)
            self.local_skill_combo.setEnabled(False)
        f1.addRow("Local skill:", self.local_skill_combo)

        self.skill_mp_combo = QComboBox()
        self.skill_plugin_combo = QComboBox()
        self.skill_mp_combo.currentIndexChanged.connect(self._refresh_plugins_for_skill_tab)
        for mp in self._editable_marketplaces():
            self.skill_mp_combo.addItem(mp.name, mp)
        f1.addRow("Target marketplace:", self.skill_mp_combo)
        f1.addRow("Target plugin:", self.skill_plugin_combo)
        self._refresh_plugins_for_skill_tab()

        self.skill_target_name = QLineEdit()
        self.skill_target_name.setPlaceholderText("(defaults to the local skill's name)")
        f1.addRow("Skill name in repo:", self.skill_target_name)

        self.skill_version_edit = QLineEdit()
        self.skill_version_edit.setPlaceholderText(
            "e.g. 1.7.6 — written into both manifest.json and SKILL.md "
            "frontmatter (leave empty to skip)"
        )
        f1.addRow("New version:", self.skill_version_edit)

        upload_btn = QPushButton("Upload skill folder + open PR")
        upload_btn.setToolTip(
            "Creates the skill if it doesn't exist on the plugin's repo, "
            "or overwrites the existing files. If 'New version' is filled, "
            "the plugin's manifest.json and the skill's SKILL.md frontmatter "
            "are both bumped to that version in the same PR."
        )
        upload_btn.clicked.connect(self._submit_local_skill_upload)
        f1.addRow("", upload_btn)
        v.addWidget(gb_local)

        # ---- Subgroup B: delete a skill from a plugin
        gb_delete = QGroupBox("Delete a skill from a plugin")
        f2 = QFormLayout(gb_delete)
        self.del_mp_combo = QComboBox()
        self.del_plugin_combo = QComboBox()
        self.del_skill_combo = QComboBox()
        self.del_mp_combo.currentIndexChanged.connect(self._refresh_plugins_for_delete_tab)
        self.del_plugin_combo.currentIndexChanged.connect(self._refresh_skills_for_delete_tab)
        for mp in self._editable_marketplaces():
            self.del_mp_combo.addItem(mp.name, mp)
        self._refresh_plugins_for_delete_tab()
        f2.addRow("Marketplace:", self.del_mp_combo)
        f2.addRow("Plugin:", self.del_plugin_combo)
        f2.addRow("Skill to delete:", self.del_skill_combo)
        del_btn = QPushButton("Delete skill + open PR")
        del_btn.setToolTip(
            "Opens a PR that removes every file under the skill's folder on "
            "the plugin's source repo."
        )
        del_btn.clicked.connect(self._submit_delete_skill)
        f2.addRow("", del_btn)
        v.addWidget(gb_delete)

        v.addStretch(1)
        return page

    def _refresh_plugins_for_skill_tab(self) -> None:
        self.skill_plugin_combo.clear()
        mp = self.skill_mp_combo.currentData()
        if not isinstance(mp, Marketplace):
            return
        for plugin in mp.plugins:
            self.skill_plugin_combo.addItem(plugin.name, plugin)

    def _refresh_plugins_for_delete_tab(self) -> None:
        self.del_plugin_combo.clear()
        mp = self.del_mp_combo.currentData()
        if not isinstance(mp, Marketplace):
            self._refresh_skills_for_delete_tab()
            return
        for plugin in mp.plugins:
            self.del_plugin_combo.addItem(plugin.name, plugin)
        self._refresh_skills_for_delete_tab()

    def _refresh_skills_for_delete_tab(self) -> None:
        self.del_skill_combo.clear()
        plugin = self.del_plugin_combo.currentData()
        if not isinstance(plugin, Plugin):
            self.del_skill_combo.addItem("(pick a plugin)", None)
            self.del_skill_combo.setEnabled(False)
            return
        # Surface skills the plugin has on its source repo. RefreshWorker only
        # populates skills for installed plugins, so for not-yet-installed
        # plugins this list may be empty until the user refreshes.
        seen: set[str] = set()
        for s in plugin.skills:
            if s.name in seen:
                continue
            if not s.remote_present:
                continue
            seen.add(s.name)
            self.del_skill_combo.addItem(s.name, s)
        if self.del_skill_combo.count() == 0:
            self.del_skill_combo.addItem(
                "(no remote skills found — refresh, or install the plugin first)", None,
            )
            self.del_skill_combo.setEnabled(False)
        else:
            self.del_skill_combo.setEnabled(True)

    def _preselect_skill_for_upload(self, plugin: Plugin) -> None:
        for i in range(self.local_skill_combo.count()):
            data = self.local_skill_combo.itemData(i)
            if data is not None and getattr(data, "folder", None) == plugin.install_path:
                self.local_skill_combo.setCurrentIndex(i)
                self.skill_target_name.setText(plugin.name)
                return

    def _submit_local_skill_upload(self) -> None:
        local = self.local_skill_combo.currentData()
        if local is None:
            QMessageBox.warning(self, "No local skill",
                f"Put your skill under {local_scanner.config.claude_user_skills_dir()}/<name>/SKILL.md first.")
            return
        mp: Marketplace = self.skill_mp_combo.currentData()
        plugin: Plugin = self.skill_plugin_combo.currentData()
        if not isinstance(mp, Marketplace) or not isinstance(plugin, Plugin):
            QMessageBox.warning(self, "Missing target", "Select a target marketplace and plugin.")
            return
        target_name = (self.skill_target_name.text().strip() or local.name).strip()
        new_version = self.skill_version_edit.text().strip()
        try:
            mp_repo, branch = self._repo_for(mp.name)
        except RuntimeError as e:
            QMessageBox.warning(self, "Configuration", str(e))
            return

        target_repo, _ = self._plugin_target_repo(plugin, mp_repo)
        if target_repo == mp_repo:
            sub = self._plugin_subpath_in_marketplace(plugin, mp)
            target_subpath = f"{sub}skills/{target_name}".strip("/")
            manifest_path = f"{sub}manifest.json".lstrip("/")
        else:
            target_subpath = f"skills/{target_name}".strip("/")
            manifest_path = "manifest.json"

        try:
            changes = collect_skill_folder_changes(local.folder, target_subpath)
        except Exception as e:
            self._post_status(f"Cannot collect files: {e}", ok=False)
            return
        if not changes:
            self._post_status("No files found in the skill folder — nothing to upload.", ok=False)
            return

        # Mirror the new version into the SKILL.md frontmatter so it stays in
        # sync with manifest.json. Keeps the on-disk SKILL.md untouched — only
        # the version going into the PR carries the bump.
        if new_version:
            for i, ch in enumerate(changes):
                leaf = ch.path.rsplit("/", 1)[-1]
                if leaf in ("SKILL.md", "skill.md"):
                    text = ch.content.decode("utf-8", errors="replace")
                    updated = update_frontmatter(text, {"version": new_version})
                    changes[i] = FileChange(path=ch.path, content=updated.encode("utf-8"))
                    break

        base_branch = branch if target_repo == mp_repo else ""
        gh = GitHubClient(self._settings.github_token)
        try:
            with busy_cursor():
                if not base_branch:
                    base_branch = gh.get_default_branch(target_repo)
                # Create or update? Probe SKILL.md presence at base branch.
                skill_md_existing = gh.get_file_sha_or_none(
                    target_repo, f"{target_subpath}/SKILL.md", ref=base_branch,
                )
                is_update = skill_md_existing is not None
                action_word = "Update" if is_update else "Add"
                if new_version:
                    manifest_text, _ = gh.get_file(target_repo, manifest_path, ref=base_branch)
                    try:
                        existing_manifest = json.loads(manifest_text)
                    except json.JSONDecodeError as je:
                        raise RuntimeError(f"manifest.json is not valid JSON: {je}")
                    if not isinstance(existing_manifest, dict):
                        raise RuntimeError("manifest.json root must be an object")
                    changes.append(FileChange(
                        path=manifest_path,
                        content=build_manifest_bump(existing_manifest, new_version),
                    ))
                pr_title = f"{action_word} skill: {target_name}"
                if new_version:
                    pr_title += f" (v{new_version})"
                pr_body = (
                    f"{action_word}s skill `{target_name}` ({len(changes)} file(s)) "
                    f"on plugin `{plugin.name}` from local folder `{local.folder}`."
                )
                if new_version:
                    pr_body += f"\n\nAlso bumps `{plugin.name}` to v{new_version}."
                result = submit_changes(
                    gh, target_repo, base_branch, changes,
                    pr_title=pr_title,
                    pr_body=pr_body,
                    branch_prefix="skillmanager/upload-skill",
                )
        except Exception as e:
            self._post_status(f"Upload failed: {e}", ok=False)
            return
        self._post_status(
            f"PR opened on {target_repo}: {result.pr_url}  "
            f"({action_word.lower()}d {target_name}, {len(changes)} file(s))",
            ok=True,
        )

    def _submit_delete_skill(self) -> None:
        mp: Marketplace = self.del_mp_combo.currentData()
        plugin: Plugin = self.del_plugin_combo.currentData()
        skill = self.del_skill_combo.currentData()
        if not isinstance(mp, Marketplace) or not isinstance(plugin, Plugin) or skill is None:
            QMessageBox.warning(self, "Missing target",
                "Select a marketplace, plugin and skill.")
            return
        skill_name = getattr(skill, "name", "") or ""
        if not skill_name:
            return
        ans = QMessageBox.question(
            self, "Delete skill",
            f"Open a PR that deletes skill '{skill_name}' from plugin "
            f"'{plugin.name}'?\n\nAll files under the skill's folder on the "
            f"plugin's source repo will be removed.",
        )
        if ans != QMessageBox.Yes:
            return
        try:
            mp_repo, branch = self._repo_for(mp.name)
        except RuntimeError as e:
            QMessageBox.warning(self, "Configuration", str(e))
            return
        target_repo, _ = self._plugin_target_repo(plugin, mp_repo)
        if target_repo == mp_repo:
            sub = self._plugin_subpath_in_marketplace(plugin, mp)
            skill_subpath = f"{sub}skills/{skill_name}".strip("/")
            base_branch = branch
        else:
            skill_subpath = f"skills/{skill_name}"
            base_branch = ""

        gh = GitHubClient(self._settings.github_token)
        try:
            with busy_cursor():
                if not base_branch:
                    base_branch = gh.get_default_branch(target_repo)
                files = gh.list_dir_recursive(target_repo, skill_subpath, ref=base_branch)
        except Exception as e:
            self._post_status(f"Could not list files in {skill_subpath}: {e}", ok=False)
            return
        if not files:
            QMessageBox.warning(self, "Skill not found",
                f"No files found under {skill_subpath} on "
                f"{target_repo}@{base_branch}.")
            return
        deletions = [f.path for f in files]
        try:
            with busy_cursor():
                result = submit_changes(
                    gh, target_repo, base_branch, [],
                    deletions=deletions,
                    pr_title=f"Delete skill: {skill_name}",
                    pr_body=(
                        f"Removes skill `{skill_name}` ({len(deletions)} file(s)) "
                        f"from plugin `{plugin.name}`."
                    ),
                    branch_prefix="skillmanager/delete-skill",
                )
        except Exception as e:
            self._post_status(f"Delete failed: {e}", ok=False)
            return
        self._post_status(
            f"PR opened on {target_repo}: {result.pr_url}  "
            f"(deleted {skill_name}, {len(deletions)} file(s))",
            ok=True,
        )

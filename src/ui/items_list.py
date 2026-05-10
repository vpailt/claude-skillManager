"""Middle column: list of plugins / skills for the selected marketplace.

Replaces the older marketplace-rooted tree (now that marketplace selection
lives in the nav rail). The tree shows:

    Plugin
        Skill
            file.md
            subfolder/
        ...

When the rail emits SEL_ALL, plugins from every marketplace are grouped under
their marketplace heading (single shallow level so the user still has context).
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QFrame, QVBoxLayout, QHBoxLayout, QLineEdit, QLabel, QTreeWidget,
    QTreeWidgetItem, QStyle, QMenu, QAbstractItemView, QHeaderView,
)

from .. import local_scanner as _ls
from ..models import Marketplace, Plugin, Skill, SkillFile, InstallState


# Roles
ROLE_KIND = Qt.UserRole + 1
ROLE_OBJ = Qt.UserRole + 2

_MAX_SKILL_FILES = 500


class ItemsList(QFrame):
    """Middle pane. Owns its own filter bar."""

    selectionChanged = Signal(object)         # Marketplace | Plugin | Skill | SkillFile | None
    actionRequested = Signal(str, object)     # see action keys list in plugins_tree.py
    batchActionRequested = Signal(str, list)  # "install-many" | "uninstall-many"

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setProperty("role", "middlePane")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(8)

        title_row = QHBoxLayout()
        title_row.setContentsMargins(0, 0, 0, 0)
        self.title_label = QLabel("All skills")
        self.title_label.setProperty("role", "detailTitle")
        title_row.addWidget(self.title_label)
        title_row.addStretch(1)
        layout.addLayout(title_row)

        self.filter_edit = QLineEdit()
        self.filter_edit.setPlaceholderText("Filter…")
        self.filter_edit.setClearButtonEnabled(True)
        self.filter_edit.textChanged.connect(self._apply_filter)
        layout.addWidget(self.filter_edit)

        self.tree = QTreeWidget()
        self.tree.setHeaderHidden(True)
        self.tree.setColumnCount(1)
        self.tree.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.tree.setContextMenuPolicy(Qt.CustomContextMenu)
        self.tree.customContextMenuRequested.connect(self._menu)
        self.tree.currentItemChanged.connect(self._emit_selection)
        self.tree.itemDoubleClicked.connect(self._on_double_click)
        self.tree.setAnimated(True)
        self.tree.setIndentation(16)
        self.tree.header().setSectionResizeMode(QHeaderView.Stretch)
        layout.addWidget(self.tree, 1)

        st = self.style()
        self._icon_marketplace = st.standardIcon(QStyle.SP_DirHomeIcon)
        self._icon_plugin = st.standardIcon(QStyle.SP_FileDialogContentsView)
        self._icon_skill = st.standardIcon(QStyle.SP_FileIcon)
        self._icon_file = st.standardIcon(QStyle.SP_FileIcon)
        self._icon_folder = st.standardIcon(QStyle.SP_DirClosedIcon)

        self._marketplaces: list[Marketplace] = []
        self._mode: str = "all"  # "all" | "marketplace" | "local"
        self._selected_marketplace: Optional[str] = None

    def show_for(self, marketplaces: list[Marketplace], selection: str) -> None:
        """Repopulate the tree for the given rail selection.

        ``selection`` is either a marketplace name, ``__all__`` or ``__local__``.
        """
        self._marketplaces = marketplaces
        if selection == "__all__":
            self._mode = "all"
            self._selected_marketplace = None
            self.title_label.setText("All skills")
            self._populate_all(marketplaces)
        elif selection == "__local__":
            self._mode = "local"
            self._selected_marketplace = None
            local_mp = next(
                (m for m in marketplaces if m.name == _ls.LOCAL_MARKETPLACE_NAME),
                None,
            )
            self.title_label.setText("Local skills")
            self._populate_marketplace(local_mp, show_marketplace_row=False)
        else:
            self._mode = "marketplace"
            self._selected_marketplace = selection
            mp = next((m for m in marketplaces if m.name == selection), None)
            self.title_label.setText(mp.name if mp else selection)
            self._populate_marketplace(mp, show_marketplace_row=True)

        self._apply_filter(self.filter_edit.text())

    # ---------- population ----------
    def _populate_all(self, marketplaces: list[Marketplace]) -> None:
        self.tree.clear()
        for mp in marketplaces:
            mp_item = self._make_marketplace_item(mp)
            self.tree.addTopLevelItem(mp_item)
            for plugin in mp.plugins:
                mp_item.addChild(self._make_plugin_item(plugin))
            mp_item.setExpanded(True)

    def _populate_marketplace(self, mp: Optional[Marketplace], show_marketplace_row: bool) -> None:
        self.tree.clear()
        if mp is None:
            return
        if show_marketplace_row:
            top = self._make_marketplace_item(mp)
            self.tree.addTopLevelItem(top)
            for plugin in mp.plugins:
                top.addChild(self._make_plugin_item(plugin))
            top.setExpanded(True)
        else:
            for plugin in mp.plugins:
                self.tree.addTopLevelItem(self._make_plugin_item(plugin))

    def _make_marketplace_item(self, mp: Marketplace) -> QTreeWidgetItem:
        installed_count = sum(1 for p in mp.plugins if p.installed_version)
        label = f"{mp.name}  ·  {installed_count}/{len(mp.plugins)}"
        if not mp.installed and mp.source_kind != "local":
            label += "  ·  not installed"
        item = QTreeWidgetItem([label])
        item.setData(0, ROLE_KIND, "marketplace")
        item.setData(0, ROLE_OBJ, mp)
        item.setIcon(0, self._icon_marketplace)
        f = QFont(self.tree.font())
        f.setBold(True)
        item.setFont(0, f)
        return item

    def _make_plugin_item(self, plugin: Plugin) -> QTreeWidgetItem:
        item = QTreeWidgetItem([plugin.name])
        item.setData(0, ROLE_KIND, "plugin")
        item.setData(0, ROLE_OBJ, plugin)
        item.setIcon(0, self._icon_plugin)
        if plugin.description:
            item.setToolTip(0, plugin.description)
        # Status badge in a second visible column wouldn't fit our 1-col header,
        # so encode state into a small suffix instead.
        suffix = self._plugin_suffix(plugin)
        if suffix:
            item.setText(0, f"{plugin.name}   {suffix}")
        for skill in plugin.skills:
            item.addChild(self._make_skill_item(skill, plugin))
        return item

    def _plugin_suffix(self, plugin: Plugin) -> str:
        if plugin.install_state == InstallState.OUTDATED:
            return "· update available"
        if plugin.install_state == InstallState.NOT_INSTALLED:
            return "· not installed"
        if plugin.install_state == InstallState.LOCAL_ONLY:
            return "· local only"
        if plugin.installed_version and plugin.enabled is False:
            return "· disabled"
        return ""

    def _make_skill_item(self, skill: Skill, plugin: Plugin) -> QTreeWidgetItem:
        item = QTreeWidgetItem([skill.name])
        item.setData(0, ROLE_KIND, "skill")
        item.setData(0, ROLE_OBJ, skill)
        item.setIcon(0, self._icon_skill)
        if skill.description:
            item.setToolTip(0, skill.description)
        if skill.folder and skill.folder.is_dir():
            budget = [_MAX_SKILL_FILES]
            self._populate_skill_files(item, skill, skill.folder, budget)
        return item

    def _populate_skill_files(self, parent_item: QTreeWidgetItem, skill: Skill,
                              folder: Path, budget: list[int]) -> None:
        try:
            entries = sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for entry in entries:
            if budget[0] <= 0:
                truncated = QTreeWidgetItem(["… (more files truncated)"])
                truncated.setData(0, ROLE_KIND, "note")
                parent_item.addChild(truncated)
                return
            budget[0] -= 1
            is_dir = entry.is_dir()
            sf = SkillFile(
                path=entry, is_dir=is_dir, skill_name=skill.name,
                plugin_name=skill.plugin_name, marketplace_name=skill.marketplace_name,
            )
            label = entry.name + ("/" if is_dir else "")
            f_item = QTreeWidgetItem([label])
            f_item.setData(0, ROLE_KIND, "file")
            f_item.setData(0, ROLE_OBJ, sf)
            f_item.setIcon(0, self._icon_folder if is_dir else self._icon_file)
            f_item.setToolTip(0, str(entry))
            parent_item.addChild(f_item)
            if is_dir:
                self._populate_skill_files(f_item, skill, entry, budget)

    # ---------- selection / events ----------
    def _emit_selection(self, current, _previous):
        if not current:
            self.selectionChanged.emit(None)
            return
        self.selectionChanged.emit(current.data(0, ROLE_OBJ))

    def _on_double_click(self, item, _col):
        kind = item.data(0, ROLE_KIND)
        obj = item.data(0, ROLE_OBJ)
        if kind == "file" and isinstance(obj, SkillFile) and not obj.is_dir:
            self.actionRequested.emit("open-file", obj)

    def _selected_plugins(self) -> list[Plugin]:
        out: list[Plugin] = []
        for it in self.tree.selectedItems():
            if it.data(0, ROLE_KIND) == "plugin":
                obj = it.data(0, ROLE_OBJ)
                if isinstance(obj, Plugin):
                    out.append(obj)
        return out

    def _menu(self, pos):
        item = self.tree.itemAt(pos)
        if not item:
            return
        plugins_sel = self._selected_plugins()
        if len(plugins_sel) > 1:
            menu = QMenu(self)
            installable = [p for p in plugins_sel
                           if p.install_state in (InstallState.NOT_INSTALLED, InstallState.OUTDATED)]
            removable = [p for p in plugins_sel if p.installed_version]
            if installable:
                menu.addAction(
                    f"Install / update {len(installable)} selected plugins",
                    lambda: self.batchActionRequested.emit("install-many", installable),
                )
            if removable:
                menu.addAction(
                    f"Uninstall {len(removable)} selected plugins",
                    lambda: self.batchActionRequested.emit("uninstall-many", removable),
                )
            if menu.actions():
                menu.exec(self.tree.viewport().mapToGlobal(pos))
                return

        kind = item.data(0, ROLE_KIND)
        obj = item.data(0, ROLE_OBJ)
        menu = QMenu(self)
        if kind == "plugin" and isinstance(obj, Plugin):
            self._plugin_menu(menu, obj)
        elif kind == "skill" and isinstance(obj, Skill):
            if obj.folder:
                menu.addAction("Edit in VS Code", lambda: self.actionRequested.emit("edit-vscode", obj))
                menu.addAction("Open skill folder", lambda: self.actionRequested.emit("open-folder", obj))
        elif kind == "file" and isinstance(obj, SkillFile):
            if obj.is_dir:
                menu.addAction("Open folder", lambda: self.actionRequested.emit("open-file-folder", obj))
            else:
                menu.addAction("Open file", lambda: self.actionRequested.emit("open-file", obj))
                menu.addAction("Reveal in folder", lambda: self.actionRequested.emit("open-file-folder", obj))
        elif kind == "marketplace" and isinstance(obj, Marketplace):
            self._marketplace_menu(menu, obj)
        if menu.actions():
            menu.exec(self.tree.viewport().mapToGlobal(pos))

    def _plugin_menu(self, menu: QMenu, plugin: Plugin) -> None:
        is_local_only = plugin.install_state == InstallState.LOCAL_ONLY and not plugin.latest_version
        if is_local_only:
            menu.addAction("Upload to marketplace…",
                           lambda: self.actionRequested.emit("upload-local", plugin))
            menu.addSeparator()
            menu.addAction("Open skill folder",
                           lambda: self.actionRequested.emit("open-folder", plugin))
            return
        if plugin.install_state == InstallState.NOT_INSTALLED:
            menu.addAction("Install plugin", lambda: self.actionRequested.emit("install", plugin))
        elif plugin.install_state == InstallState.OUTDATED:
            menu.addAction("Update plugin", lambda: self.actionRequested.emit("update", plugin))
        if plugin.installed_version:
            menu.addSeparator()
            if plugin.enabled:
                menu.addAction("Disable plugin", lambda: self.actionRequested.emit("disable", plugin))
            else:
                menu.addAction("Enable plugin", lambda: self.actionRequested.emit("enable", plugin))
            menu.addSeparator()
            menu.addAction("Open install folder", lambda: self.actionRequested.emit("open-folder", plugin))
            menu.addAction("Uninstall plugin", lambda: self.actionRequested.emit("uninstall", plugin))

    def _marketplace_menu(self, menu: QMenu, mp: Marketplace) -> None:
        if mp.source_kind == "local":
            menu.addAction("Open folder", lambda: self.actionRequested.emit("open-folder", mp))
            return
        if mp.installed:
            menu.addAction("Update marketplace", lambda: self.actionRequested.emit("install-mp", mp))
            menu.addAction("Uninstall marketplace", lambda: self.actionRequested.emit("uninstall-mp", mp))
        else:
            menu.addAction("Install marketplace", lambda: self.actionRequested.emit("install-mp", mp))
        menu.addSeparator()
        menu.addAction("Install / update all plugins", lambda: self.actionRequested.emit("install-all-mp", mp))

    # ---------- filter ----------
    def _apply_filter(self, text: str) -> None:
        text = (text or "").strip().lower()
        for i in range(self.tree.topLevelItemCount()):
            self._filter_item(self.tree.topLevelItem(i), text)

    def _filter_item(self, item: QTreeWidgetItem, text: str) -> bool:
        match_self = (not text) or (text in (item.text(0) or "").lower())
        any_child_visible = False
        for i in range(item.childCount()):
            if self._filter_item(item.child(i), text):
                any_child_visible = True
        visible = match_self or any_child_visible
        item.setHidden(not visible)
        return visible

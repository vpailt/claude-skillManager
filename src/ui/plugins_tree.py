"""Tree widget grouping marketplaces -> plugins -> skills with status columns."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QTreeWidget, QTreeWidgetItem, QHeaderView, QMenu, QStyle, QAbstractItemView,
)

from ..models import Marketplace, Plugin, Skill, SkillFile, InstallState
from .common import state_brush, state_label


# Roles on tree items to retrieve domain object behind a row.
ROLE_KIND = Qt.UserRole + 1
ROLE_OBJ = Qt.UserRole + 2

# Cap recursive listing of a skill folder to avoid pathological cases.
_MAX_SKILL_FILES = 500


class PluginsTree(QTreeWidget):
    selectionChangedDetail = Signal(object)   # emits Marketplace | Plugin | Skill | None
    actionRequested = Signal(str, object)     # action keys:
    # "install" | "update" | "uninstall" | "install-all" | "update-all"
    # "install-mp" | "uninstall-mp" | "install-all-mp"
    # "enable" | "disable"
    # "edit-vscode" | "open-folder"
    # "upload-local" -> Plugin (from synthetic local marketplace)
    batchActionRequested = Signal(str, list)  # "install-many" | "uninstall-many" -> list[Plugin]

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setColumnCount(5)
        self.setHeaderLabels(["Name", "Installed", "Latest", "Last updated", "Status / Description"])
        h = self.header()
        h.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        h.setSectionResizeMode(4, QHeaderView.Stretch)
        self.setUniformRowHeights(True)
        self.setAlternatingRowColors(True)
        self.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.setContextMenuPolicy(Qt.CustomContextMenu)
        self.customContextMenuRequested.connect(self._menu)
        self.currentItemChanged.connect(self._emit_selection)
        self.itemDoubleClicked.connect(self._on_double_click)

        st = self.style()
        self._icon_marketplace = st.standardIcon(QStyle.SP_DirHomeIcon)
        self._icon_plugin = st.standardIcon(QStyle.SP_DriveNetIcon)
        self._icon_skill = st.standardIcon(QStyle.SP_FileDialogContentsView)
        self._icon_file = st.standardIcon(QStyle.SP_FileIcon)
        self._icon_folder = st.standardIcon(QStyle.SP_DirClosedIcon)

    def populate(self, marketplaces: list[Marketplace]) -> None:
        self.clear()
        bold = QFont(self.font())
        bold.setBold(True)
        for mp in marketplaces:
            mp_status = "installed" if mp.installed else "not installed"
            total = len(mp.plugins)
            installed_count = sum(1 for p in mp.plugins if p.installed_version)
            mp_item = QTreeWidgetItem([
                f"[Marketplace] {mp.name}  ({installed_count}/{total} installed)",
                "",
                "",
                _fmt_date(mp.last_updated),
                f"[{mp_status}]  —  {mp.source_repo or mp.source_path or mp.source_kind}",
            ])
            mp_item.setData(0, ROLE_KIND, "marketplace")
            mp_item.setData(0, ROLE_OBJ, mp)
            mp_item.setFont(0, bold)
            mp_item.setIcon(0, self._icon_marketplace)
            self.addTopLevelItem(mp_item)

            for plugin in mp.plugins:
                status_text = state_label(plugin.install_state)
                if plugin.installed_version:
                    badge = "enabled" if plugin.enabled else "disabled"
                    status_text = f"{status_text}  ·  [{badge}]"
                p_item = QTreeWidgetItem([
                    f"[Plugin] {plugin.name}",
                    plugin.installed_version or "",
                    plugin.latest_version or "",
                    _fmt_date(plugin.last_updated),
                    status_text,
                ])
                p_item.setData(0, ROLE_KIND, "plugin")
                p_item.setData(0, ROLE_OBJ, plugin)
                p_item.setForeground(4, state_brush(plugin.install_state))
                p_item.setIcon(0, self._icon_plugin)
                if plugin.description:
                    p_item.setToolTip(0, plugin.description)
                mp_item.addChild(p_item)

                for skill in plugin.skills:
                    s_state = _skill_state(skill, plugin)
                    s_item = QTreeWidgetItem([
                        f"[Skill] {skill.name}",
                        plugin.installed_version if skill.folder else "",
                        plugin.latest_version if skill.remote_present else "",
                        "",
                        skill.description or state_label(s_state),
                    ])
                    s_item.setData(0, ROLE_KIND, "skill")
                    s_item.setData(0, ROLE_OBJ, skill)
                    s_item.setForeground(4, state_brush(s_state))
                    s_item.setIcon(0, self._icon_skill)
                    if skill.description:
                        s_item.setToolTip(4, skill.description)
                    p_item.addChild(s_item)

                    if skill.folder and skill.folder.is_dir():
                        budget = [_MAX_SKILL_FILES]
                        self._populate_skill_files(s_item, skill, skill.folder, budget)

            mp_item.setExpanded(True)

    def _populate_skill_files(self, parent_item: QTreeWidgetItem, skill: Skill,
                              folder: Path, budget: list[int]) -> None:
        """Add files & subfolders under a skill as children of parent_item."""
        try:
            entries = sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for entry in entries:
            if budget[0] <= 0:
                truncated = QTreeWidgetItem(["… (more files truncated)", "", "", "", ""])
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
            try:
                size = "" if is_dir else _human_size(entry.stat().st_size)
            except OSError:
                size = ""
            f_item = QTreeWidgetItem([label, "", "", "", size])
            f_item.setData(0, ROLE_KIND, "file")
            f_item.setData(0, ROLE_OBJ, sf)
            f_item.setIcon(0, self._icon_folder if is_dir else self._icon_file)
            f_item.setToolTip(0, str(entry))
            parent_item.addChild(f_item)
            if is_dir:
                self._populate_skill_files(f_item, skill, entry, budget)

    # ---------- selection / context menu ----------
    def _emit_selection(self, current, _previous):
        if not current:
            self.selectionChangedDetail.emit(None)
            return
        self.selectionChangedDetail.emit(current.data(0, ROLE_OBJ))

    def _on_double_click(self, item, _column):
        kind = item.data(0, ROLE_KIND)
        obj = item.data(0, ROLE_OBJ)
        if kind == "file" and obj is not None:
            sf: SkillFile = obj
            if not sf.is_dir:
                self.actionRequested.emit("open-file", sf)

    def _selected_plugins(self) -> list[Plugin]:
        out: list[Plugin] = []
        for it in self.selectedItems():
            if it.data(0, ROLE_KIND) == "plugin":
                obj = it.data(0, ROLE_OBJ)
                if isinstance(obj, Plugin):
                    out.append(obj)
        return out

    def _menu(self, pos):
        item = self.itemAt(pos)
        if not item:
            return

        # Multi-selection of plugins → batch menu
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
                menu.exec(self.viewport().mapToGlobal(pos))
                return

        kind = item.data(0, ROLE_KIND)
        obj = item.data(0, ROLE_OBJ)
        menu = QMenu(self)
        if kind == "plugin":
            plugin: Plugin = obj
            is_local_only = plugin.install_state == InstallState.LOCAL_ONLY and not plugin.latest_version
            if is_local_only:
                menu.addAction("Upload to marketplace…",
                               lambda: self.actionRequested.emit("upload-local", plugin))
                menu.addSeparator()
                menu.addAction("Open skill folder",
                               lambda: self.actionRequested.emit("open-folder", plugin))
            else:
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
                menu.addAction("Install / update all skills", lambda: self.actionRequested.emit("install-all", plugin))
                menu.addSeparator()
                menu.addAction("Open install folder", lambda: self.actionRequested.emit("open-folder", plugin))
                if plugin.installed_version:
                    menu.addAction("Uninstall plugin", lambda: self.actionRequested.emit("uninstall", plugin))
        elif kind == "skill":
            skill: Skill = obj
            if skill.folder:
                menu.addAction("Edit in VS Code", lambda: self.actionRequested.emit("edit-vscode", skill))
                menu.addAction("Open skill folder", lambda: self.actionRequested.emit("open-folder", skill))
        elif kind == "file":
            sf: SkillFile = obj
            if sf.is_dir:
                menu.addAction("Open folder", lambda: self.actionRequested.emit("open-file-folder", sf))
            else:
                menu.addAction("Open file", lambda: self.actionRequested.emit("open-file", sf))
                menu.addAction("Reveal in folder", lambda: self.actionRequested.emit("open-file-folder", sf))
        elif kind == "marketplace":
            mp: Marketplace = obj
            if mp.source_kind == "local":
                menu.addAction("Open folder", lambda: self.actionRequested.emit("open-folder", mp))
            else:
                if mp.installed:
                    menu.addAction("Update marketplace", lambda: self.actionRequested.emit("install-mp", mp))
                    menu.addAction("Uninstall marketplace", lambda: self.actionRequested.emit("uninstall-mp", mp))
                else:
                    menu.addAction("Install marketplace", lambda: self.actionRequested.emit("install-mp", mp))
                menu.addSeparator()
                menu.addAction("Install / update all plugins", lambda: self.actionRequested.emit("install-all-mp", mp))
        if menu.actions():
            menu.exec(self.viewport().mapToGlobal(pos))


def _human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    for unit in ("KB", "MB", "GB"):
        size /= 1024
        if size < 1024:
            return f"{size:.1f} {unit}"
    return f"{size:.1f} TB"


def _fmt_date(iso: str) -> str:
    """Convert ISO timestamp to a compact 'YYYY-MM-DD HH:MM' for display."""
    if not iso:
        return ""
    s = iso[:16].replace("T", " ")
    return s


def _skill_state(skill: Skill, plugin: Plugin) -> InstallState:
    has_local = skill.folder is not None
    has_remote = skill.remote_present
    if has_local and has_remote:
        return InstallState.OUTDATED if plugin.install_state == InstallState.OUTDATED else InstallState.INSTALLED
    if has_local and not has_remote:
        return InstallState.LOCAL_ONLY
    if has_remote and not has_local:
        return InstallState.NOT_INSTALLED
    return InstallState.UNKNOWN


def _marketplace_summary(mp: Marketplace) -> str:
    n = len(mp.plugins)
    installed = sum(1 for p in mp.plugins if p.installed_version)
    src = mp.source_repo or mp.source_path or mp.source_kind
    state = "installed" if mp.installed else "not installed"
    return f"[{state}]  {installed}/{n} plugin(s) installed  —  {src}"

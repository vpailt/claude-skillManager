"""Right column: detail card for the selected marketplace / plugin / skill / file.

Layout, top-down:

    Title row    : large title + ToggleSwitch (plugin only) + (...) menu
    Subtitle     : marketplace · status · versions
    Metadata grid: 3-column key/value card (Source, Last updated, Trigger…)
    Description  : one-paragraph human description
    Body         : rendered Markdown (skills) or pre-formatted text (other types)
    Action row   : install / uninstall / enable / open folder etc.

Markdown is rendered via QTextBrowser.setMarkdown() — that ships with PySide6
≥ 6.5 and avoids pulling a markdown lib into the bundle.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QFrame, QVBoxLayout, QHBoxLayout, QGridLayout, QLabel, QPushButton,
    QTextBrowser, QSizePolicy, QWidget,
)

from .. import local_scanner as _ls
from ..models import Marketplace, Plugin, Skill, SkillFile, InstallState
from .common import state_label
from .widgets import ToggleSwitch
from . import theme


def _fmt_date(iso: str) -> str:
    if not iso:
        return "—"
    return iso[:10]


def _state_badge_text(state: InstallState) -> str:
    return state_label(state)


def _state_badge_color(state: InstallState) -> str:
    return {
        InstallState.INSTALLED:     theme.SUCCESS,
        InstallState.OUTDATED:      theme.WARNING,
        InstallState.NOT_INSTALLED: theme.TEXT_MUTED,
        InstallState.LOCAL_ONLY:    theme.INFO,
        InstallState.UNKNOWN:       theme.TEXT_MUTED,
    }.get(state, theme.TEXT_MUTED)


class DetailPanel(QFrame):
    """Right column. Stateless w.r.t. the data model — call ``show_object``."""

    editInVSCodeRequested = Signal(object)
    openFolderRequested = Signal(object)
    installRequested = Signal(object)
    updateRequested = Signal(object)
    uninstallRequested = Signal(object)
    installAllRequested = Signal(object)
    installAllMarketplaceRequested = Signal(object)
    installMarketplaceRequested = Signal(object)
    uninstallMarketplaceRequested = Signal(object)
    enableRequested = Signal(object)
    disableRequested = Signal(object)
    uploadLocalRequested = Signal(object)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setProperty("role", "detailPane")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 16)
        layout.setSpacing(12)

        # ---- Title row
        title_row = QHBoxLayout()
        title_row.setSpacing(10)
        self.title = QLabel("Select an item")
        self.title.setProperty("role", "detailTitle")
        title_row.addWidget(self.title)
        title_row.addStretch(1)
        self.toggle = ToggleSwitch()
        self.toggle.setVisible(False)
        self.toggle.toggled_by_user.connect(self._on_toggle_changed)
        title_row.addWidget(self.toggle)
        layout.addLayout(title_row)

        # ---- Subtitle
        self.subtitle = QLabel("")
        self.subtitle.setProperty("role", "detailSubtitle")
        self.subtitle.setWordWrap(True)
        layout.addWidget(self.subtitle)

        # ---- Metadata card (3 columns: Source / Last updated / State)
        self.meta_card = QFrame()
        self.meta_card.setProperty("role", "metadataCard")
        self.meta_grid = QGridLayout(self.meta_card)
        self.meta_grid.setContentsMargins(16, 12, 16, 12)
        self.meta_grid.setHorizontalSpacing(28)
        self.meta_grid.setVerticalSpacing(2)
        layout.addWidget(self.meta_card)
        self.meta_card.setVisible(False)

        # ---- Description (short, plain)
        self.description = QLabel("")
        self.description.setWordWrap(True)
        self.description.setStyleSheet(f"color: {theme.TEXT_PRIMARY};")
        self.description.setVisible(False)
        layout.addWidget(self.description)

        # ---- Action row
        self.action_row = QHBoxLayout()
        self.action_row.setSpacing(8)
        layout.addLayout(self.action_row)

        # ---- Body (markdown / file preview)
        self.body = QTextBrowser()
        self.body.setOpenExternalLinks(True)
        self.body.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.body.setStyleSheet(f"font-size: 13px; line-height: 1.6;")
        layout.addWidget(self.body, 1)

        self._current = None

    # ============================================================
    # Public API
    # ============================================================
    def show_object(self, obj) -> None:
        self._current = obj
        self._reset()
        if obj is None:
            self.title.setText("Select an item")
            self.subtitle.setText("Pick a marketplace, plugin, or skill on the left.")
            self.body.setPlainText("")
            return
        if isinstance(obj, Marketplace):
            self._render_marketplace(obj)
        elif isinstance(obj, Plugin):
            self._render_plugin(obj)
        elif isinstance(obj, Skill):
            self._render_skill(obj)
        elif isinstance(obj, SkillFile):
            self._render_skill_file(obj)
        else:
            self.title.setText(str(type(obj)))
            self.body.setPlainText(repr(obj))

    # ============================================================
    # Internal helpers
    # ============================================================
    def _reset(self) -> None:
        self.toggle.setVisible(False)
        self.meta_card.setVisible(False)
        self.description.setVisible(False)
        # Wipe metadata grid
        while self.meta_grid.count():
            it = self.meta_grid.takeAt(0)
            w = it.widget()
            if w:
                w.deleteLater()
        # Wipe action row
        while self.action_row.count():
            it = self.action_row.takeAt(0)
            w = it.widget()
            if w:
                w.deleteLater()

    def _on_toggle_changed(self, checked: bool) -> None:
        if isinstance(self._current, Plugin) and self._current.installed_version:
            if checked:
                self.enableRequested.emit(self._current)
            else:
                self.disableRequested.emit(self._current)

    def _add_meta(self, col: int, label: str, value: str, value_color: str | None = None) -> None:
        lbl = QLabel(label)
        lbl.setProperty("role", "metaLabel")
        val = QLabel(value or "—")
        val.setProperty("role", "metaValue")
        if value_color:
            val.setStyleSheet(f"color: {value_color}; font-size: 13px;")
        val.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.meta_grid.addWidget(lbl, 0, col)
        self.meta_grid.addWidget(val, 1, col)
        self.meta_card.setVisible(True)

    def _btn(self, text: str, slot, primary: bool = False) -> QPushButton:
        b = QPushButton(text)
        if primary:
            b.setProperty("primary", "true")
            b.style().unpolish(b)
            b.style().polish(b)
        b.clicked.connect(slot)
        self.action_row.addWidget(b)
        return b

    # ============================================================
    # Renderers
    # ============================================================
    def _render_marketplace(self, mp: Marketplace) -> None:
        self.title.setText(mp.name)
        is_local = mp.source_kind == "local"
        installed_count = sum(1 for p in mp.plugins if p.installed_version)
        state_text = "Local skills" if is_local else ("Installed" if mp.installed else "Not installed")
        self.subtitle.setText(f"{state_text}  ·  {installed_count}/{len(mp.plugins)} plugin(s) installed")
        self.subtitle.setVisible(True)

        src = mp.source_repo or mp.source_path or "—"
        self._add_meta(0, "Source", src)
        self._add_meta(1, "Last updated", _fmt_date(mp.last_updated))
        self._add_meta(2, "Type", mp.source_kind or "—")

        if mp.install_location:
            self.description.setText(f"Local install: {mp.install_location}")
            self.description.setVisible(True)

        if is_local:
            self._btn("Open folder", lambda: self.openFolderRequested.emit(mp))
        elif mp.installed:
            self._btn("Update marketplace", lambda: self.installMarketplaceRequested.emit(mp), primary=True)
            self._btn("Uninstall", lambda: self.uninstallMarketplaceRequested.emit(mp))
        elif mp.source_repo:
            self._btn("Install marketplace", lambda: self.installMarketplaceRequested.emit(mp), primary=True)
        if not is_local:
            self._btn("Install / update all plugins",
                      lambda: self.installAllMarketplaceRequested.emit(mp))
        self.action_row.addStretch(1)

        # Body: list of plugins
        lines = ["## Plugins", ""]
        for p in mp.plugins:
            badge = state_label(p.install_state)
            ver = ""
            if p.installed_version or p.latest_version:
                ver = f"  (installed: {p.installed_version or '—'}, latest: {p.latest_version or '—'})"
            lines.append(f"- **{p.name}** — {badge}{ver}")
            if p.description:
                lines.append(f"  {p.description}")
        self.body.setMarkdown("\n".join(lines))

    def _render_plugin(self, plugin: Plugin) -> None:
        is_local_only = plugin.marketplace_name == _ls.LOCAL_MARKETPLACE_NAME
        self.title.setText(plugin.name)

        bits = [plugin.marketplace_name]
        bits.append(state_label(plugin.install_state))
        if plugin.installed_version and not is_local_only:
            bits.append("enabled" if plugin.enabled else "disabled")
        self.subtitle.setText("  ·  ".join(bits))
        self.subtitle.setVisible(True)

        self._add_meta(0, "Installed",
                       plugin.installed_version or "—",
                       _state_badge_color(plugin.install_state))
        self._add_meta(1, "Latest", plugin.latest_version or "—")
        self._add_meta(2, "Last updated", _fmt_date(plugin.last_updated))

        if plugin.description:
            self.description.setText(plugin.description)
            self.description.setVisible(True)

        # Toggle (only when the plugin is installed and not a synthetic local one)
        if plugin.installed_version and not is_local_only:
            self.toggle.setVisible(True)
            self.toggle.setChecked(bool(plugin.enabled))

        # Actions
        if is_local_only:
            self._btn("Upload to marketplace…",
                      lambda: self.uploadLocalRequested.emit(plugin), primary=True)
            self._btn("Open folder", lambda: self.openFolderRequested.emit(plugin))
        else:
            if plugin.install_state == InstallState.NOT_INSTALLED:
                self._btn("Install", lambda: self.installRequested.emit(plugin), primary=True)
            elif plugin.install_state == InstallState.OUTDATED:
                self._btn("Update", lambda: self.updateRequested.emit(plugin), primary=True)
            if plugin.installed_version:
                self._btn("Open folder", lambda: self.openFolderRequested.emit(plugin))
                self._btn("Uninstall", lambda: self.uninstallRequested.emit(plugin))
        self.action_row.addStretch(1)

        # Body: list of skills
        lines = []
        if plugin.skills:
            lines.append(f"## Skills ({len(plugin.skills)})\n")
            for s in plugin.skills:
                marker = "●" if s.folder else "○"
                desc = (s.description[:200] + "…") if s.description and len(s.description) > 200 else (s.description or "")
                lines.append(f"- {marker} **{s.name}** — {desc}")
        else:
            lines.append("_No skills bundled with this plugin._")
        self.body.setMarkdown("\n".join(lines))

    def _render_skill(self, skill: Skill) -> None:
        self.title.setText(skill.name)
        loc = ("local + remote" if skill.folder and skill.remote_present
               else "local only" if skill.folder
               else "remote only")
        self.subtitle.setText(f"{skill.plugin_name or '—'}  ·  {loc}")
        self.subtitle.setVisible(True)

        self._add_meta(0, "Plugin", skill.plugin_name or "—")
        self._add_meta(1, "Marketplace", skill.marketplace_name or "—")
        self._add_meta(2, "Location", loc)

        if skill.description:
            self.description.setText(skill.description)
            self.description.setVisible(True)

        if skill.folder:
            self._btn("Edit in VS Code", lambda: self.editInVSCodeRequested.emit(skill), primary=True)
            self._btn("Open folder", lambda: self.openFolderRequested.emit(skill))
        self.action_row.addStretch(1)

        if skill.skill_md_path and skill.skill_md_path.exists():
            try:
                text = skill.skill_md_path.read_text(encoding="utf-8", errors="replace")
                # Strip YAML frontmatter for the rendered view — it duplicates
                # data already shown in the metadata card.
                text = _strip_frontmatter(text)
                self.body.setMarkdown(text)
            except Exception as e:
                self.body.setPlainText(f"(cannot read: {e})")
        else:
            self.body.setMarkdown(skill.description or
                                  "_Remote-only skill — install the plugin to see contents._")

    def _render_skill_file(self, sf: SkillFile) -> None:
        kind = "Folder" if sf.is_dir else "File"
        self.title.setText(sf.path.name)
        self.subtitle.setText(f"{kind}  ·  {sf.skill_name}")
        self.subtitle.setVisible(True)

        self._add_meta(0, "Type", kind)
        self._add_meta(1, "Path", str(sf.path))
        if not sf.is_dir:
            try:
                size = sf.path.stat().st_size
                self._add_meta(2, "Size", _human_size(size))
            except OSError:
                self._add_meta(2, "Size", "—")

        self.action_row.addStretch(1)

        if sf.is_dir:
            try:
                names = sorted(p.name + ("/" if p.is_dir() else "") for p in sf.path.iterdir())
            except OSError as e:
                self.body.setPlainText(f"(cannot list: {e})")
                return
            self.body.setPlainText("\n".join(names) or "(empty folder)")
            return
        try:
            size = sf.path.stat().st_size
        except OSError as e:
            self.body.setPlainText(f"(cannot stat: {e})")
            return
        if size > 1_000_000:
            self.body.setPlainText(f"(file too large to preview: {size:,} bytes)")
            return
        try:
            data = sf.path.read_bytes()
        except OSError as e:
            self.body.setPlainText(f"(cannot read: {e})")
            return
        if b"\x00" in data[:8192]:
            self.body.setPlainText(f"(binary file, {size:,} bytes)")
            return
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("latin-1", errors="replace")
        if sf.path.suffix.lower() in {".md", ".markdown"}:
            self.body.setMarkdown(_strip_frontmatter(text))
        else:
            self.body.setPlainText(text)


def _strip_frontmatter(text: str) -> str:
    """Drop a leading ``---\\n…\\n---\\n`` YAML frontmatter block, if any."""
    if not text.startswith("---"):
        return text
    nl = text.find("\n")
    if nl < 0:
        return text
    end = text.find("\n---", nl)
    if end < 0:
        return text
    after = text.find("\n", end + 4)
    return text[after + 1:] if after >= 0 else text[end + 4:]


def _human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    f = float(size)
    for unit in ("KB", "MB", "GB"):
        f /= 1024
        if f < 1024:
            return f"{f:.1f} {unit}"
    return f"{f:.1f} TB"

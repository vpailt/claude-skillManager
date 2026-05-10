"""Left navigation rail.

Lists the configured marketplaces (one row each) plus a couple of system
entries (All / Local skills / Admin). Selecting a row drives what the middle
pane shows.

The rail does NOT show plugins — those live in the middle pane once a
marketplace is selected.
"""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import (
    QFrame, QVBoxLayout, QListWidget, QListWidgetItem, QPushButton,
    QHBoxLayout, QLabel, QStyle,
)

from .. import local_scanner
from ..models import Marketplace


# Special selection identifiers passed via item data. We use sentinel strings
# instead of pointers so the rail can rebuild and still preserve selection by
# value.
SEL_ALL = "__all__"
SEL_LOCAL = "__local__"


class NavRail(QFrame):
    """Left column of the main window."""

    # Emitted when the selection changes. Payload is either:
    #   - a marketplace name (str)
    #   - SEL_ALL ("__all__") for the aggregated view
    #   - SEL_LOCAL ("__local__") for the synthetic local-skills marketplace
    selectionChanged = Signal(str)

    addMarketplaceRequested = Signal()
    openAdminRequested = Signal()
    openSettingsRequested = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setProperty("role", "navRail")
        self.setMinimumWidth(220)
        self.setMaximumWidth(280)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 8, 0, 8)
        layout.setSpacing(0)

        # Section: Browse
        self._add_section(layout, "Browse")

        self.list_top = QListWidget()
        self.list_top.setFocusPolicy(Qt.NoFocus)
        self.list_top.itemSelectionChanged.connect(
            lambda: self._handle_selection(self.list_top, self.list_marketplaces)
        )
        layout.addWidget(self.list_top)

        # Section header for marketplaces with a "+" add button
        header_row = QHBoxLayout()
        header_row.setContentsMargins(12, 12, 8, 4)
        header_row.setSpacing(0)
        mp_label = QLabel("Marketplaces")
        mp_label.setProperty("role", "navSection")
        # Strip default padding from the property-driven label since we control
        # the row margins ourselves.
        mp_label.setStyleSheet("padding: 0;")
        header_row.addWidget(mp_label)
        header_row.addStretch(1)

        self.add_btn = QPushButton("+")
        self.add_btn.setFixedSize(22, 22)
        self.add_btn.setToolTip("Add a marketplace from a Git URL…")
        self.add_btn.setCursor(Qt.PointingHandCursor)
        self.add_btn.setStyleSheet(
            "QPushButton { font-size: 14px; padding: 0; border-radius: 4px; }"
        )
        self.add_btn.clicked.connect(self.addMarketplaceRequested.emit)
        header_row.addWidget(self.add_btn)
        layout.addLayout(header_row)

        self.list_marketplaces = QListWidget()
        self.list_marketplaces.setFocusPolicy(Qt.NoFocus)
        self.list_marketplaces.itemSelectionChanged.connect(
            lambda: self._handle_selection(self.list_marketplaces, self.list_top)
        )
        layout.addWidget(self.list_marketplaces, 1)

        # Footer: admin + settings
        footer = QVBoxLayout()
        footer.setContentsMargins(8, 8, 8, 4)
        footer.setSpacing(4)

        admin_btn = QPushButton("Admin")
        admin_btn.setIcon(self.style().standardIcon(QStyle.SP_FileDialogDetailedView))
        admin_btn.clicked.connect(self.openAdminRequested.emit)
        footer.addWidget(admin_btn)

        settings_btn = QPushButton("Settings")
        settings_btn.setIcon(self.style().standardIcon(QStyle.SP_FileDialogContentsView))
        settings_btn.clicked.connect(self.openSettingsRequested.emit)
        footer.addWidget(settings_btn)
        layout.addLayout(footer)

        self._guard = False  # re-entrancy guard for cross-list deselect

    def _add_section(self, layout: QVBoxLayout, title: str) -> None:
        lbl = QLabel(title)
        lbl.setProperty("role", "navSection")
        layout.addWidget(lbl)

    def _handle_selection(self, current_list: QListWidget, other_list: QListWidget) -> None:
        if self._guard:
            return
        items = current_list.selectedItems()
        if not items:
            return
        self._guard = True
        try:
            other_list.clearSelection()
        finally:
            self._guard = False
        sel_id = items[0].data(Qt.UserRole)
        if sel_id is not None:
            self.selectionChanged.emit(str(sel_id))

    def populate(self, marketplaces: list[Marketplace]) -> None:
        """Rebuild the rail. Preserves the currently selected entry by id."""
        previous = self.current_selection()

        self.list_top.clear()
        all_item = QListWidgetItem("All skills")
        all_item.setData(Qt.UserRole, SEL_ALL)
        self.list_top.addItem(all_item)

        local_mp = next(
            (m for m in marketplaces if m.name == local_scanner.LOCAL_MARKETPLACE_NAME),
            None,
        )
        if local_mp is not None:
            local_item = QListWidgetItem(f"Local skills  ({len(local_mp.plugins)})")
            local_item.setData(Qt.UserRole, SEL_LOCAL)
            self.list_top.addItem(local_item)

        # Auto-size the top list so it doesn't waste vertical space.
        row_h = self.list_top.sizeHintForRow(0) or 28
        self.list_top.setFixedHeight(row_h * self.list_top.count() + 8)

        self.list_marketplaces.clear()
        for mp in marketplaces:
            if mp.name == local_scanner.LOCAL_MARKETPLACE_NAME:
                continue
            installed_count = sum(1 for p in mp.plugins if p.installed_version)
            label = f"{mp.name}  ({installed_count}/{len(mp.plugins)})"
            item = QListWidgetItem(label)
            item.setData(Qt.UserRole, mp.name)
            tooltip = mp.source_repo or mp.source_path or mp.source_kind
            if tooltip:
                item.setToolTip(tooltip)
            if not mp.installed:
                # Dim non-installed marketplaces — still actionable (user can
                # install from the detail pane) but visually de-emphasized.
                item.setForeground(Qt.gray)
            self.list_marketplaces.addItem(item)

        self.set_selection(previous or SEL_ALL)

    def current_selection(self) -> Optional[str]:
        for lst in (self.list_top, self.list_marketplaces):
            items = lst.selectedItems()
            if items:
                return items[0].data(Qt.UserRole)
        return None

    def set_selection(self, sel_id: str) -> None:
        for lst in (self.list_top, self.list_marketplaces):
            for i in range(lst.count()):
                if lst.item(i).data(Qt.UserRole) == sel_id:
                    lst.setCurrentRow(i)
                    return
        # Fallback: select "All skills" if the requested id is gone.
        if self.list_top.count() > 0:
            self.list_top.setCurrentRow(0)

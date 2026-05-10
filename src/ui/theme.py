"""Global dark theme for the app.

Inspired by claude.ai's customize/skills page: deep slate background, soft
borders, subtle hover states, and an accent color used sparingly for the
GitHub indicator and toggle switches.

Apply once at startup with `apply_dark_theme(app)` — every widget downstream
inherits the palette via QSS, no per-widget styling needed.
"""
from __future__ import annotations

from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication


# Color tokens. Keep this list short — every additional shade is a maintenance
# burden. Reuse from here rather than introducing new hex codes inline.
BG_BASE       = "#1a1d22"   # window background
BG_ELEVATED   = "#22262d"   # cards, panels
BG_HOVER      = "#2c3138"   # row hover
BG_SELECTED   = "#343a44"   # selected row
BORDER        = "#2e333b"
BORDER_STRONG = "#3b424c"

TEXT_PRIMARY   = "#e6e8eb"
TEXT_SECONDARY = "#9aa3ad"
TEXT_MUTED     = "#6b7280"

ACCENT         = "#4cd5d2"   # toggle on, focus highlight
ACCENT_PRESSED = "#34b8b5"
SUCCESS        = "#4ade80"
WARNING        = "#f59e0b"
DANGER         = "#f87171"
INFO           = "#60a5fa"


_QSS = f"""
QWidget {{
    background-color: {BG_BASE};
    color: {TEXT_PRIMARY};
    font-family: "Segoe UI", "Inter", system-ui, sans-serif;
    font-size: 13px;
}}
QMainWindow, QDialog {{
    background-color: {BG_BASE};
}}

/* Toolbar */
QToolBar {{
    background-color: {BG_BASE};
    border: none;
    border-bottom: 1px solid {BORDER};
    padding: 6px 8px;
    spacing: 8px;
}}
QToolBar QToolButton {{
    background: transparent;
    color: {TEXT_PRIMARY};
    padding: 6px 10px;
    border-radius: 6px;
}}
QToolBar QToolButton:hover {{
    background: {BG_HOVER};
}}
QToolBar QToolButton:pressed {{
    background: {BG_SELECTED};
}}

/* Status bar */
QStatusBar {{
    background-color: {BG_BASE};
    border-top: 1px solid {BORDER};
    color: {TEXT_SECONDARY};
}}
QStatusBar::item {{ border: none; }}

/* Inputs */
QLineEdit, QPlainTextEdit, QTextEdit, QTextBrowser {{
    background-color: {BG_ELEVATED};
    color: {TEXT_PRIMARY};
    border: 1px solid {BORDER};
    border-radius: 6px;
    padding: 6px 8px;
    selection-background-color: {ACCENT};
    selection-color: #0e1116;
}}
QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus, QTextBrowser:focus {{
    border: 1px solid {ACCENT};
}}

/* Buttons */
QPushButton {{
    background-color: {BG_ELEVATED};
    color: {TEXT_PRIMARY};
    border: 1px solid {BORDER_STRONG};
    border-radius: 6px;
    padding: 6px 14px;
}}
QPushButton:hover {{
    background-color: {BG_HOVER};
    border-color: {ACCENT};
}}
QPushButton:pressed {{
    background-color: {BG_SELECTED};
}}
QPushButton:disabled {{
    color: {TEXT_MUTED};
    border-color: {BORDER};
}}
QPushButton[primary="true"] {{
    background-color: {ACCENT};
    color: #0e1116;
    border: none;
    font-weight: 600;
}}
QPushButton[primary="true"]:hover {{
    background-color: {ACCENT_PRESSED};
}}

/* ComboBox */
QComboBox {{
    background-color: {BG_ELEVATED};
    color: {TEXT_PRIMARY};
    border: 1px solid {BORDER_STRONG};
    border-radius: 6px;
    padding: 4px 10px;
    min-height: 24px;
}}
QComboBox:hover {{
    border-color: {ACCENT};
}}
QComboBox QAbstractItemView {{
    background-color: {BG_ELEVATED};
    color: {TEXT_PRIMARY};
    border: 1px solid {BORDER_STRONG};
    selection-background-color: {BG_SELECTED};
    outline: none;
}}

/* Tree widget (items list in middle column) */
QTreeWidget {{
    background-color: {BG_BASE};
    border: none;
    outline: none;
    show-decoration-selected: 1;
}}
QTreeWidget::item {{
    padding: 6px 4px;
    border-radius: 6px;
}}
QTreeWidget::item:hover {{
    background-color: {BG_HOVER};
}}
QTreeWidget::item:selected,
QTreeWidget::item:selected:active,
QTreeWidget::item:selected:!active {{
    background-color: {BG_SELECTED};
    color: {TEXT_PRIMARY};
}}
QTreeWidget::branch {{
    background: transparent;
}}
QHeaderView::section {{
    background-color: {BG_ELEVATED};
    color: {TEXT_SECONDARY};
    border: none;
    border-bottom: 1px solid {BORDER};
    padding: 6px 8px;
    font-weight: 500;
}}

/* List widget (used in nav rail) */
QListWidget {{
    background-color: transparent;
    border: none;
    outline: none;
    padding: 4px;
}}
QListWidget::item {{
    padding: 8px 10px;
    border-radius: 6px;
    margin: 1px 4px;
    color: {TEXT_PRIMARY};
}}
QListWidget::item:hover {{
    background-color: {BG_HOVER};
}}
QListWidget::item:selected,
QListWidget::item:selected:active,
QListWidget::item:selected:!active {{
    background-color: {BG_SELECTED};
    color: {TEXT_PRIMARY};
}}

/* Tables */
QTableWidget {{
    background-color: {BG_BASE};
    gridline-color: {BORDER};
    border: 1px solid {BORDER};
    border-radius: 6px;
    selection-background-color: {BG_SELECTED};
    selection-color: {TEXT_PRIMARY};
}}
QTableWidget::item {{
    padding: 4px;
}}

/* Tabs (admin dialog) */
QTabWidget::pane {{
    border: 1px solid {BORDER};
    border-radius: 6px;
    top: -1px;
}}
QTabBar::tab {{
    background: transparent;
    color: {TEXT_SECONDARY};
    padding: 8px 16px;
    border: none;
    border-bottom: 2px solid transparent;
}}
QTabBar::tab:hover {{
    color: {TEXT_PRIMARY};
}}
QTabBar::tab:selected {{
    color: {TEXT_PRIMARY};
    border-bottom: 2px solid {ACCENT};
}}

/* Splitter handle */
QSplitter::handle {{
    background-color: {BORDER};
}}
QSplitter::handle:hover {{
    background-color: {BORDER_STRONG};
}}

/* Scrollbars */
QScrollBar:vertical {{
    background: transparent;
    width: 10px;
    margin: 2px;
}}
QScrollBar::handle:vertical {{
    background: {BORDER_STRONG};
    border-radius: 4px;
    min-height: 24px;
}}
QScrollBar::handle:vertical:hover {{
    background: {TEXT_MUTED};
}}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
    height: 0;
}}
QScrollBar:horizontal {{
    background: transparent;
    height: 10px;
    margin: 2px;
}}
QScrollBar::handle:horizontal {{
    background: {BORDER_STRONG};
    border-radius: 4px;
    min-width: 24px;
}}
QScrollBar::handle:horizontal:hover {{
    background: {TEXT_MUTED};
}}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{
    width: 0;
}}

/* Checkboxes (regular ones, not the toggle switch) */
QCheckBox {{
    spacing: 6px;
    color: {TEXT_PRIMARY};
}}
QCheckBox::indicator {{
    width: 16px;
    height: 16px;
    border: 1px solid {BORDER_STRONG};
    border-radius: 3px;
    background-color: {BG_ELEVATED};
}}
QCheckBox::indicator:hover {{
    border-color: {ACCENT};
}}
QCheckBox::indicator:checked {{
    background-color: {ACCENT};
    border-color: {ACCENT};
}}

/* GroupBox (admin sub-sections) */
QGroupBox {{
    border: 1px solid {BORDER};
    border-radius: 6px;
    margin-top: 12px;
    padding-top: 14px;
}}
QGroupBox::title {{
    subcontrol-origin: margin;
    subcontrol-position: top left;
    padding: 0 8px;
    color: {TEXT_SECONDARY};
}}

/* MessageBox */
QMessageBox {{
    background-color: {BG_ELEVATED};
}}

/* Tooltip */
QToolTip {{
    background-color: {BG_ELEVATED};
    color: {TEXT_PRIMARY};
    border: 1px solid {BORDER_STRONG};
    padding: 6px;
    border-radius: 4px;
}}

/* Custom property hooks for the new layout */
QFrame[role="navRail"] {{
    background-color: {BG_BASE};
    border-right: 1px solid {BORDER};
}}
QFrame[role="middlePane"] {{
    background-color: {BG_BASE};
    border-right: 1px solid {BORDER};
}}
QFrame[role="detailPane"] {{
    background-color: {BG_BASE};
}}
QFrame[role="metadataCard"] {{
    background-color: {BG_ELEVATED};
    border: 1px solid {BORDER};
    border-radius: 8px;
}}
QLabel[role="navSection"] {{
    color: {TEXT_MUTED};
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 12px 12px 4px 12px;
}}
QLabel[role="metaLabel"] {{
    color: {TEXT_MUTED};
    font-size: 11px;
}}
QLabel[role="metaValue"] {{
    color: {TEXT_PRIMARY};
    font-size: 13px;
}}
QLabel[role="detailTitle"] {{
    font-size: 18px;
    font-weight: 600;
    color: {TEXT_PRIMARY};
}}
QLabel[role="detailSubtitle"] {{
    color: {TEXT_SECONDARY};
}}
"""


def apply_dark_theme(app: QApplication) -> None:
    """Apply the dark theme to the QApplication.

    Sets the palette (so native dialogs pick up the right colors) and the
    global stylesheet.
    """
    pal = QPalette()
    pal.setColor(QPalette.Window, QColor(BG_BASE))
    pal.setColor(QPalette.WindowText, QColor(TEXT_PRIMARY))
    pal.setColor(QPalette.Base, QColor(BG_ELEVATED))
    pal.setColor(QPalette.AlternateBase, QColor(BG_HOVER))
    pal.setColor(QPalette.Text, QColor(TEXT_PRIMARY))
    pal.setColor(QPalette.Button, QColor(BG_ELEVATED))
    pal.setColor(QPalette.ButtonText, QColor(TEXT_PRIMARY))
    pal.setColor(QPalette.Highlight, QColor(ACCENT))
    pal.setColor(QPalette.HighlightedText, QColor("#0e1116"))
    pal.setColor(QPalette.ToolTipBase, QColor(BG_ELEVATED))
    pal.setColor(QPalette.ToolTipText, QColor(TEXT_PRIMARY))
    pal.setColor(QPalette.PlaceholderText, QColor(TEXT_MUTED))
    pal.setColor(QPalette.Disabled, QPalette.Text, QColor(TEXT_MUTED))
    pal.setColor(QPalette.Disabled, QPalette.WindowText, QColor(TEXT_MUTED))
    pal.setColor(QPalette.Disabled, QPalette.ButtonText, QColor(TEXT_MUTED))
    app.setPalette(pal)
    app.setStyleSheet(_QSS)

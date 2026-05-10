"""Settings dialog: Git authentication only.

Marketplace ownership / install / auto-update are handled in the Admin dialog
(Admin → Marketplaces tab), which is the canonical surface for marketplace
configuration. This dialog is reached from the **Settings** menu in the main
window's menubar.
"""
from __future__ import annotations

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QFormLayout, QLineEdit,
    QPushButton, QLabel, QGroupBox, QWidget,
)

from ..config import Settings, save_settings
from ..github_client import GitHubClient


class SettingsDialog(QDialog):
    def __init__(self, settings: Settings, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Settings — Git authentication")
        self.resize(560, 220)
        self._settings = settings

        layout = QVBoxLayout(self)

        token_box = QGroupBox("Git authentication (GitHub Personal Access Token)")
        token_form = QFormLayout(token_box)
        self.token_edit = QLineEdit(settings.github_token)
        self.token_edit.setEchoMode(QLineEdit.Password)
        self.token_edit.setPlaceholderText("ghp_... (Personal Access Token)")
        self.token_edit.setToolTip(
            "Stored locally in %APPDATA%\\SkillManager\\settings.json.\n"
            "Required scopes: 'repo' (for admin uploads / PR creation) and "
            "'read:org' (optional, for private orgs). For public-only browsing "
            "you can leave this empty but you'll hit lower rate limits."
        )
        show_btn = QPushButton("Show")
        show_btn.setCheckable(True)
        show_btn.toggled.connect(
            lambda on: self.token_edit.setEchoMode(QLineEdit.Normal if on else QLineEdit.Password)
        )
        token_row_top = QHBoxLayout()
        token_row_top.addWidget(self.token_edit, 1)
        token_row_top.addWidget(show_btn)
        token_form.addRow("Token:", self._wrap(token_row_top))

        test_btn = QPushButton("Test connection")
        test_btn.clicked.connect(self._test_token)
        help_btn = QPushButton("Generate token on GitHub…")
        help_btn.setToolTip("Open https://github.com/settings/tokens in your browser.")
        help_btn.clicked.connect(self._open_token_help)
        self.token_status = QLabel("")
        token_row = QHBoxLayout()
        token_row.addWidget(test_btn)
        token_row.addWidget(help_btn)
        token_row.addWidget(self.token_status, 1)
        token_form.addRow("", self._wrap(token_row))
        layout.addWidget(token_box)

        hint = QLabel(
            "Marketplace ownership, install / uninstall and auto-update are "
            "configured from <b>Admin → Marketplaces</b>."
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #555")
        layout.addWidget(hint)

        layout.addStretch(1)

        btns = QHBoxLayout()
        btns.addStretch(1)
        ok = QPushButton("Save")
        ok.setDefault(True)
        ok.clicked.connect(self._save)
        cancel = QPushButton("Cancel")
        cancel.clicked.connect(self.reject)
        btns.addWidget(cancel)
        btns.addWidget(ok)
        layout.addLayout(btns)

    @staticmethod
    def _wrap(box):
        w = QWidget()
        w.setLayout(box)
        return w

    def _save(self):
        self._settings.github_token = self.token_edit.text().strip()
        save_settings(self._settings)
        self.accept()

    def _open_token_help(self):
        QDesktopServices.openUrl(QUrl("https://github.com/settings/tokens"))

    def _test_token(self):
        token = self.token_edit.text().strip()
        gh = GitHubClient(token)
        ok, info = gh.auth_check()
        if ok:
            self.token_status.setText(f"OK — authenticated as {info}")
            self.token_status.setStyleSheet("color: #2e7d32")
        else:
            self.token_status.setText(f"Failed: {info}")
            self.token_status.setStyleSheet("color: #c62828")

"""Edit a SKILL.md: frontmatter (name + description) + body."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QFormLayout, QLineEdit,
    QPlainTextEdit, QPushButton, QLabel, QMessageBox,
)

from ..frontmatter import parse_frontmatter, update_frontmatter


class SkillEditor(QDialog):
    def __init__(self, skill_md_path: Path, parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"Edit skill — {skill_md_path}")
        self.resize(900, 700)
        self._path = skill_md_path

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel(str(skill_md_path)))

        form = QFormLayout()
        self.name_edit = QLineEdit()
        self.desc_edit = QPlainTextEdit()
        self.desc_edit.setMaximumHeight(80)
        form.addRow("Name:", self.name_edit)
        form.addRow("Description:", self.desc_edit)
        layout.addLayout(form)

        layout.addWidget(QLabel("Body (Markdown):"))
        self.body_edit = QPlainTextEdit()
        mono = QFont("Consolas")
        mono.setStyleHint(QFont.Monospace)
        mono.setPointSize(10)
        self.body_edit.setFont(mono)
        layout.addWidget(self.body_edit, 1)

        btns = QHBoxLayout()
        btns.addStretch(1)
        cancel = QPushButton("Cancel")
        cancel.clicked.connect(self.reject)
        save = QPushButton("Save")
        save.setDefault(True)
        save.clicked.connect(self._save)
        btns.addWidget(cancel)
        btns.addWidget(save)
        layout.addLayout(btns)

        self._load()

    def _load(self):
        try:
            text = self._path.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Cannot read {self._path}:\n{e}")
            self.reject()
            return
        fm, body = parse_frontmatter(text)
        self.name_edit.setText(fm.get("name", ""))
        self.desc_edit.setPlainText(fm.get("description", ""))
        self.body_edit.setPlainText(body.lstrip("\n"))

    def _save(self):
        try:
            existing = self._path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            existing = "---\n---\n"
        new_fm = {
            "name": self.name_edit.text().strip(),
            "description": self.desc_edit.toPlainText().strip().replace("\n", " "),
        }
        # Replace body fully
        from .._frontmatter_util import replace_body  # local helper
        new_text = replace_body(existing, self.body_edit.toPlainText(), new_fm)
        try:
            self._path.write_text(new_text, encoding="utf-8")
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Cannot write {self._path}:\n{e}")
            return
        self.accept()

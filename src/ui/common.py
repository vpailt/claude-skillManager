"""Shared UI helpers: status colors, busy-cursor context, etc."""
from __future__ import annotations

from contextlib import contextmanager

from PySide6.QtCore import Qt
from PySide6.QtGui import QBrush, QColor, QGuiApplication

from ..models import InstallState


_STATE_LABEL = {
    InstallState.NOT_INSTALLED: "Not installed",
    InstallState.INSTALLED:     "Up to date",
    InstallState.OUTDATED:      "Update available",
    InstallState.LOCAL_ONLY:    "Local only",
    InstallState.UNKNOWN:       "Unknown",
}

_STATE_COLOR = {
    InstallState.NOT_INSTALLED: QColor("#9aa3ad"),
    InstallState.INSTALLED:     QColor("#2e7d32"),
    InstallState.OUTDATED:      QColor("#ed6c02"),
    InstallState.LOCAL_ONLY:    QColor("#0288d1"),
    InstallState.UNKNOWN:       QColor("#616161"),
}


def state_label(state: InstallState) -> str:
    return _STATE_LABEL.get(state, str(state))


def state_brush(state: InstallState) -> QBrush:
    return QBrush(_STATE_COLOR.get(state, QColor("#000000")))


@contextmanager
def busy_cursor():
    QGuiApplication.setOverrideCursor(Qt.WaitCursor)
    try:
        yield
    finally:
        QGuiApplication.restoreOverrideCursor()

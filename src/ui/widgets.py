"""Reusable custom widgets that don't fit cleanly in larger UI modules.

Currently:
  * ``ToggleSwitch`` — iOS-style on/off switch.
"""
from __future__ import annotations

from PySide6.QtCore import (
    QEasingCurve, QPropertyAnimation, QRectF, QSize, Qt, Signal, Property,
)
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QAbstractButton

from . import theme


class ToggleSwitch(QAbstractButton):
    """An animated toggle. Behaves like a checkable button.

    Emits ``toggled(bool)`` (inherited from QAbstractButton). The animation
    runs on the private ``_offset`` property so the painter can interpolate
    the knob between the two end positions smoothly.
    """

    toggled_by_user = Signal(bool)

    _TRACK_W = 36
    _TRACK_H = 20
    _PAD = 2  # gap between knob and track edge

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setCheckable(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumSize(self._TRACK_W, self._TRACK_H)
        self.setFixedSize(self._TRACK_W, self._TRACK_H)
        self._offset = float(self._PAD)
        self._anim = QPropertyAnimation(self, b"offset", self)
        self._anim.setDuration(140)
        self._anim.setEasingCurve(QEasingCurve.OutCubic)
        self.toggled.connect(self._on_toggled)

    def sizeHint(self) -> QSize:
        return QSize(self._TRACK_W, self._TRACK_H)

    def _on_toggled(self, checked: bool) -> None:
        end = self._knob_x(checked)
        self._anim.stop()
        self._anim.setStartValue(self._offset)
        self._anim.setEndValue(end)
        self._anim.start()
        # Distinguish user clicks from programmatic setChecked: emit only on
        # genuine clicks. We approximate that by checking if the mouse button
        # is down — Qt sets it during user-driven toggles.
        if self.isDown() or self.hasFocus():
            self.toggled_by_user.emit(checked)

    def setChecked(self, checked: bool) -> None:
        # When set programmatically, snap the knob to the right place without
        # animating to avoid distracting flicker on initial render.
        super().setChecked(checked)
        if not self._anim.state():
            self._offset = self._knob_x(checked)
            self.update()

    def _knob_x(self, checked: bool) -> float:
        knob_d = self._TRACK_H - 2 * self._PAD
        return float(self._TRACK_W - knob_d - self._PAD) if checked else float(self._PAD)

    def get_offset(self) -> float:
        return self._offset

    def set_offset(self, value: float) -> None:
        self._offset = value
        self.update()

    offset = Property(float, get_offset, set_offset)

    def paintEvent(self, _event) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        knob_d = self._TRACK_H - 2 * self._PAD

        # Track
        track_color = QColor(theme.ACCENT) if self.isChecked() else QColor(theme.BORDER_STRONG)
        if not self.isEnabled():
            track_color.setAlpha(120)
        p.setPen(Qt.NoPen)
        p.setBrush(track_color)
        p.drawRoundedRect(QRectF(0, 0, self._TRACK_W, self._TRACK_H),
                          self._TRACK_H / 2, self._TRACK_H / 2)

        # Knob
        knob_color = QColor("#0e1116") if self.isChecked() else QColor(theme.TEXT_PRIMARY)
        p.setBrush(knob_color)
        p.setPen(QPen(QColor(0, 0, 0, 40), 0.5))
        p.drawEllipse(QRectF(self._offset, self._PAD, knob_d, knob_d))
        p.end()

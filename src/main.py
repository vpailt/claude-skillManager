"""Application entry point."""
from __future__ import annotations

import sys
import traceback
from datetime import datetime

from PySide6.QtWidgets import QApplication, QMessageBox

from . import config
from .ui.main_window import MainWindow
from .ui.theme import apply_dark_theme


def _crash_log_file():
    return config.app_settings_dir() / "errors.log"


def _install_global_exception_handler() -> None:
    """Show a popup + write to errors.log for any otherwise-silent exception.

    Without this, exceptions raised inside Qt slots in a windowed PyInstaller
    build go to a closed stderr and the user sees nothing happen.
    """
    def handle(exc_type, exc_value, exc_tb):
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc_value, exc_tb)
            return
        text = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
        try:
            log = _crash_log_file()
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("a", encoding="utf-8") as f:
                f.write(f"\n=== {datetime.now().isoformat()} ===\n{text}\n")
        except Exception:
            pass
        try:
            box = QMessageBox()
            box.setIcon(QMessageBox.Critical)
            box.setWindowTitle("Unexpected error")
            box.setText("An unexpected error occurred.")
            box.setDetailedText(text)
            box.setStandardButtons(QMessageBox.Ok)
            box.exec()
        except Exception:
            sys.__excepthook__(exc_type, exc_value, exc_tb)
    sys.excepthook = handle


def main() -> int:
    _install_global_exception_handler()
    app = QApplication(sys.argv)
    app.setApplicationName("SkillManager")
    app.setOrganizationName("SkillManager")
    apply_dark_theme(app)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())

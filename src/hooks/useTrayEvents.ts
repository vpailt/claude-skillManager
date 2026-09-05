import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { forceRefresh } from "@/hooks/useRefresh";
import { createLogger } from "@/lib/logger";
import { useHelpDialog } from "@/stores/helpDialog";
import { useSettingsDialog } from "@/stores/settingsDialog";

const log = createLogger("tray");

/**
 * Reacts to events emitted by the Rust tray menu (see `src-tauri/src/tray.rs`):
 * - `tray://refresh`        → invalidate the refresh query
 * - `tray://open-settings`  → open the Settings dialog
 * - `tray://open-help`      → open the Help dialog
 */
export function useTrayEvents() {
  const qc = useQueryClient();

  useEffect(() => {
    const offs: Array<Promise<() => void>> = [];

    offs.push(
      listen("tray://refresh", () => {
        log.info("tray: refresh requested");
        // A menu click is the user asking, so it forces — same as the sidebar.
        forceRefresh(qc);
      })
    );

    offs.push(
      listen("tray://open-settings", () => {
        log.info("tray: open settings");
        useSettingsDialog.getState().openTo("general");
      })
    );

    offs.push(
      listen("tray://open-help", () => {
        log.info("tray: open help");
        useHelpDialog.getState().setOpen(true);
      })
    );

    return () => {
      for (const p of offs) p.then((fn) => fn());
    };
  }, [qc]);
}

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { createLogger } from "@/lib/logger";

const log = createLogger("tray");

/**
 * Reacts to events emitted by the Rust tray menu (see `src-tauri/src/tray.rs`):
 * - `tray://refresh`        → invalidate the refresh query
 * - `tray://open-settings`  → navigate to /settings
 */
export function useTrayEvents() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    const offs: Array<Promise<() => void>> = [];

    offs.push(
      listen("tray://refresh", () => {
        log.info("tray: refresh requested");
        qc.invalidateQueries({ queryKey: ["refresh"] });
      })
    );

    offs.push(
      listen("tray://open-settings", () => {
        log.info("tray: open settings");
        navigate("/settings");
      })
    );

    return () => {
      for (const p of offs) p.then((fn) => fn());
    };
  }, [qc, navigate]);
}

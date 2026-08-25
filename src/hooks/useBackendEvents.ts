// Wakes the refresh query when the backend notices something changed.
//
// Three sources, all of them things the UI cannot see for itself:
//   - `skills-tree-changed`  a skill folder appeared or disappeared on disk
//   - `claude-state-changed` `~/.claude` moved (a `/plugin install` from a CLI)
//   - `catalog-changed`      the Rust catalogue poller completed a sweep
//
// Without this, a change made outside the app waited for a window focus or the
// 30-minute timer. Note the backend is the one that *detects*; this hook only
// invalidates, so the classification still comes from a single place.
import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { createLogger } from "@/lib/logger";

const log = createLogger("backend-events");

/** Coalescing window. A single `/plugin install` rewrites several files, and
 *  each atomic write is a create + a rename — without this, one operation would
 *  trigger a handful of full sweeps. */
const DEBOUNCE_MS = 1000;

const EVENTS = [
  "skills-tree-changed",
  "claude-state-changed",
  "catalog-changed",
] as const;

export function useBackendEvents() {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const invalidate = (reason: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        log.debug(`refreshing after ${reason}`);
        qc.invalidateQueries({ queryKey: ["refresh"] });
      }, DEBOUNCE_MS);
    };

    const unlisteners: Promise<UnlistenFn>[] = EVENTS.map((name) =>
      listen(name, () => invalidate(name))
    );

    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const p of unlisteners) p.then((fn) => fn()).catch(() => {});
    };
  }, [qc]);
}

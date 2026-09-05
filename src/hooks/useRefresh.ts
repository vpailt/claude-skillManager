import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import type { RefreshMode } from "@/lib/types";
import { useApp } from "@/stores/app";
import { useProgress } from "@/stores/progress";
import { createLogger } from "@/lib/logger";

const log = createLogger("refresh");

/** Stable id: a sweep is a singleton (a process-wide mutex makes sure of it),
 *  so re-beginning under the same id restarts the bar rather than stacking. */
const REFRESH_TASK = "refresh";

/** Set by {@link forceRefresh} and consumed by the very next `queryFn` run.
 *
 *  TanStack has nowhere to carry a per-invocation argument, and the distinction
 *  matters: a background trigger may be answered from the backend's short reuse
 *  window, while a user gesture — or a change this app just made on disk — must
 *  not be, or the new marketplace would be missing from the answer that follows
 *  its own creation. */
let modeNext: RefreshMode | null = null;

/**
 * Ask for a real sweep rather than a possibly-reused one.
 *
 * Two flavours, and picking the right one is what keeps a click responsive:
 *
 * - `"local"` (the default) — this app just changed the install state on disk.
 *   The reuse window is skipped, but the backend also drops the manifest probes
 *   for plugins nobody installed, which were the bulk of a sweep's wall clock
 *   (22 s of 24 s, measured). Use it for install, uninstall, enable/disable,
 *   marketplace added, skill deleted.
 * - `"user"` — the explicit Rafraîchir gesture (sidebar or tray). Full sweep,
 *   and every host's failure tally is cleared, so reconnecting the VPN and
 *   pressing Rafraîchir works immediately instead of after the circuit
 *   breaker's cooldown.
 *
 * A pending `"user"` is never downgraded by a `"local"` that lands before the
 * query runs: the user asked for the expensive one.
 */
export function forceRefresh(qc: QueryClient, mode: RefreshMode = "local") {
  if (modeNext !== "user") modeNext = mode;
  qc.invalidateQueries({ queryKey: ["refresh"] });
}

export function useRefresh() {
  const setMarketplaces = useApp((s) => s.setMarketplaces);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["refresh"],
    queryFn: () => {
      const mode = modeNext ?? "auto";
      modeNext = null;
      return api.refreshAll(mode);
    },
    // `refresh_all` is an N+1 sweep across the forge (registry, push rights, then
    // a manifest read per plugin and a skills listing per installed plugin). At
    // the old 60 s staleness it re-ran on essentially every alt-tab into the
    // app. Ten minutes keeps the view current without turning window focus into
    // a network event.
    staleTime: 10 * 60_000,
    // Deliberately off. `claude_watch` reports a `/plugin install` run from a
    // terminal within a second, and `catalog_poller` covers upstream changes
    // even with no window at all — so returning to the window has nothing left
    // to discover, and this only turned alt-tabbing into forge traffic.
    refetchOnWindowFocus: false,
    // A safety net, no longer the mechanism. Upstream detection lives in
    // `catalog_poller` on the Rust side, because this interval is paused while
    // the window is hidden (`refetchIntervalInBackground` defaults to false) —
    // and in tray mode the window is *destroyed*, so the query stops existing
    // rather than merely slowing down. Kept slow: refresh_all is quota-limited,
    // and the poller is doing the real work.
    refetchInterval: 30 * 60_000,
  });

  useEffect(() => {
    if (query.data) {
      log.info(
        "refresh result:",
        `${query.data.marketplaces.length} marketplace(s)`
      );
      setMarketplaces(query.data.marketplaces, query.data.localOnly);
    }
  }, [query.data, setMarketplaces]);

  // refresh_all reconciles open PR statuses backend-side (drops merged/closed
  // pending records). Refresh the dependent queries so the Admin "in review"
  // badges and PR lists reflect it without needing the removed PR-history tab.
  useEffect(() => {
    if (query.dataUpdatedAt) {
      qc.invalidateQueries({ queryKey: ["pending-prs"] });
      qc.invalidateQueries({ queryKey: ["pr-history"] });
      qc.invalidateQueries({ queryKey: ["remote-skills"] });
    }
  }, [query.dataUpdatedAt, qc]);

  useEffect(() => {
    if (query.error) {
      log.error("refresh failed:", query.error);
    }
  }, [query.error]);

  // A sweep is the slowest thing the app does — up to the 75 s budget — and
  // until now it was a spinning icon in the sidebar and nothing else. Give the
  // status bar a task for its whole duration; the event below fills in what it
  // is currently reading.
  const isFetching = query.isFetching;
  useEffect(() => {
    if (!isFetching) {
      useProgress.getState().end(REFRESH_TASK);
      return;
    }
    useProgress.getState().begin({
      id: REFRESH_TASK,
      kind: "refresh",
      label: "Rafraîchissement",
      detail: "lecture de l'installation locale",
    });
    // No cleanup that ends the task: the effect re-runs when `isFetching`
    // flips, and the branch above is what closes it. Ending it here as well
    // would clear the task on any unrelated re-render of this hook.
  }, [isFetching]);

  // Rust commands stream progress via the "refresh-progress" event. The payload
  // is the backend's own wording (`auto-update: <mp>` / `fetching: <mp>`);
  // translate it here rather than in Rust, which has no business holding UI
  // strings.
  useEffect(() => {
    const unlisten = listen<string>("refresh-progress", (e) => {
      log.debug(e.payload);
      // Split on the first separator only — `split(": ", 2)` would drop
      // anything past a second one instead of keeping it in the name.
      const cut = e.payload.indexOf(": ");
      const stage = cut < 0 ? "" : e.payload.slice(0, cut);
      const name = cut < 0 ? "" : e.payload.slice(cut + 2);
      const detail =
        stage === "auto-update"
          ? `mise à jour de ${name}`
          : stage === "fetching"
            ? `lecture de ${name}`
            : e.payload;
      useProgress.getState().update(REFRESH_TASK, { detail });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return query;
}

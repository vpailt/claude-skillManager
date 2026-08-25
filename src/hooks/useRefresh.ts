import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { createLogger } from "@/lib/logger";

const log = createLogger("refresh");

export function useRefresh() {
  const setMarketplaces = useApp((s) => s.setMarketplaces);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["refresh"],
    queryFn: api.refreshAll,
    // `refresh_all` is an N+1 sweep across the forge (registry, push rights, then
    // a manifest read per plugin and a skills listing per installed plugin). At
    // the old 60 s staleness it re-ran on essentially every alt-tab into the
    // app. Ten minutes keeps the view current without turning window focus into
    // a network event.
    staleTime: 10 * 60_000,
    // Still worth refetching on focus, though `claude_watch` now usually beats
    // the user to it: a CLI install fires `claude-state-changed` within a second.
    refetchOnWindowFocus: true,
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

  // Rust commands can stream progress via the "refresh-progress" event.
  useEffect(() => {
    const unlisten = listen<string>("refresh-progress", (e) => {
      log.debug(e.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return query;
}

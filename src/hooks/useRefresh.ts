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
    staleTime: 60_000,
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

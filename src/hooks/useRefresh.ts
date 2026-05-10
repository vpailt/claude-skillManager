import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";

export function useRefresh() {
  const setMarketplaces = useApp((s) => s.setMarketplaces);

  const query = useQuery({
    queryKey: ["refresh"],
    queryFn: api.refreshAll,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (query.data) {
      setMarketplaces(query.data.marketplaces, query.data.localOnly);
    }
  }, [query.data, setMarketplaces]);

  // Rust commands can stream progress via the "refresh-progress" event.
  useEffect(() => {
    const unlisten = listen<string>("refresh-progress", (e) => {
      // eslint-disable-next-line no-console
      console.debug("[refresh]", e.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return query;
}

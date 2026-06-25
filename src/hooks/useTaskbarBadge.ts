import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useApp } from "@/stores/app";
import { api } from "@/lib/api";
import { createLogger } from "@/lib/logger";

const log = createLogger("taskbar-badge");

/**
 * Drives the Windows taskbar overlay badge (`set_overlay_icon`) with the number
 * of "actions à traiter". The total mirrors the Dashboard:
 *
 *   outdated plugins  +  open PRs on tracked marketplaces
 *
 * `0` clears the badge. No-op on non-Windows (the Rust command is a no-op).
 *
 * The overlay decorates the taskbar *button*, which is destroyed while the
 * window is hidden to tray, so we re-apply the last count whenever the window
 * regains focus (i.e. is shown again).
 */
export function useTaskbarBadge() {
  const marketplaces = useApp((s) => s.marketplaces);

  const settings = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
    staleTime: 60_000,
  });
  const trackedNames = useMemo(
    () =>
      (settings.data?.marketplaces ?? [])
        .filter((m) => m.trackPrs)
        .map((m) => m.name),
    [settings.data]
  );

  // Same query key/options as the Dashboard's tracking section so they share one
  // cache entry — no extra network cost.
  const tracked = useQuery({
    queryKey: ["tracked-prs"],
    queryFn: () => api.trackedMarketplacePrs(),
    staleTime: 5 * 60_000,
    enabled: trackedNames.length > 0,
    refetchOnWindowFocus: false,
  });

  const outdatedCount = useMemo(
    () =>
      marketplaces
        .flatMap((m) => m.plugins)
        .filter((p) => p.installState === "outdated").length,
    [marketplaces]
  );
  const trackedCount =
    trackedNames.length > 0 ? tracked.data?.length ?? 0 : 0;

  const count = outdatedCount + trackedCount;

  // Hold the last applied count so the focus re-apply below has something to
  // push without recomputing.
  const lastRef = useRef<number | null>(null);

  useEffect(() => {
    if (lastRef.current === count) return;
    lastRef.current = count;
    log.debug(
      `taskbar badge → ${count} (obsolètes=${outdatedCount}, PR=${trackedCount})`
    );
    api
      .setTaskbarBadge(count)
      .catch((e) => log.warn("setTaskbarBadge failed", e));
  }, [count, outdatedCount, trackedCount]);

  useEffect(() => {
    const w = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    w.onFocusChanged(({ payload: focused }) => {
      if (focused && lastRef.current != null) {
        api.setTaskbarBadge(lastRef.current).catch(() => {});
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);
}

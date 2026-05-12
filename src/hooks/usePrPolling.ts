import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useNotifications } from "@/stores/notifications";
import { createLogger } from "@/lib/logger";

const log = createLogger("pr-polling");

/**
 * Discreet polling of open PR statuses. Driven by `ui.prPollingEnabled` and
 * `ui.prPollingIntervalSeconds` from app settings.
 *
 * For each PR whose stored status is "open", calls
 * `pr_history_refresh_status` and fires a notification if the status changed
 * (open → merged | closed).
 */
export function usePrPolling() {
  const qc = useQueryClient();
  const push = useNotifications((s) => s.push);

  const settings = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });
  const history = useQuery({
    queryKey: ["pr-history"],
    queryFn: api.prHistoryList,
    refetchOnWindowFocus: false,
  });

  // No onError here on purpose: polling fires every 15s+ for every open PR, so
  // a flaky network would spam the user with toasts. The per-call failure is
  // logged below via `log.warn` and that's enough.
  const pollOne = useMutation({
    mutationFn: ({ repo, number }: { repo: string; number: number }) =>
      api.prHistoryRefreshStatus(repo, number),
  });

  const lastTickRef = useRef<number>(0);
  const enabled = settings.data?.ui?.prPollingEnabled ?? false;
  const intervalSec = Math.max(
    15,
    settings.data?.ui?.prPollingIntervalSeconds ?? 60
  );

  useEffect(() => {
    if (!enabled) {
      log.debug("polling disabled");
      return;
    }
    log.info(`polling enabled every ${intervalSec}s`);
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const items = history.data ?? [];
      const open = items.filter((it) => it.status === "open");
      if (open.length === 0) return;
      log.debug(`polling tick: ${open.length} open PR(s)`);
      for (const it of open) {
        if (cancelled) return;
        try {
          const newStatus = await pollOne.mutateAsync({
            repo: it.repo,
            number: it.number,
          });
          if (newStatus !== it.status) {
            log.info(
              `PR #${it.number} ${it.repo} status: ${it.status} → ${newStatus}`
            );
            push(
              {
                kind: newStatus === "merged" ? "success" : "info",
                title: `PR #${it.number} ${newStatus}`,
                body: `${it.repo} — ${it.title}`,
              },
              { native: true }
            );
          }
        } catch (err) {
          log.warn(`polling PR #${it.number} failed:`, err);
        }
      }
      lastTickRef.current = Date.now();
      qc.invalidateQueries({ queryKey: ["pr-history"] });
    };

    const handle = window.setInterval(tick, intervalSec * 1000);
    // first tick after a short delay so we don't hammer on focus
    const first = window.setTimeout(tick, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
      window.clearTimeout(first);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalSec, history.data?.length]);
}

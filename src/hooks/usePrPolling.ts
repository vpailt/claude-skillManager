import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { PRRecord } from "@/lib/types";
import { useNotifications } from "@/stores/notifications";
import { createLogger } from "@/lib/logger";

const log = createLogger("pr-polling");

// The marketplace PR tracking (`["tracked-prs"]`) is far more expensive than a
// per-PR status check — it lists open PRs across every tracked marketplace repo
// AND each of its plugins' repos. Refresh it at most once per minute, even when
// the PR-status poll ticks faster. Invalidation only triggers a network refetch
// when the tracking view (Dashboard / Admin) is actually mounted, so it's free
// while you're on another tab.
const TRACKED_PRS_MIN_MS = 60_000;

/**
 * Discreet polling of open PR statuses. Driven by `ui.prPollingEnabled` and
 * `ui.prPollingIntervalSeconds` from app settings.
 *
 * For each PR whose stored status is "open", calls
 * `pr_history_refresh_status` and fires a notification if the status changed
 * (open → merged | closed).
 *
 * Also refreshes the marketplace PR tracking (`["tracked-prs"]`) at most once
 * per minute (independent of the poll interval) so the "Suivi des marketplaces"
 * count stays live while the dashboard/admin view is open.
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
  const lastTrackedRef = useRef<number>(0);
  // PRs we've already notified about, keyed by `repo#number:newStatus`. Guards
  // against re-firing the same transition: the effect's `tick` closure can hold
  // a stale `history.data` (a status change doesn't change the array length, so
  // the effect doesn't re-run), and without this every poll would re-notify.
  const notifiedRef = useRef<Set<string>>(new Set());
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

      // Refresh the marketplace PR tracking at most once per minute, before the
      // "no open PRs" early-return so it stays fresh even with no own PRs to
      // poll. Invalidate-only: refetches only when the tracking view is mounted.
      if (Date.now() - lastTrackedRef.current >= TRACKED_PRS_MIN_MS) {
        lastTrackedRef.current = Date.now();
        log.debug("refreshing marketplace PR tracking");
        qc.invalidateQueries({ queryKey: ["tracked-prs"] });
      }

      // Read the freshest history from the query cache rather than the
      // closed-over `history.data`. A status transition (open→merged) leaves the
      // array length unchanged, so this effect doesn't re-run and its closure
      // would otherwise keep comparing against a stale "open" — re-firing the
      // notification on every tick.
      const items = qc.getQueryData<PRRecord[]>(["pr-history"]) ?? history.data ?? [];
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
            const key = `${it.repo}#${it.number}:${newStatus}`;
            if (!notifiedRef.current.has(key)) {
              notifiedRef.current.add(key);
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
            // The backend already drops matching pending records when status
            // leaves "open"; refresh the query so the Admin badges clear.
            if (newStatus !== "open") {
              qc.invalidateQueries({ queryKey: ["pending-prs"] });
              qc.invalidateQueries({ queryKey: ["remote-skills"] });
            }
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

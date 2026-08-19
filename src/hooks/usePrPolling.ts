import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useNotifications } from "@/stores/notifications";
import { createLogger } from "@/lib/logger";
import type { PrStatusChange } from "@/lib/types";

const log = createLogger("pr-polling");

// The marketplace PR tracking (`["tracked-prs"]`) lists open PRs across every
// tracked marketplace repo AND each of its plugins' repos, so it is far more
// expensive than a per-PR status check. Refresh it at most once per minute.
// Invalidation only triggers a network refetch when the tracking view
// (Dashboard / Admin) is actually mounted, so it is free while you're elsewhere.
const TRACKED_PRS_MIN_MS = 60_000;

/**
 * Reacts to PR status transitions detected by the Rust poller
 * (`src-tauri/src/pr_poller.rs`), and keeps the marketplace PR tracking warm
 * while a view that shows it is mounted.
 *
 * The polling loop itself used to live here, as a `setInterval` issuing one
 * network call per open PR. That forced the webview to stay resident in the
 * tray purely to keep the timer alive — the single most expensive thing the app
 * did at rest. The loop now runs in Rust and this hook only listens:
 *
 * - `pr-status-changed` → refresh the dependent queries and raise the in-app
 *   toast. The backend raises the *native* toast instead whenever no window was
 *   visible to show this one, so the two never double up.
 * - a slow timer, alive only while a window is, nudges `["tracked-prs"]`.
 */
export function usePrPolling() {
  const qc = useQueryClient();
  const push = useNotifications((s) => s.push);

  // React to transitions found by the Rust poller.
  useEffect(() => {
    const un = listen<PrStatusChange>("pr-status-changed", (e) => {
      const { repo, number, title, status } = e.payload;
      log.info(`PR #${number} ${repo} → ${status}`);
      // `native: false` on purpose: the backend already decided whether a
      // Windows toast was warranted (it fires one only when no window was
      // visible). Letting the store fall back to its `windowHidden` heuristic
      // would raise a second toast for the same event.
      push(
        {
          kind: status === "merged" ? "success" : "info",
          title: `PR #${number} ${status}`,
          body: `${repo} — ${title}`,
        },
        { native: false }
      );
      qc.invalidateQueries({ queryKey: ["pr-history"] });
      qc.invalidateQueries({ queryKey: ["pending-prs"] });
      qc.invalidateQueries({ queryKey: ["remote-skills"] });
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [qc, push]);

  // Keep the marketplace PR tracking fresh while the dashboard/admin view is
  // open. Invalidate-only: with no such view mounted this costs nothing, and
  // the timer dies with the window when the UI is released to tray.
  const lastTrackedRef = useRef<number>(0);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastTrackedRef.current < TRACKED_PRS_MIN_MS) return;
      lastTrackedRef.current = Date.now();
      qc.invalidateQueries({ queryKey: ["tracked-prs"] });
    };
    const handle = window.setInterval(tick, TRACKED_PRS_MIN_MS);
    return () => window.clearInterval(handle);
  }, [qc]);
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRight,
  DownloadCloud,
  GitBranch,
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import { useOrgSync } from "@/stores/orgSync";
import { useNotifications } from "@/stores/notifications";
import type {
  OrgSyncStatus,
  RepoComparison,
  RepoOutcome,
  SyncProgress,
} from "@/lib/types";

const log = createLogger("org-sync");

/** Statuses a rapatriement can actually act on. */
const ACTIONABLE: OrgSyncStatus[] = ["behind", "new"];

const STATUS_LABEL: Record<OrgSyncStatus, string> = {
  upToDate: "à jour",
  behind: "en retard",
  new: "nouveau",
  diverged: "divergé",
  empty: "vide",
  error: "erreur",
};

const STATUS_VARIANT: Record<
  OrgSyncStatus,
  "success" | "warning" | "destructive" | "secondary" | "outline"
> = {
  upToDate: "success",
  behind: "warning",
  new: "outline",
  diverged: "destructive",
  empty: "secondary",
  error: "destructive",
};

/**
 * Progress readout for a running rapatriement.
 *
 * Deliberately not `UpdateProgressBar`: that one is documented as the single
 * rendering of the self-update's installing state and is shaped around bytes
 * and download phases. Bending it to carry commits and files would give two
 * callers with incompatible needs one component again — the drift its comment
 * warns about.
 *
 * The bar tracks **files within the current commit** whenever there are any:
 * an incremental sync usually replays a single commit, so a commit counter
 * alone would sit at 0/1 for the whole run.
 */
function SyncProgressBar({ progress }: { progress: SyncProgress }) {
  const useSteps = progress.stepTotal > 0;
  const done = useSteps ? progress.step : progress.done;
  const total = useSteps ? progress.stepTotal : progress.total;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;

  const where = [
    progress.repo,
    progress.total > 1 ? `commit ${progress.done + 1}/${progress.total}` : null,
    useSteps ? `fichier ${progress.step + 1}/${progress.stepTotal}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="shrink-0 font-medium">{where}</span>
        {progress.detail && (
          <span className="truncate text-muted-foreground">{progress.detail}</span>
        )}
        {pct !== null && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            {pct} %
          </span>
        )}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-primary/20"
        role="progressbar"
        aria-label="Progression du rapatriement"
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={pct === null ? "Progression inconnue" : `${pct} %`}
      >
        <div
          className={
            pct === null
              ? "h-full w-1/3 animate-pulse rounded-full bg-primary"
              : "h-full rounded-full bg-primary transition-[width] duration-200"
          }
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StatusBadge({ row }: { row: RepoComparison }) {
  const label =
    row.status === "behind" || row.status === "new"
      ? `${STATUS_LABEL[row.status]} · ${row.pending}`
      : STATUS_LABEL[row.status];
  return (
    <Badge variant={STATUS_VARIANT[row.status]} className="shrink-0 text-[10px]">
      {label}
    </Badge>
  );
}

/**
 * Hidden comparison between the Gitea `Claude` organisation and the GitHub
 * `sforge-labs` one, reached only by typing `sforge-labs` in the command
 * palette.
 *
 * The comparison is read-only; the rapatriement replays the missing Gitea
 * commits onto GitHub with the same rewrite rules the initial migration used
 * (`acx-cl` → `cl`, forge references repointed). A repository whose GitHub HEAD
 * did not come from the mirror is reported `divergé` and cannot be selected —
 * replaying on top of it would bury whatever landed there.
 */
export function OrgSyncDialog() {
  const open = useOrgSync((s) => s.open);
  const setOpen = useOrgSync((s) => s.setOpen);
  const notify = useNotifications((s) => s.push);

  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [outcomes, setOutcomes] = useState<RepoOutcome[] | null>(null);

  const q = useQuery({
    queryKey: ["org-sync-compare"],
    queryFn: api.orgSyncCompare,
    enabled: open,
    // Every run costs a walk over both organisations; the user refreshes
    // explicitly when they want a newer answer.
    staleTime: 5 * 60 * 1000,
  });
  const { refetch } = q;

  const repos = useMemo(() => q.data?.repos ?? [], [q.data]);
  const actionable = useMemo(
    () => repos.filter((r) => ACTIONABLE.includes(r.status)),
    [repos]
  );

  // Seed the ticks from each fresh comparison. Outcomes are deliberately *not*
  // cleared here: a run refetches when it finishes, and clearing on the new data
  // would wipe the report the user just asked for a frame after showing it.
  useEffect(() => {
    setSelected(actionable.map((r) => r.source));
  }, [actionable]);

  // A newly opened dialog starts from a clean slate instead of the last run's.
  useEffect(() => {
    if (!open) {
      setOutcomes(null);
      setProgress(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const unlisten = listen<SyncProgress>("org-sync-progress", (e) =>
      setProgress(e.payload)
    );
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [open]);

  const toggle = useCallback((source: string) => {
    setSelected((prev) =>
      prev.includes(source)
        ? prev.filter((s) => s !== source)
        : [...prev, source]
    );
  }, []);

  // Cancellation is cooperative: Rust stops at its next checkpoint, so the
  // in-flight request still has to finish. The button stays disabled meanwhile
  // rather than pretending the run ended.
  const cancel = useCallback(async () => {
    setCancelling(true);
    try {
      await api.orgSyncCancel();
      log.info("annulation demandée");
    } catch (e) {
      log.error("annulation impossible", e);
    }
  }, []);

  const run = useCallback(async () => {
    if (selected.length === 0) return;
    setRunning(true);
    setCancelling(false);
    setOutcomes(null);
    setProgress(null);
    try {
      const res = await api.orgSyncPull(selected);
      setOutcomes(res);
      const failed = res.filter((r) => r.status === "error");
      const done = res.filter(
        (r) => r.status === "synced" || r.status === "created"
      );
      const stopped = res.filter((r) => r.status === "cancelled");
      const commits = done.reduce((n, r) => n + r.replayed, 0);
      if (stopped.length > 0) {
        notify({
          kind: "warning",
          title: "Rapatriement annulé",
          body: `${done.length} dépôt(s) rapatrié(s) avant l'arrêt, ${stopped.length} non traité(s).`,
        });
      } else if (failed.length > 0) {
        notify({
          kind: "error",
          title: "Synchronisation incomplète",
          body: `${failed.length} dépôt(s) en échec, ${done.length} rapatrié(s).`,
        });
      } else {
        notify({
          kind: "success",
          title: "Synchronisation terminée",
          body: `${done.length} dépôt(s) rapatrié(s), ${commits} commit(s) rejoué(s).`,
        });
      }
      log.info("org sync terminé", res);
      await refetch();
    } catch (e) {
      log.error("org sync a échoué", e);
      notify({
        kind: "error",
        title: "Synchronisation impossible",
        body: String(e),
      });
    } finally {
      setRunning(false);
      setCancelling(false);
      setProgress(null);
    }
  }, [selected, notify, refetch]);

  const outcomeFor = useCallback(
    (source: string) => outcomes?.find((o) => o.source === source),
    [outcomes]
  );

  const pendingTotal = actionable
    .filter((r) => selected.includes(r.source))
    .reduce((n, r) => n + r.pending, 0);

  return (
    <Dialog open={open} onOpenChange={running ? () => {} : setOpen}>
      <DialogContent className="max-w-3xl gap-0 p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-primary" />
            Synchronisation {q.data?.giteaOrg ?? "Claude"} →{" "}
            {q.data?.githubOrg ?? "sforge-labs"}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto mr-6 h-7 px-2 text-xs"
              onClick={() => q.refetch()}
              disabled={q.isFetching || running}
            >
              <RefreshCw
                className={cn("mr-1 h-3 w-3", q.isFetching && "animate-spin")}
              />
              Comparer
            </Button>
          </DialogTitle>
          <DialogDescription>
            Les commits présents sur le Gitea interne et absents de GitHub sont
            rejoués un par un, en appliquant les règles de l'import initial :{" "}
            <code>acx-cl</code> devient <code>cl</code> et les références de
            forge pointent vers GitHub.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="px-6 py-4">
            {q.isPending && (
              <p className="text-sm text-muted-foreground">Comparaison en cours…</p>
            )}
            {q.isError && (
              <p className="text-sm text-red-600 dark:text-red-400">
                Comparaison impossible : {String(q.error)}
              </p>
            )}
            {!q.isPending && !q.isError && repos.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Aucun dépôt dans l'organisation Gitea.
              </p>
            )}

            <div className="space-y-1">
              {repos.map((row) => {
                const canAct = ACTIONABLE.includes(row.status);
                const outcome = outcomeFor(row.source);
                return (
                  <div
                    key={row.source}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                      canAct ? "hover:bg-accent/50" : "opacity-70"
                    )}
                  >
                    <Checkbox
                      checked={selected.includes(row.source)}
                      onChange={() => toggle(row.source)}
                      disabled={!canAct || running}
                      aria-label={`Rapatrier ${row.source}`}
                    />
                    <span className="truncate font-mono text-xs">{row.source}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {row.target}
                    </span>
                    <StatusBadge row={row} />
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {outcome ? outcome.detail : row.detail}
                    </span>
                  </div>
                );
              })}
            </div>

            {(q.data?.orphans.length ?? 0) > 0 && (
              <p className="mt-4 text-xs text-muted-foreground">
                Présents sur GitHub sans équivalent Gitea, laissés intacts :{" "}
                {q.data?.orphans.join(", ")}
              </p>
            )}
          </div>
        </ScrollArea>

        <div className="flex items-center gap-3 border-t px-6 py-3">
          {running ? (
            <>
              {progress ? (
                <SyncProgressBar progress={progress} />
              ) : (
                // The command is away but no tick has landed yet: say so rather
                // than render a bar pinned at 0 %, which reads as "stuck".
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  Préparation…
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-8 shrink-0"
                onClick={cancel}
                disabled={cancelling}
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                {cancelling ? "Annulation…" : "Annuler"}
              </Button>
            </>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">
                {selected.length} dépôt(s) sélectionné(s), {pendingTotal}{" "}
                commit(s) à rejouer.
              </span>
              <Button
                size="sm"
                className="ml-auto h-8"
                onClick={run}
                disabled={selected.length === 0}
              >
                <DownloadCloud className="mr-1.5 h-3.5 w-3.5" />
                Rapatrier
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Traçabilité → Activité récente.
//
// The dashboard's card shows the five most recent events; this is the same
// list, unabridged, with absolute timestamps and filters. Both read the log
// file through `lib/activity.ts`, so neither can label an event differently
// from the other.
//
// "Vider l'historique" purges the log files, and the confirmation says so in
// as many words. There is no separate activity store to clear — the log *is*
// the history, which is what makes it match the file a user attaches to a bug
// report, and it is also why emptying it throws away more than these rows.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, History, Search, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { cn, openExternal } from "@/lib/utils";
import { useNotifications } from "@/stores/notifications";
import {
  ACTIVITY_ICONS,
  ACTIVITY_OK_COLORS,
  parseActivity,
  type ActivityEvent,
  type ActivityKind,
} from "@/lib/activity";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The dashboard reads 128 kB; this page is the one that has to reach back, so
 *  it takes the whole current file (2 MB is well past any day we produce). */
const READ_BYTES = 2 * 1024 * 1024;

const KIND_LABELS: Record<ActivityKind, string> = {
  install: "Plugins installés",
  uninstall: "Plugins désinstallés",
  "install-mp": "Marketplaces installées",
  "uninstall-mp": "Marketplaces supprimées",
  pr: "Pull Requests",
  export: "Exports",
  "app-update": "Mises à jour de l'app",
};

const ALL_KINDS = Object.keys(KIND_LABELS) as ActivityKind[];

function stamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function Row({ ev }: { ev: ActivityEvent }) {
  const Icon = ACTIVITY_ICONS[ev.kind];
  const isError = ev.level === "error";
  const clickable = !!ev.url;
  return (
    <li
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => openExternal(ev.url!) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openExternal(ev.url!);
              }
            }
          : undefined
      }
      className={cn(
        "flex items-center gap-3 border-b px-4 py-2 text-sm last:border-b-0",
        clickable &&
          "cursor-pointer transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      )}
    >
      <span className="w-40 shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground">
        {stamp(ev.timestamp)}
      </span>
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          isError ? "text-destructive" : ACTIVITY_OK_COLORS[ev.kind]
        )}
      />
      <span
        className={cn("w-56 shrink-0 font-medium", isError && "text-destructive")}
      >
        {ev.message}
      </span>
      <Badge
        variant={isError ? "destructive" : "success"}
        className="shrink-0 px-1.5 py-0 text-xs"
      >
        {isError ? "échec" : "ok"}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={ev.detail}>
        {ev.detail}
      </span>
    </li>
  );
}

export function ActivityPage() {
  const qc = useQueryClient();
  const push = useNotifications((s) => s.push);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<ActivityKind>>(new Set());
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const log = useQuery({
    queryKey: ["activity-log"],
    queryFn: () => api.loggingReadFile("", READ_BYTES),
    staleTime: 15_000,
  });

  const events = useMemo(
    () => parseActivity(log.data ?? ""),
    [log.data]
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((ev) => {
      if (errorsOnly && ev.level !== "error") return false;
      if (kinds.size > 0 && !kinds.has(ev.kind)) return false;
      if (q && !`${ev.message} ${ev.detail}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [events, query, kinds, errorsOnly]);

  const purge = useMutation({
    mutationFn: api.loggingPurge,
    onSuccess: (removed) => {
      setConfirming(false);
      // The rows come from the log, so both this page and the dashboard's card
      // have to re-read it.
      qc.invalidateQueries({ queryKey: ["activity-log"] });
      qc.invalidateQueries({ queryKey: ["log-tail"] });
      qc.invalidateQueries({ queryKey: ["log-files"] });
      push({
        kind: "success",
        title: "Historique vidé",
        body: `${removed} fichier(s) de log effacé(s).`,
      });
    },
    onError: (e) =>
      push({ kind: "error", title: "Échec du vidage", body: errMsg(e) }),
  });

  const toggleKind = (k: ActivityKind) =>
    setKinds((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <History className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="shrink-0 text-sm font-semibold">Activité récente</h2>
        <Badge variant="outline" className="shrink-0">
          {shown.length}
          {shown.length !== events.length && ` / ${events.length}`}
        </Badge>

        <div className="relative ml-auto w-64">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Rechercher…"
            className="h-8 pl-9 text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant={errorsOnly ? "default" : "outline"}
          className="h-8 shrink-0 px-2 text-xs"
          onClick={() => setErrorsOnly((v) => !v)}
          title="N'afficher que les échecs"
        >
          <AlertTriangle className="mr-1 h-3 w-3" />
          Échecs
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 px-2 text-xs"
          onClick={() => setConfirming(true)}
          disabled={purge.isPending || events.length === 0}
        >
          <Trash2 className="mr-1 h-3 w-3" />
          Vider l'historique
        </Button>
      </div>

      {/* Kind filter: chips rather than a select, since picking two of seven is
          the normal case. */}
      <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
        {ALL_KINDS.map((k) => {
          const Icon = ACTIVITY_ICONS[k];
          const on = kinds.has(k);
          const count = events.filter((e) => e.kind === k).length;
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors",
                on
                  ? "border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent"
              )}
            >
              <Icon className="h-3 w-3" />
              {KIND_LABELS[k]}
              <span className="opacity-60">{count}</span>
            </button>
          );
        })}
        {kinds.size > 0 && (
          <button
            type="button"
            onClick={() => setKinds(new Set())}
            className="px-2 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            tout afficher
          </button>
        )}
      </div>

      {confirming && (
        <div className="flex flex-wrap items-center gap-3 border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">
            L'historique est reconstruit depuis les fichiers de log : le vider
            <strong> efface aussi les logs</strong>, y compris ce qu'un rapport
            de bug aurait utilisé. Continuer ?
          </span>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => purge.mutate()}
            disabled={purge.isPending}
          >
            Vider
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => setConfirming(false)}
          >
            Annuler
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Card>
          <CardContent className="p-0">
            {log.isLoading ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                Chargement…
              </p>
            ) : shown.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                {events.length === 0
                  ? "Aucun événement enregistré."
                  : "Aucun événement ne correspond aux filtres."}
              </p>
            ) : (
              <ul>
                {shown.map((ev, i) => (
                  <Row key={`${ev.timestamp}-${i}`} ev={ev} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

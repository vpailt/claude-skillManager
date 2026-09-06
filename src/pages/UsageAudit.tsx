// Audit d'utilisation — reconstruit l'usage réel de Claude Code à partir des
// transcripts de session (~/.claude/projects/**/*.jsonl), toutes sessions et
// tous projets confondus. Trois sections partagent le même filtre de dates
// (défaut : J-30 → aujourd'hui) : top 3 des plugins, plugins installés non
// utilisés, détail des skills (nb d'utilisations + projets). Un bouton exporte
// le tout en .xlsx multi-onglets.
import { useMemo, useState } from "react";
import {
  BarChart3,
  Bot,
  CalendarRange,
  Download,
  FolderGit2,
  Loader2,
  PackageX,
  Sparkles,
  Terminal,
  Trophy,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScrollFade } from "@/components/ScrollFade";
import { StatTile } from "@/components/StatTile";
import { TH, TH_ROW } from "@/lib/tableStyles";
import { api } from "@/lib/api";
import { withTask } from "@/stores/progress";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/stores/notifications";
import type { PluginUsage } from "@/lib/types";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const DAY_MS = 86_400_000;

/** `yyyy-mm-dd` in the user's LOCAL timezone — matches what `<input type=date>`
 *  shows and how the backend buckets usage days (also local). */
function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local calendar day → the UTC instant of its local start-of-day / end-of-day,
 *  so the backend's absolute-time filter matches the day the user picked. */
function dayToIso(day: string, endOfDay: boolean): string {
  if (!day) return "";
  // No trailing 'Z' → parsed in the local timezone, not UTC.
  const suffix = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
  const d = new Date(day + suffix);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

const RANK_STYLES = [
  "border-amber-400/50 bg-amber-400/5",
  "border-slate-400/40 bg-slate-400/5",
  "border-orange-500/40 bg-orange-500/5",
];

function TopPluginCard({ rank, p }: { rank: number; p: PluginUsage }) {
  return (
    <Card className={RANK_STYLES[rank] ?? ""}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-bold text-primary">
            {rank + 1}
          </div>
          <CardTitle className="min-w-0 truncate text-base" title={p.plugin}>
            {p.plugin}
          </CardTitle>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          {p.marketplace && <span className="truncate">{p.marketplace}</span>}
          {!p.installed && (
            <Badge variant="outline" className="text-amber-500">
              non installé
            </Badge>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{p.total}</div>
        <div className="text-xs text-muted-foreground">invocations</div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Sparkles className="h-3 w-3" />
            {p.skillCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <Bot className="h-3 w-3" />
            {p.agentCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <Terminal className="h-3 w-3" />
            {p.commandCount}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function UsageAuditPage() {
  const push = useNotifications((s) => s.push);
  const qc = useQueryClient();

  // Défauts : J-30 → aujourd'hui.
  const [fromDay, setFromDay] = useState(() =>
    isoDay(new Date(Date.now() - 30 * DAY_MS))
  );
  const [toDay, setToDay] = useState(() => isoDay(new Date()));

  const fromIso = useMemo(() => dayToIso(fromDay, false), [fromDay]);
  const toIso = useMemo(() => dayToIso(toDay, true), [toDay]);

  const report = useQuery({
    queryKey: ["usage-audit", fromIso, toIso],
    queryFn: () => api.usageAudit(fromIso, toIso),
    staleTime: 5_000,
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const path = await saveDialog({
        title: "Exporter l'audit d'utilisation",
        defaultPath: `audit-utilisation_${fromDay}_${toDay}.xlsx`,
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (!path) return null;
      // The task opens *after* the save dialog, not around it: the dialog is
      // modal and waits on the user, and a progress line ticking while someone
      // picks a folder says the app is busy when it is not.
      return withTask(
        {
          kind: "audit",
          label: "Export de l'audit",
          detail: path.split(/[\\/]/).pop() ?? "",
        },
        () => api.usageExportXlsx(path, fromIso, toIso)
      );
    },
    onSuccess: (path) => {
      if (!path) return;
      // The export writes a "usage_audit.export ok:" log line — refresh the
      // dashboard's "Activité récente" so it shows up.
      qc.invalidateQueries({ queryKey: ["log-tail"] });
      push({
        kind: "success",
        title: "Audit exporté",
        body: path,
        // Click the toast to open the .xlsx in its default app (Excel).
        onClick: () => {
          api.openInShell(path).catch(() => {});
        },
      });
    },
    onError: (e) =>
      push({ kind: "error", title: "Échec de l'export", body: errMsg(e) }),
  });

  const data = report.data;
  const top3 = data?.topPlugins.slice(0, 3) ?? [];

  return (
    <div className="panel flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header — the same bar the Logs page's tabs sit on: name, counts, and
          the one action, on one line. The filters take the second row, as they
          do there, rather than standing the title block on end. */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="shrink-0 text-sm font-semibold">Audit d'utilisation</h2>
        {data && (
          <Badge variant="outline" className="shrink-0">
            {data.skills.length} skill{data.skills.length > 1 ? "s" : ""} ·{" "}
            {data.totalEvents} invocation{data.totalEvents > 1 ? "s" : ""}
          </Badge>
        )}
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          Usage réel reconstruit depuis les transcripts de session, tous projets
          confondus.
        </span>
        <Button
          size="sm"
          className="ml-auto h-8 shrink-0 px-2 text-xs"
          onClick={() => exportMutation.mutate()}
          disabled={exportMutation.isPending || !data}
          title="Télécharger le récapitulatif au format Excel (.xlsx)"
        >
          {exportMutation.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Download className="mr-1 h-3 w-3" />
          )}
          Export Excel
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <CalendarRange className="h-4 w-4 shrink-0 text-muted-foreground" />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Du
          <Input
            type="date"
            value={fromDay}
            max={toDay}
            onChange={(e) => setFromDay(e.target.value)}
            className="h-8 w-[9.5rem] text-xs"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          au
          <Input
            type="date"
            value={toDay}
            min={fromDay}
            onChange={(e) => setToDay(e.target.value)}
            className="h-8 w-[9.5rem] text-xs"
          />
        </label>
      </div>

      {/* Body */}
      <ScrollFade className="flex-1" wraps>
        <ScrollArea className="h-full">
        <div className="space-y-6 px-6 py-5">
          {report.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Analyse des transcripts…
            </div>
          )}
          {report.isError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Échec de l'audit : {errMsg(report.error)}
            </div>
          )}

          {data && (
            <>
              {/* Counters first, like the Logs page's API tab: the totals are
                  the answer to "how much was used", and they were a line of
                  small grey text under the filters. */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatTile
                  label="Invocations"
                  value={data.totalEvents}
                  hint="sur la période"
                />
                <StatTile
                  label="Skills invoqués"
                  value={data.skills.length}
                  tone="muted"
                />
                <StatTile
                  label="Plugins utilisés"
                  value={data.topPlugins.length}
                  tone="muted"
                />
                <StatTile
                  label="Plugins jamais utilisés"
                  value={data.unusedPlugins.length}
                  tone={data.unusedPlugins.length > 0 ? "danger" : "muted"}
                  hint="installés, non invoqués"
                />
              </div>
              <p className="text-[11px] text-muted-foreground/70">
                Reconstruit depuis les transcripts de session locaux — rien ne
                sort de la machine.
              </p>

              {/* 1. Top 3 plugins */}
              <section className="space-y-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <Trophy className="h-4 w-4" />
                  Top 3 des plugins utilisés
                </h2>
                {top3.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Aucune invocation de plugin sur la période.
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {top3.map((p, i) => (
                      <TopPluginCard key={p.plugin} rank={i} p={p} />
                    ))}
                  </div>
                )}
              </section>

              {/* 2. Plugins installés non utilisés */}
              <section className="space-y-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <PackageX className="h-4 w-4" />
                  Plugins installés non utilisés
                </h2>
                {data.unusedPlugins.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Tous les plugins installés ont été utilisés sur la période.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {data.unusedPlugins.map((p) => (
                      <Badge key={p} variant="secondary" className="text-sm">
                        {p}
                      </Badge>
                    ))}
                  </div>
                )}
              </section>

              {/* 3. Détail des skills */}
              <section className="space-y-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <Sparkles className="h-4 w-4" />
                  Détail des skills ({data.skills.length})
                </h2>
                {data.skills.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Aucun skill invoqué sur la période.
                  </p>
                ) : (
                  // Same table as Logs and Activité récente — shared header
                  // style, sticky, no Card around it: three pages listing rows
                  // read from disk should not each invent their own.
                  <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm">
                        <thead className={TH_ROW}>
                          <tr>
                            <th className={TH}>Skill</th>
                            <th className={cn(TH, "w-32 text-right")}>
                              Utilisations
                            </th>
                            <th className={cn(TH, "w-1/2")}>Projets</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.skills.map((s) => (
                            <tr
                              key={s.skill}
                              className="border-b border-border/40 align-top hover:bg-accent/40"
                            >
                              <td className="px-3 py-1.5">
                                <div className="font-medium">{s.skill}</div>
                                {s.plugin && (
                                  <div className="text-xs text-muted-foreground">
                                    {s.plugin}
                                  </div>
                                )}
                              </td>
                              <td className="px-2 py-1.5 text-right tabular-nums">
                                {s.count}
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex flex-wrap gap-1.5">
                                  {s.projects.map((proj) => {
                                    const openable = !!proj.path;
                                    const datesLabel = proj.dates.length
                                      ? `Utilisé le ${proj.dates
                                          .map((d) =>
                                            d.count > 1
                                              ? `${d.date} (${d.count})`
                                              : d.date
                                          )
                                          .join(", ")}`
                                      : "";
                                    const title = openable
                                      ? `Ouvrir ${proj.path} dans VS Code${
                                          datesLabel ? ` · ${datesLabel}` : ""
                                        }`
                                      : datesLabel ||
                                        "Chemin du projet indisponible";
                                    return (
                                      <button
                                        key={proj.project}
                                        type="button"
                                        disabled={!openable}
                                        title={title}
                                        onClick={() => {
                                          if (openable)
                                            api
                                              .openInVsCode(proj.path)
                                              .catch((e) =>
                                                push({
                                                  kind: "error",
                                                  title:
                                                    "Impossible d'ouvrir VS Code",
                                                  body: errMsg(e),
                                                })
                                              );
                                        }}
                                        className={cn(
                                          "inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground",
                                          openable
                                            ? "transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                            : "cursor-default opacity-70"
                                        )}
                                      >
                                        <FolderGit2 className="h-3 w-3" />
                                        {proj.project}
                                        <span className="tabular-nums opacity-60">
                                          ·{proj.count}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                )}
              </section>

              <p className="pt-2 text-xs text-muted-foreground/70">
                La mesure reflète l'usage actif (invocations explicites de
                skills, agents et commandes). Un plugin agissant uniquement par
                contexte injecté peut apparaître peu ou pas utilisé.
              </p>
            </>
          )}
        </div>
        </ScrollArea>
      </ScrollFade>
    </div>
  );
}

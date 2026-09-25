// Consommation de tokens — second onglet de l'Audit d'utilisation.
//
// Lit ~/.claude/usage/usage.db, alimentée par le hook SessionEnd
// `token-usage.py`. L'app n'écrit jamais dans la base : quand il faut la créer
// (première ouverture) ou la mettre à jour (« Actualiser »), elle lance le même
// script que le hook. Vues par projet et par session, limites
// atteintes, et deux exports (HTML charte AlmaviaCX, Excel).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CalendarRange,
  Coins,
  FileCode2,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScrollFade } from "@/components/ScrollFade";
import { StatTile } from "@/components/StatTile";
import { api } from "@/lib/api";
import { PAGE_HEADER } from "@/lib/headerStyles";
import { TH, TH_ROW } from "@/lib/tableStyles";
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/stores/notifications";
import { useProgress, withTask } from "@/stores/progress";
import type {
  HookStatus,
  IngestProgress,
  TokenBucket,
  TokenReport,
  TokenUsageStatus,
} from "@/lib/types";

const log = createLogger("token-usage");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const DAY_MS = 86_400_000;
const PROGRESS_EVENT = "token-usage-progress";

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Same compact notation as the exported reports: 1.2k, 3.4M, 1.05G. */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

const fmtInt = (n: number) => n.toLocaleString("fr-FR");
const weight = (b: TokenBucket) => b.output + b.cacheWrite;

const PRESETS = [
  { id: "7", label: "7 j", days: 7 },
  { id: "30", label: "30 j", days: 30 },
  { id: "90", label: "90 j", days: 90 },
  { id: "all", label: "Tout", days: null },
] as const;

// No month / week / day views: the period filter above already narrows the
// range, and those tables only re-sliced it.
type View = "projects" | "sessions" | "limits";

const VIEWS: { id: View; label: string }[] = [
  { id: "projects", label: "Projets" },
  { id: "sessions", label: "Sessions" },
  { id: "limits", label: "Limites" },
];

function Pills<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: { id: T; label: ReactNode }[];
  value: T | null;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex shrink-0 items-center gap-1">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            value === it.id
              ? "bg-primary/10 font-medium text-primary"
              : "text-muted-foreground hover:bg-accent"
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ hook banner

function HookBanner({
  hook,
  installing,
  onInstall,
}: {
  hook: HookStatus;
  installing: boolean;
  onInstall: () => void;
}) {
  if (hook.state === "installed") return null;

  const noPython = !hook.pythonFound && !hook.python;
  const texts: Record<Exclude<HookStatus["state"], "installed">, [string, string, string]> = {
    missing: [
      "Hook token-usage absent",
      "Sans lui, la base n'est pas alimentée à la fin des sessions Claude Code.",
      "Installer le hook",
    ],
    legacy: [
      "Hook token-usage à mettre à jour",
      "Le script actuel n'est pas la version gérée par SkillManager : il régénère encore ses propres rapports à chaque fin de session. Il sera sauvegardé (.bak) avant d'être remplacé par la version qui alimente uniquement usage.db.",
      "Remplacer par la version allégée",
    ],
    broken: [
      "Hook token-usage cassé",
      hook.detail ?? "L'interpréteur ou le script enregistré est introuvable.",
      "Réparer",
    ],
  };
  const [title, body, action] = texts[hook.state];

  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="font-medium">{title}</div>
        <p className="text-xs text-muted-foreground">{body}</p>
        {noPython ? (
          <p className="text-xs text-destructive">
            Python est introuvable sur ce poste (PATH, %LOCALAPPDATA%\Programs\Python,
            py.exe) : installez-le pour activer le hook.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground/80">
            Interpréteur : <span className="font-mono">{hook.python ?? hook.pythonFound}</span>
          </p>
        )}
      </div>
      <Button
        size="sm"
        className="h-8 shrink-0 px-2 text-xs"
        disabled={installing || noPython}
        onClick={onInstall}
      >
        {installing ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Wrench className="mr-1 h-3 w-3" />
        )}
        {action}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ tables

function WeightBar({ value, peak }: { value: number; peak: number }) {
  const pct = peak > 0 ? Math.round((100 * value) / peak) : 0;
  return (
    <div className="relative min-w-[7rem]">
      <div
        aria-hidden
        className="absolute inset-y-0.5 left-0 rounded-sm bg-primary/20"
        style={{ width: `${pct}%` }}
      />
      <span className="relative px-1 font-medium tabular-nums">{fmtTokens(value)}</span>
    </div>
  );
}

const NUM = "px-2 py-1.5 text-right tabular-nums";

function UsageTable({
  view,
  rows,
}: {
  view: Exclude<View, "limits">;
  rows: TokenBucket[];
}) {
  const peak = rows.reduce((m, b) => Math.max(m, weight(b)), 0);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucune consommation sur la période.</p>;
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className={cn(TH_ROW, "bg-card")}>
            <tr>
              {view === "sessions" && (
                <>
                  <th className={TH}>Début</th>
                  <th className={cn(TH, "text-right")}>Durée</th>
                </>
              )}
              <th className={TH}>Projet</th>
              {view === "sessions" && <th className={TH}>Première demande</th>}
              <th className={cn(TH, "text-right")}>Appels</th>
              <th className={cn(TH, "text-right")}>Input</th>
              <th className={cn(TH, "text-right")}>Output</th>
              <th className={cn(TH, "text-right")}>Cache écrit</th>
              <th className={cn(TH, "text-right")}>Cache lu</th>
              <th className={TH} title="Le repère retenu pour comparer projets et périodes">
                Output + cache écrit
              </th>
              <th className={cn(TH, "text-right")}>Limites</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr
                key={`${b.period}|${b.label}`}
                className={cn(
                  "border-b border-border/40 align-top hover:bg-accent/40",
                  b.limits > 0 && "bg-destructive/5"
                )}
              >
                {view === "sessions" && (
                  <>
                    <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{b.start}</td>
                    <td className={NUM}>{b.durationMin} min</td>
                  </>
                )}
                <td className="whitespace-nowrap px-3 py-1.5 font-medium">{b.label}</td>
                {view === "sessions" && (
                  <td
                    className="max-w-[24rem] truncate px-2 py-1.5 text-muted-foreground"
                    title={b.title}
                  >
                    {b.title}
                  </td>
                )}
                <td className={NUM}>{fmtInt(b.calls)}</td>
                <td className={NUM}>{fmtTokens(b.input)}</td>
                <td className={NUM}>{fmtTokens(b.output)}</td>
                <td className={NUM}>{fmtTokens(b.cacheWrite)}</td>
                <td className={NUM}>{fmtTokens(b.cacheRead)}</td>
                <td className="px-2 py-1.5">
                  <WeightBar value={weight(b)} peak={peak} />
                </td>
                <td className={cn(NUM, b.limits > 0 && "font-medium text-destructive")}>
                  {b.limits || ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function LimitsTable({ report }: { report: TokenReport }) {
  if (report.limits.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucune limite d'usage atteinte sur la période.
      </p>
    );
  }
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className={cn(TH_ROW, "bg-card")}>
            <tr>
              <th className={TH}>Quand</th>
              <th className={TH}>Projet</th>
              <th className={TH}>Session</th>
              <th className={TH}>Message</th>
            </tr>
          </thead>
          <tbody>
            {report.limits.map((l, i) => (
              <tr
                key={`${l.at}|${l.label}|${i}`}
                className="border-b border-border/40 align-top hover:bg-accent/40"
              >
                <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{l.at}</td>
                <td className="whitespace-nowrap px-3 py-1.5 font-medium">{l.label}</td>
                <td className="max-w-[18rem] truncate px-2 py-1.5 text-muted-foreground" title={l.title}>
                  {l.title}
                </td>
                <td className="px-2 py-1.5 text-muted-foreground">{l.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ the tab

export function TokenUsageTab({ tabs }: { tabs: ReactNode }) {
  const push = useNotifications((s) => s.push);
  const qc = useQueryClient();

  const [preset, setPreset] = useState<string | null>("30");
  const [fromDay, setFromDay] = useState(() => isoDay(new Date(Date.now() - 29 * DAY_MS)));
  const [toDay, setToDay] = useState(() => isoDay(new Date()));
  const [project, setProject] = useState("");
  const [view, setView] = useState<View>("projects");
  const [progress, setProgress] = useState<IngestProgress | null>(null);

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPreset(id);
    setToDay(p.days === null ? "" : isoDay(new Date()));
    setFromDay(p.days === null ? "" : isoDay(new Date(Date.now() - (p.days - 1) * DAY_MS)));
  };

  const status = useQuery({
    queryKey: ["token-usage", "status"],
    queryFn: api.tokenUsageStatus,
    staleTime: 5_000,
  });
  const dbReady = !!status.data?.dbExists && !status.data.dbError;

  const report = useQuery({
    queryKey: ["token-usage", "report", fromDay, toDay, project],
    queryFn: () => api.tokenUsageReport(fromDay, toDay, project),
    enabled: dbReady,
    staleTime: 5_000,
  });

  const installHook = useMutation({
    mutationFn: api.tokenHookInstall,
    onSuccess: (hook) => {
      log.info(`hook installed: ${hook.command ?? ""}`);
      push({ kind: "success", title: "Hook token-usage installé", body: hook.script ?? "" });
      qc.invalidateQueries({ queryKey: ["token-usage"] });
    },
    onError: (e) => push({ kind: "error", title: "Installation du hook impossible", body: errMsg(e) }),
  });

  const ingest = useMutation({
    mutationFn: async () => {
      const taskId = useProgress.getState().begin({
        kind: "audit",
        label: "Consommation de tokens",
        detail: "lecture des transcripts",
        pct: null,
      });
      const unlisten = await listen<IngestProgress>(PROGRESS_EVENT, (ev) => {
        setProgress(ev.payload);
        const { done, total } = ev.payload;
        useProgress.getState().update(taskId, {
          pct: total > 0 ? Math.round((100 * done) / total) : null,
          detail: `${done} / ${total} fichier(s)`,
        });
      });
      try {
        return await api.tokenUsageIngest();
      } finally {
        unlisten();
        useProgress.getState().end(taskId);
        setProgress(null);
      }
    },
    onSuccess: (files) => {
      log.info(`ingest ok: ${files} file(s)`);
      qc.invalidateQueries({ queryKey: ["token-usage"] });
    },
    onError: (e) => push({ kind: "error", title: "Génération de la base impossible", body: errMsg(e) }),
  });

  // First generation: the usage folder or the database is missing, and the hook
  // (whose script does the ingestion) is in place. Once per mount — a failure is
  // shown, not retried in a loop.
  const autoStarted = useRef(false);
  useEffect(() => {
    const s: TokenUsageStatus | undefined = status.data;
    if (!s || autoStarted.current || ingest.isPending) return;
    if (!s.dbExists && s.hook.state === "installed") {
      autoStarted.current = true;
      log.info("usage.db missing: starting first generation");
      ingest.mutate();
    }
  }, [status.data, ingest]);

  const exportFile = useMutation({
    mutationFn: async (kind: "html" | "xlsx") => {
      const suffix = [fromDay || "debut", toDay || "aujourdhui"].join("_");
      const path = await saveDialog({
        title:
          kind === "html"
            ? "Exporter le rapport de consommation (HTML)"
            : "Exporter la consommation (Excel)",
        defaultPath:
          kind === "html" ? `consommation-claude_${suffix}.html` : `consommation-claude_${suffix}.xlsx`,
        filters:
          kind === "html"
            ? [{ name: "Page HTML", extensions: ["html"] }]
            : [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (!path) return null;
      return withTask(
        { kind: "audit", label: "Export de la consommation", detail: path.split(/[\\/]/).pop() ?? "" },
        () =>
          kind === "html"
            ? api.tokenExportHtml(path, fromDay, toDay, project)
            : api.tokenExportXlsx(path, fromDay, toDay, project)
      );
    },
    onSuccess: (path) => {
      if (!path) return;
      qc.invalidateQueries({ queryKey: ["log-tail"] });
      push({
        kind: "success",
        title: "Consommation exportée",
        body: path,
        onClick: () => {
          api.openInShell(path).catch(() => {});
        },
      });
    },
    onError: (e) => push({ kind: "error", title: "Échec de l'export", body: errMsg(e) }),
  });

  const data = report.data;
  const hook = status.data?.hook;
  const canIngest = hook?.state === "installed" && !ingest.isPending;
  const rows = useMemo(() => {
    if (!data) return [];
    switch (view) {
      case "projects":
        return data.projects;
      case "sessions":
        return data.sessions;
      default:
        return [];
    }
  }, [data, view]);

  const viewItems = VIEWS.map((v) => ({
    id: v.id,
    label:
      v.id === "limits" && data && data.limits.length > 0 ? (
        <>
          {v.label}
          <span className="ml-1.5 tabular-nums text-destructive">{data.limits.length}</span>
        </>
      ) : (
        v.label
      ),
  }));

  return (
    <div className="panel flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className={PAGE_HEADER}>
        <Coins className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="shrink-0 text-sm font-semibold">Audit d'utilisation</h2>
        {tabs}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2 text-xs"
            disabled={!canIngest}
            onClick={() => ingest.mutate()}
            title={
              hook?.state === "installed"
                ? "Relire les transcripts modifiés depuis la dernière génération (inclut la session en cours)"
                : "Installez le hook token-usage pour pouvoir générer la base"
            }
          >
            <RefreshCw className={cn("mr-1 h-3 w-3", ingest.isPending && "animate-spin")} />
            Actualiser
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2 text-xs"
            disabled={!data || exportFile.isPending}
            onClick={() => exportFile.mutate("html")}
            title="Rapport HTML à la charte AlmaviaCX, sur la période et le projet affichés"
          >
            <FileCode2 className="mr-1 h-3 w-3" />
            HTML
          </Button>
          <Button
            size="sm"
            className="h-8 px-2 text-xs"
            disabled={!data || exportFile.isPending}
            onClick={() => exportFile.mutate("xlsx")}
            title="Classeur Excel (synthèses par formules, détail par appel), sur la période et le projet affichés"
          >
            <FileSpreadsheet className="mr-1 h-3 w-3" />
            Excel
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <CalendarRange className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Pills
          label="Période"
          items={PRESETS.map((p) => ({ id: p.id, label: p.label }))}
          value={preset}
          onChange={applyPreset}
        />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Du
          <Input
            type="date"
            value={fromDay}
            max={toDay || undefined}
            onChange={(e) => {
              setPreset(null);
              setFromDay(e.target.value);
            }}
            className="h-8 w-[9.5rem] text-xs"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          au
          <Input
            type="date"
            value={toDay}
            min={fromDay || undefined}
            onChange={(e) => {
              setPreset(null);
              setToDay(e.target.value);
            }}
            className="h-8 w-[9.5rem] text-xs"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Projet
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="h-8 max-w-[16rem] rounded-md border bg-background px-2 text-xs text-foreground"
          >
            <option value="">Tous les projets</option>
            {(data?.projectLabels ?? []).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ScrollFade className="flex-1" wraps>
        <ScrollArea className="h-full">
          <div className="space-y-5 px-6 py-5">
            {status.isError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                Lecture de l'état impossible : {errMsg(status.error)}
              </div>
            )}

            {hook && (
              <HookBanner
                hook={hook}
                installing={installHook.isPending}
                onInstall={() => installHook.mutate()}
              />
            )}

            {ingest.isPending && (
              <div className="space-y-1.5 rounded-md border px-4 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  {status.data?.dbExists ? "Mise à jour de la base…" : "Première génération de la base…"}
                  {progress && progress.total > 0 && (
                    <span className="tabular-nums text-muted-foreground">
                      {progress.done} / {progress.total} transcript(s)
                    </span>
                  )}
                </div>
                {progress && progress.total > 0 && (
                  <div
                    role="progressbar"
                    aria-label="Lecture des transcripts"
                    aria-valuemin={0}
                    aria-valuemax={progress.total}
                    aria-valuenow={progress.done}
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full bg-primary transition-[width]"
                      style={{ width: `${Math.round((100 * progress.done) / progress.total)}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {status.data && !status.data.dbExists && !ingest.isPending && (
              <p className="text-sm text-muted-foreground">
                La base <span className="font-mono">{status.data.dbPath}</span> n'existe pas encore.
                {hook?.state === "installed"
                  ? " Cliquez sur Actualiser pour la générer."
                  : " Elle sera générée dès que le hook sera installé."}
              </p>
            )}
            {status.data?.dbError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {status.data.dbError}
              </div>
            )}
            {report.isError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                Échec de la lecture : {errMsg(report.error)}
              </div>
            )}
            {report.isLoading && dbReady && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Lecture de usage.db…
              </div>
            )}

            {data && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                  <StatTile label="Appels au modèle" value={fmtInt(data.totals.calls)} />
                  <StatTile label="Output" value={fmtTokens(data.totals.output)} />
                  <StatTile label="Cache écrit" value={fmtTokens(data.totals.cacheWrite)} />
                  <StatTile label="Cache lu" value={fmtTokens(data.totals.cacheRead)} tone="muted" />
                  <StatTile
                    label="Output + cache écrit"
                    value={fmtTokens(data.currentMonthWeight)}
                    hint={`mois en cours (${data.currentMonth})`}
                  />
                  <StatTile
                    label="Limites atteintes"
                    value={data.limits.length}
                    tone={data.limits.length > 0 ? "danger" : "muted"}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground/70">
                  {data.firstAt ? `Du ${data.firstAt} au ${data.lastAt}` : "Aucun appel sur la période"}
                  {status.data?.lastMessageAt && ` · dernier appel en base le ${status.data.lastMessageAt}`}
                  {" · "}« Output + cache écrit » sert de repère pour comparer : le cache lu domine le
                  volume brut mais pèse beaucoup moins dans le quota.
                </p>

                <Pills label="Vue" items={viewItems} value={view} onChange={setView} />

                {view === "limits" ? (
                  <LimitsTable report={data} />
                ) : (
                  <UsageTable view={view} rows={rows} />
                )}
                {view === "sessions" && data.sessionsTotal > data.sessions.length && (
                  <p className="text-xs text-muted-foreground">
                    {data.sessions.length} sessions les plus récentes affichées sur{" "}
                    {data.sessionsTotal} — l'export Excel les contient toutes.
                  </p>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </ScrollFade>
    </div>
  );
}

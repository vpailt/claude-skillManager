// Traçabilité → Logs.
//
// Reads **every** file under `<exe_dir>/logs/` as one journal. The appender
// rolls daily, so a session that started before midnight lives in two files —
// the rotation is a storage detail, and making the reader pick a file from a
// dropdown made it their problem. `logging_read_all` stitches them back
// together, newest-first on the byte budget so what gets dropped is old history
// rather than the part being looked at.
//
// Two tabs over the same lines: the whole journal, and the forge calls alone
// (`target: "api"`, written by `github_client::trace_call`). The second answers
// a question the first cannot without squinting — how much are we asking of
// GitHub and Gitea, and how much of it is failing.
//
// Both tabs read newest-first, like the Activity page: what just happened is
// what anyone opening a log came for. Entries are reversed, never lines — see
// `newestFirst`.
//
// Parsing is deliberately tolerant. A log line is
//   <ISO timestamp>  <LEVEL> <target>: <message>
// but a panic backtrace, or any message containing a newline, produces lines
// that match nothing. Those are kept and attached to the entry above them
// rather than dropped — a stack trace is exactly what someone opening this page
// came for.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, FileText, Globe, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollFade } from "@/components/ScrollFade";
import { StatTile } from "@/components/StatTile";
import { TH, TH_ROW } from "@/lib/tableStyles";
import { api } from "@/lib/api";
import { cn, openExternal } from "@/lib/utils";
import { useNotifications } from "@/stores/notifications";
import type { LogFileInfo } from "@/lib/types";

const READ_BYTES = 8 * 1024 * 1024;

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_STYLES: Record<Level, string> = {
  ERROR: "text-destructive",
  WARN: "text-amber-500",
  INFO: "text-sky-500",
  DEBUG: "text-muted-foreground",
  TRACE: "text-muted-foreground/70",
};

interface LogLine {
  /** Epoch ms, or null for a continuation line (a stack trace, say). */
  ts: number | null;
  level: Level | null;
  target: string;
  message: string;
  /** The line as written, used for search so nothing is unfindable. */
  raw: string;
  /** A wrapped line belonging to the entry above it, not an entry of its own.
   *  What makes newest-first possible without shuffling a stack trace. */
  cont: boolean;
}

const LINE_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+(\S+?):\s?([\s\S]*)$/;

function parseLog(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    const m = raw.match(LINE_RE);
    if (m) {
      const ts = Date.parse(m[1]);
      out.push({
        ts: Number.isNaN(ts) ? null : ts,
        level: m[2] as Level,
        target: m[3],
        message: m[4],
        raw,
        cont: false,
      });
      continue;
    }
    // Continuation: inherit the level and time of the entry it belongs to, so
    // a level filter keeps a stack trace with its ERROR rather than orphaning
    // it under whatever filter happens to be on.
    const prev = out[out.length - 1];
    out.push({
      ts: prev?.ts ?? null,
      level: prev?.level ?? null,
      target: prev?.target ?? "",
      message: raw,
      raw,
      cont: true,
    });
  }
  return out;
}

/**
 * Newest entry first, which is the order anyone opening a log wants: what just
 * happened is what they came for, and scrolling to the bottom of a week of
 * history to find it is not a reading order.
 *
 * Reversing the *lines* would be wrong — a stack trace would print upside down,
 * above the error it belongs to. So entries are reversed, and each entry keeps
 * its continuations in the order they were written. A continuation whose parent
 * a filter removed stands alone rather than vanishing.
 */
function newestFirst(lines: LogLine[]): LogLine[] {
  const blocks: LogLine[][] = [];
  for (const l of lines) {
    if (!l.cont || blocks.length === 0) blocks.push([l]);
    else blocks[blocks.length - 1].push(l);
  }
  blocks.reverse();
  return blocks.flat();
}

// ============================================================
// Forge calls
// ============================================================

/** `GET https://api.github.com/… -> 200`, or `-> failed (detail)`. */
const API_RE = /^([A-Z]+)\s+(\S+)\s+->\s+(\d{3}|failed)(?:\s+\((.*)\))?$/;

interface ApiCall {
  ts: number | null;
  method: string;
  url: string;
  host: string;
  path: string;
  /** Null when the request never got an answer (transport failure). */
  status: number | null;
  note: string;
  raw: string;
}

function parseApiCalls(lines: LogLine[]): ApiCall[] {
  const out: ApiCall[] = [];
  for (const l of lines) {
    if (l.target !== "api") continue;
    const m = l.message.match(API_RE);
    if (!m) continue;
    let host = "";
    let path = m[2];
    try {
      const u = new URL(m[2]);
      host = u.host;
      path = u.pathname + u.search;
    } catch {
      // Not absolute — keep the raw string as the path, host unknown.
    }
    out.push({
      ts: l.ts,
      method: m[1],
      url: m[2],
      host,
      path,
      status: m[3] === "failed" ? null : Number(m[3]),
      note: m[4] ?? "",
      raw: l.raw,
    });
  }
  return out;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Failed outright, or answered with an error status. */
function isFailure(c: ApiCall): boolean {
  return c.status === null || c.status >= 400;
}

function stamp(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function clock(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

/** `<input type="datetime-local">` speaks local time with no zone; this is the
 *  matching read, so a bound the user typed means what their clock says. */
function localInputToMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}


/**
 * Calls per hour, today. One series, so no legend — the heading names it — and
 * one colour, so there is no categorical palette to get wrong. Bars are anchored
 * to the baseline with a 2 px gap and rounded tops; a non-zero hour never
 * renders as nothing, or a single call would be invisible. The table underneath
 * is the accessible view of the same data.
 */
function HourlyBars({ calls }: { calls: ApiCall[] }) {
  const buckets = useMemo(() => {
    const b = new Array<number>(24).fill(0);
    const from = startOfToday();
    for (const c of calls) {
      if (c.ts === null || c.ts < from) continue;
      b[new Date(c.ts).getHours()] += 1;
    }
    return b;
  }, [calls]);

  const max = Math.max(...buckets, 1);
  const nowHour = new Date().getHours();

  return (
    <div>
      <div className="flex h-20 items-end gap-[2px]" role="img"
        aria-label={`Appels par heure aujourd'hui : ${buckets
          .map((n, h) => `${h} h, ${n}`)
          .join(" ; ")}`}
      >
        {buckets.map((n, h) => (
          <div
            key={h}
            className="flex h-full flex-1 items-end"
            title={`${String(h).padStart(2, "0")} h — ${n} appel${n > 1 ? "s" : ""}`}
          >
            <div
              className={cn(
                "w-full rounded-t-[4px] transition-[height]",
                h === nowHour ? "bg-primary" : "bg-primary/60"
              )}
              style={{ height: n === 0 ? 0 : `max(2px, ${(n / max) * 100}%)` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between border-t pt-1 text-[10px] text-muted-foreground">
        <span>00 h</span>
        <span>06 h</span>
        <span>12 h</span>
        <span>18 h</span>
        <span>23 h</span>
      </div>
    </div>
  );
}

export function LogsPage() {
  const [tab, setTab] = useState<"journal" | "api">("journal");
  const [query, setQuery] = useState("");
  const [minLevel, setMinLevel] = useState<Level>("TRACE");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);

  const files = useQuery({
    queryKey: ["log-files"],
    queryFn: api.loggingListFiles,
    staleTime: 30_000,
  });

  const push = useNotifications((s) => s.push);
  const exportMutation = useMutation({
    mutationFn: api.loggingExportZip,
    onSuccess: (path) =>
      push({
        kind: "success",
        title: "Logs exportés",
        body: path,
        // The archive is the point, so hand over the folder it is in rather
        // than only naming a path the user then has to go and find.
        onClick: () => openExternal(path.replace(/[\\/][^\\/]+$/, "")),
      }),
    onError: (e) =>
      push({
        kind: "error",
        title: "Export impossible",
        body: String(e),
      }),
  });

  const content = useQuery({
    queryKey: ["log-all"],
    queryFn: () => api.loggingReadAll(READ_BYTES),
    staleTime: 10_000,
  });

  const lines = useMemo(() => parseLog(content.data ?? ""), [content.data]);
  const calls = useMemo(() => parseApiCalls(lines), [lines]);

  const fromMs = localInputToMs(from);
  const toMs = localInputToMs(to);
  const q = query.trim().toLowerCase();

  const shown = useMemo(() => {
    // Levels are ordered most severe first, so "at least WARN" is "index <=
    // index of WARN" — the same test the backend's filter makes.
    const maxIdx = LEVELS.indexOf(minLevel);
    const kept = lines.filter((l) => {
      if (l.level && LEVELS.indexOf(l.level) > maxIdx) return false;
      if (fromMs !== null && l.ts !== null && l.ts < fromMs) return false;
      if (toMs !== null && l.ts !== null && l.ts > toMs) return false;
      if (q && !l.raw.toLowerCase().includes(q)) return false;
      return true;
    });
    // Filter first, then reverse: reversing a filtered list keeps whichever
    // continuations survived with the entry they belong to.
    return newestFirst(kept);
  }, [lines, q, minLevel, fromMs, toMs]);

  const shownCalls = useMemo(
    () =>
      calls
        .filter((c) => {
          if (failuresOnly && !isFailure(c)) return false;
          if (fromMs !== null && c.ts !== null && c.ts < fromMs) return false;
          if (toMs !== null && c.ts !== null && c.ts > toMs) return false;
          if (q && !c.raw.toLowerCase().includes(q)) return false;
          return true;
        })
        // One line per call, so nothing to group: a plain reverse is the whole
        // of "newest first" here.
        .reverse(),
    [calls, q, failuresOnly, fromMs, toMs]
  );

  const today = useMemo(() => {
    const start = startOfToday();
    const todays = calls.filter((c) => c.ts !== null && c.ts >= start);
    const byHost = new Map<string, number>();
    for (const c of todays) {
      const key = c.host || "hôte inconnu";
      byHost.set(key, (byHost.get(key) ?? 0) + 1);
    }
    return {
      total: todays.length,
      failed: todays.filter(isFailure).length,
      cached: todays.filter((c) => c.status === 304).length,
      hosts: [...byHost.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [calls]);

  const list: LogFileInfo[] = files.data ?? [];
  const totalSize = list.reduce((a, f) => a + f.size, 0);

  const filtersOn = Boolean(from || to || query) || minLevel !== "TRACE" || failuresOnly;

  return (
    <div className="panel flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="shrink-0 text-sm font-semibold">Logs</h2>

        <div role="tablist" className="ml-2 flex shrink-0 items-center gap-1">
          {(
            [
              ["journal", "Journal"],
              ["api", "Appels API"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                tab === id
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent"
              )}
            >
              {label}
              {id === "api" && calls.length > 0 && (
                <span className="ml-1.5 tabular-nums opacity-70">
                  {calls.length}
                </span>
              )}
            </button>
          ))}
        </div>

        <Badge variant="outline" className="shrink-0" title="Tous les fichiers de log réunis">
          {list.length} fichier{list.length > 1 ? "s" : ""} · {kb(totalSize)}
        </Badge>

        <Badge variant="outline" className="shrink-0">
          {tab === "journal"
            ? `${shown.length}${shown.length !== lines.length ? ` / ${lines.length}` : ""} ligne(s)`
            : `${shownCalls.length}${shownCalls.length !== calls.length ? ` / ${calls.length}` : ""} appel(s)`}
        </Badge>

        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-8 shrink-0 px-2 text-xs"
          onClick={() => {
            void files.refetch();
            void content.refetch();
          }}
          disabled={content.isFetching}
          title="Relire les fichiers depuis le disque"
        >
          <RefreshCw
            className={cn("mr-1 h-3 w-3", content.isFetching && "animate-spin")}
          />
          Recharger
        </Button>

        {/* The archive holds the files *whole*, unlike this page, which reads
            them under a byte budget — an export is what gets attached to a bug
            report, and one missing the part before the cut explains nothing. */}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 shrink-0 px-2 text-xs"
          onClick={() => exportMutation.mutate()}
          disabled={exportMutation.isPending || list.length === 0}
          title="Créer une archive zip de tous les fichiers de log dans le dossier Téléchargements"
        >
          <Download
            className={cn(
              "mr-1 h-3 w-3",
              exportMutation.isPending && "animate-pulse"
            )}
          />
          {exportMutation.isPending ? "Export…" : "Exporter"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={
              tab === "journal"
                ? "Rechercher dans les lignes…"
                : "Rechercher un hôte, un chemin…"
            }
            className="h-8 pl-9 text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {tab === "journal" ? (
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Niveau min.</span>
            {LEVELS.map((lv) => (
              <button
                key={lv}
                type="button"
                onClick={() => setMinLevel(lv)}
                className={cn(
                  "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                  minLevel === lv
                    ? "border-primary bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent"
                )}
                title={`Afficher ${lv} et plus grave`}
              >
                {lv}
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setFailuresOnly((v) => !v)}
            className={cn(
              "rounded-md border px-2 py-1 text-[11px] transition-colors",
              failuresOnly
                ? "border-destructive bg-destructive/10 text-destructive"
                : "text-muted-foreground hover:bg-accent"
            )}
            title="N'afficher que les appels en échec (statut ≥ 400, ou sans réponse)"
          >
            Échecs uniquement
          </button>
        )}

        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Du
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          au
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          />
        </label>
        {filtersOn && (
          <button
            type="button"
            onClick={() => {
              setFrom("");
              setTo("");
              setQuery("");
              setMinLevel("TRACE");
              setFailuresOnly(false);
            }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            réinitialiser
          </button>
        )}
      </div>

      {tab === "api" && (
        <div className="border-b px-4 py-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile
              label="Appels aujourd'hui"
              value={today.total}
              hint={
                today.hosts.length > 0
                  ? today.hosts.map(([h, n]) => `${h} : ${n}`).join(" · ")
                  : undefined
              }
            />
            <StatTile
              label="En échec"
              value={today.failed}
              tone={today.failed > 0 ? "danger" : "muted"}
              hint="statut ≥ 400 ou sans réponse"
            />
            <StatTile
              label="Servis par le cache"
              value={today.cached}
              tone="muted"
              hint="304 — quota dépensé, corps non transféré"
            />
            <StatTile
              label="Total chargé"
              value={calls.length}
              tone="muted"
              hint="toutes dates du journal"
            />
          </div>
          <div className="mt-3">
            <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Globe className="h-3.5 w-3.5" />
              Appels par heure, aujourd'hui
            </div>
            <HourlyBars calls={calls} />
          </div>
        </div>
      )}

      <ScrollFade className="min-h-0 flex-1">
        {content.isLoading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Chargement…</p>
        ) : content.error ? (
          <p className="px-4 py-6 text-sm text-destructive">
            Lecture impossible : {String(content.error)}
          </p>
        ) : tab === "journal" ? (
          shown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              {lines.length === 0
                ? "Aucun log enregistré."
                : "Aucune ligne ne correspond aux filtres."}
            </p>
          ) : (
            <table className="w-full border-collapse font-mono text-xs">
              <thead className={TH_ROW}>
                <tr>
                  <th className={cn(TH, "w-32")}>Horodatage</th>
                  <th className={cn(TH, "w-16")}>Niveau</th>
                  <th className={cn(TH, "w-56")}>Source</th>
                  <th className={TH}>Message</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l, i) => (
                  <tr
                    key={i}
                    className="border-b border-border/40 align-top hover:bg-accent/40"
                  >
                    <td className="w-32 whitespace-nowrap px-3 py-1 text-muted-foreground">
                      {stamp(l.ts)}
                    </td>
                    <td
                      className={cn(
                        "w-16 px-1 py-1 font-semibold",
                        l.level ? LEVEL_STYLES[l.level] : "text-muted-foreground"
                      )}
                    >
                      {l.level ?? ""}
                    </td>
                    <td
                      className="w-56 truncate px-2 py-1 text-muted-foreground"
                      title={l.target}
                    >
                      {l.target}
                    </td>
                    <td className="whitespace-pre-wrap break-all px-2 py-1">
                      {l.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : shownCalls.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {calls.length === 0
              ? "Aucun appel aux forges dans le journal chargé."
              : "Aucun appel ne correspond aux filtres."}
          </p>
        ) : (
          <table className="w-full border-collapse font-mono text-xs">
            <thead className={TH_ROW}>
              <tr>
                <th className={cn(TH, "w-24")}>Heure</th>
                <th className={cn(TH, "w-14")}>Méthode</th>
                <th className={cn(TH, "w-16")}>Statut</th>
                <th className={cn(TH, "w-44")}>Hôte</th>
                <th className={TH}>Chemin</th>
              </tr>
            </thead>
            <tbody>
              {shownCalls.map((c, i) => (
                <tr
                  key={i}
                  className="border-b border-border/40 align-top hover:bg-accent/40"
                >
                  <td className="w-24 whitespace-nowrap px-3 py-1 text-muted-foreground">
                    {clock(c.ts)}
                  </td>
                  <td className="w-14 px-1 py-1 font-semibold text-muted-foreground">
                    {c.method}
                  </td>
                  <td
                    className={cn(
                      "w-16 px-1 py-1 font-semibold tabular-nums",
                      c.status === null || c.status >= 400
                        ? "text-destructive"
                        : c.status === 304
                          ? "text-muted-foreground"
                          : "text-emerald-600 dark:text-emerald-400"
                    )}
                  >
                    {c.status ?? "échec"}
                  </td>
                  <td className="w-44 truncate px-2 py-1 text-muted-foreground" title={c.host}>
                    {c.host}
                  </td>
                  <td className="break-all px-2 py-1" title={c.note || undefined}>
                    {c.path}
                    {c.note && (
                      <span className="ml-2 text-muted-foreground">({c.note})</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ScrollFade>
    </div>
  );
}

// Traçabilité → Logs.
//
// Reads the files under `<exe_dir>/logs/` — all of them, not just the current
// one. The appender rolls daily, so the session someone is asking about is
// usually in yesterday's file, which `logging_tail` alone could never reach;
// that is why `logging_list_files` / `logging_read_file` exist.
//
// Parsing is deliberately tolerant. A log line is
//   <ISO timestamp>  <LEVEL> <target>: <message>
// but a panic backtrace, or any message containing a newline, produces lines
// that match nothing. Those are kept and attached to the entry above them
// rather than dropped — a stack trace is exactly what someone opening this page
// came for.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { LogFileInfo } from "@/lib/types";

const READ_BYTES = 4 * 1024 * 1024;

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
    });
  }
  return out;
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

export function LogsPage() {
  const [file, setFile] = useState<string>("");
  const [query, setQuery] = useState("");
  const [minLevel, setMinLevel] = useState<Level>("TRACE");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const files = useQuery({
    queryKey: ["log-files"],
    queryFn: api.loggingListFiles,
    staleTime: 30_000,
  });

  const content = useQuery({
    queryKey: ["log-file", file],
    queryFn: () => api.loggingReadFile(file, READ_BYTES),
    staleTime: 10_000,
  });

  const lines = useMemo(() => parseLog(content.data ?? ""), [content.data]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Levels are ordered most severe first, so "at least WARN" is "index <=
    // index of WARN" — the same test the backend's filter makes.
    const maxIdx = LEVELS.indexOf(minLevel);
    const fromMs = localInputToMs(from);
    const toMs = localInputToMs(to);
    return lines.filter((l) => {
      if (l.level && LEVELS.indexOf(l.level) > maxIdx) return false;
      if (fromMs !== null && l.ts !== null && l.ts < fromMs) return false;
      if (toMs !== null && l.ts !== null && l.ts > toMs) return false;
      if (q && !l.raw.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [lines, query, minLevel, from, to]);

  const list: LogFileInfo[] = files.data ?? [];
  // "" is the backend's "newest file"; name it after whatever that turns out to
  // be so the selector never reads as empty.
  const currentName = file || list[0]?.name || "";

  return (
    <div className="panel flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="shrink-0 text-sm font-semibold">Logs</h2>

        <select
          value={currentName}
          onChange={(e) => setFile(e.target.value)}
          className="h-8 shrink-0 rounded-md border bg-background px-2 text-xs"
          title="Fichier de log à afficher"
        >
          {list.length === 0 && <option value="">Aucun fichier</option>}
          {list.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name} · {kb(f.size)}
            </option>
          ))}
        </select>

        <Badge variant="outline" className="shrink-0">
          {shown.length}
          {shown.length !== lines.length && ` / ${lines.length}`} ligne(s)
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
          title="Relire le fichier depuis le disque"
        >
          <RefreshCw
            className={cn("mr-1 h-3 w-3", content.isFetching && "animate-spin")}
          />
          Recharger
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Rechercher dans les lignes…"
            className="h-8 pl-9 text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

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
        {(from || to || query || minLevel !== "TRACE") && (
          <button
            type="button"
            onClick={() => {
              setFrom("");
              setTo("");
              setQuery("");
              setMinLevel("TRACE");
            }}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            réinitialiser
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {content.isLoading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">Chargement…</p>
        ) : content.error ? (
          <p className="px-4 py-6 text-sm text-destructive">
            Lecture impossible : {String(content.error)}
          </p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {lines.length === 0
              ? "Ce fichier est vide."
              : "Aucune ligne ne correspond aux filtres."}
          </p>
        ) : (
          <table className="w-full border-collapse font-mono text-xs">
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
        )}
      </div>
    </div>
  );
}

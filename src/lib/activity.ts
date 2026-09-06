// What the app *did*, read back out of its own log file.
//
// The dashboard has shown a five-line summary of this for a while; the
// Traçabilité → Activité récente page shows the whole thing. Both parse the
// same lines with the same patterns, so the two cannot disagree about what an
// event was called — which is why this lives here rather than inside either
// page.
//
// The log file is the source on purpose. Every meaningful side effect already
// writes a `tracing::info!` line (that is the convention the backend follows),
// so there is no second store to keep in step, and what the user ships back as
// a bug report is exactly what the page showed them.
import {
  ArrowUpCircle,
  Download,
  FileSpreadsheet,
  GitPullRequest,
  Globe,
  Trash2,
} from "lucide-react";

export type ActivityKind =
  | "install"
  | "uninstall"
  | "install-mp"
  | "uninstall-mp"
  | "pr"
  | "export"
  | "app-update";
export type ActivityLevel = "ok" | "error";

export interface ActivityEvent {
  kind: ActivityKind;
  level: ActivityLevel;
  message: string;
  detail: string;
  url?: string;
  timestamp: number;
}

// NOTE: `\b` anchors below matter — without it, `install_plugin` would
// substring-match inside `uninstall_plugin` and mislabel every uninstall as
// an install. Uninstall patterns are checked first as belt-and-braces.
const ACTIVITY_PATTERNS: {
  re: RegExp;
  build: (m: RegExpMatchArray) => Omit<ActivityEvent, "timestamp">;
}[] = [
  // --- plugin uninstall ---
  {
    re: /\buninstall_plugin ok: (\S+)@(\S+)/,
    build: (m) => ({
      kind: "uninstall",
      level: "ok",
      message: "Plugin désinstallé",
      detail: `${m[1]} · ${m[2]}`,
    }),
  },
  {
    re: /\buninstall_plugin failed: (\S+)@(\S+): (.+)/,
    build: (m) => ({
      kind: "uninstall",
      level: "error",
      message: "Échec de la désinstallation",
      detail: `${m[1]} · ${m[2]} — ${m[3]}`,
    }),
  },
  // --- plugin install ---
  {
    re: /\binstall_plugin ok: (\S+)@(\S+)/,
    build: (m) => ({
      kind: "install",
      level: "ok",
      message: "Plugin installé",
      detail: `${m[1]} · ${m[2]}`,
    }),
  },
  {
    re: /\binstall_plugin failed: (\S+)@(\S+): (.+)/,
    build: (m) => ({
      kind: "install",
      level: "error",
      message: "Échec de l'installation",
      detail: `${m[1]} · ${m[2]} — ${m[3]}`,
    }),
  },
  // --- marketplace uninstall ---
  {
    re: /\buninstall_marketplace ok: (\S+)/,
    build: (m) => ({
      kind: "uninstall-mp",
      level: "ok",
      message: "Marketplace supprimée",
      detail: m[1],
    }),
  },
  {
    re: /\buninstall_marketplace failed: (\S+): (.+)/,
    build: (m) => ({
      kind: "uninstall-mp",
      level: "error",
      message: "Échec de la suppression de la marketplace",
      detail: `${m[1]} — ${m[2]}`,
    }),
  },
  // --- marketplace install ---
  {
    re: /\binstall_marketplace ok: (\S+) from (\S+)/,
    build: (m) => ({
      kind: "install-mp",
      level: "ok",
      message: "Marketplace installée",
      detail: `${m[1]} · ${m[2]}`,
    }),
  },
  {
    re: /\binstall_marketplace failed: (\S+) from (\S+): (.+)/,
    build: (m) => ({
      kind: "install-mp",
      level: "error",
      message: "Échec de l'installation de la marketplace",
      detail: `${m[1]} · ${m[2]} — ${m[3]}`,
    }),
  },
  // --- PR submission ---
  {
    re: /admin\.submit_changes ok: PR #(\d+) (\S+)/,
    build: (m) => ({
      kind: "pr",
      level: "ok",
      message: "PR ouverte",
      detail: `#${m[1]}`,
      url: m[2],
    }),
  },
  {
    re: /admin\.submit_changes failed: (.+): (.+)/,
    build: (m) => ({
      kind: "pr",
      level: "error",
      message: "Échec de l'envoi de la PR",
      detail: `${m[1]} — ${m[2]}`,
    }),
  },
  // --- app self-update ---
  //
  // The in-place swap is the only one that really "raises the version": the
  // installer fallback exits the process before it can log anything else, so
  // both its own line and the failure path are matched too. All three come out
  // of `app_updater` / `app_apply_update` (see `src-tauri/src/app_updater.rs`).
  {
    re: /app_updater: (\S+) -> (\S+) applied in place/,
    build: (m) => ({
      kind: "app-update",
      level: "ok",
      message: "SkillManager mis à jour",
      detail: `${m[1]} → ${m[2]}`,
    }),
  },
  {
    re: /app_apply_update failed: (\S+) -> (\S+): (.+)/,
    build: (m) => ({
      kind: "app-update",
      level: "error",
      message: "Échec de la mise à jour de SkillManager",
      detail: `${m[1]} → ${m[2]} — ${m[3]}`,
    }),
  },
  {
    re: /app_updater: installer spawned \((.+)\)/,
    build: (m) => ({
      kind: "app-update",
      level: "ok",
      message: "Installateur SkillManager lancé",
      detail: m[1].split(/[\\/]/).pop() || m[1],
    }),
  },
  // --- usage-audit Excel export ---
  {
    re: /\busage_audit\.export ok: (.+)/,
    build: (m) => ({
      kind: "export",
      level: "ok",
      message: "Audit exporté",
      // Show just the file name; the full path is in the row title.
      detail: m[1].split(/[\\/]/).pop() || m[1],
    }),
  },
];

export const ACTIVITY_ICONS: Record<ActivityKind, React.ComponentType<{ className?: string }>> = {
  install: Download,
  uninstall: Trash2,
  "install-mp": Globe,
  "uninstall-mp": Trash2,
  pr: GitPullRequest,
  export: FileSpreadsheet,
  "app-update": ArrowUpCircle,
};

export const ACTIVITY_OK_COLORS: Record<ActivityKind, string> = {
  install: "text-emerald-500",
  uninstall: "text-muted-foreground",
  "install-mp": "text-sky-500",
  "uninstall-mp": "text-muted-foreground",
  pr: "text-violet-500",
  export: "text-teal-500",
  "app-update": "text-emerald-500",
};

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

/** Newest first. `limit` of 0 (or below) means "everything the text holds" —
 *  the dashboard asks for five, the Activité récente page for all of it. */
export function parseActivity(log: string, limit = 0): ActivityEvent[] {
  const lines = log.split(/\r?\n/);
  const events: ActivityEvent[] = [];
  for (const line of lines) {
    const tsMatch = line.match(TS_RE);
    if (!tsMatch) continue;
    const ts = Date.parse(tsMatch[1]);
    if (Number.isNaN(ts)) continue;
    for (const pat of ACTIVITY_PATTERNS) {
      const m = line.match(pat.re);
      if (m) {
        events.push({ ...pat.build(m), timestamp: ts });
        break;
      }
    }
  }
  // Newest first. Already chronological from the file, so reverse.
  events.reverse();
  return limit > 0 ? events.slice(0, limit) : events;
}

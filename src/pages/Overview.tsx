import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  GitPullRequest,
  Globe,
  History,
  Key,
  Package,
  Pencil,
  Radar,
  Rocket,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useApp } from "@/stores/app";
import { useNotifications } from "@/stores/notifications";
import { useSettingsDialog } from "@/stores/settingsDialog";
import { api } from "@/lib/api";
import { cn, openExternal } from "@/lib/utils";
import type { Plugin } from "@/lib/types";
import { useAppVersion } from "@/hooks/useAppVersion";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 5_000) return "à l'instant";
  if (diff < 60_000) return `il y a ${Math.floor(diff / 1000)} s`;
  if (diff < 3_600_000) return `il y a ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `il y a ${Math.floor(diff / 3_600_000)} h`;
  return `il y a ${Math.floor(diff / 86_400_000)} j`;
}

function useTicker(periodMs: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), periodMs);
    return () => window.clearInterval(id);
  }, [periodMs]);
}

// A single counter inside the grouped counters card. Clickable cell (not its
// own Card) so the three counters read as one unit.
function CounterCell({
  icon: Icon,
  label,
  value,
  hint,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-0.5 px-5 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </span>
      <span className="text-xl font-semibold text-foreground">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </button>
  );
}

type Tone = "ok" | "warn" | "muted";

function HealthPill({
  icon: Icon,
  label,
  value,
  tone = "muted",
  title,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  title?: string;
  onClick?: () => void;
}) {
  const iconTone =
    tone === "ok"
      ? "text-emerald-500"
      : tone === "warn"
      ? "text-amber-500"
      : "text-muted-foreground";
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
        onClick && "transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", iconTone)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </Wrapper>
  );
}

function HealthBar() {
  const openSettingsTo = useSettingsDialog((s) => s.openTo);

  const auth = useQuery({
    queryKey: ["github-auth"],
    queryFn: api.githubAuthCheck,
    staleTime: 60_000,
  });
  const rate = useQuery({
    queryKey: ["github-rate"],
    queryFn: api.githubRateLimit,
    staleTime: 60_000,
  });
  const gitea = useQuery({
    queryKey: ["gitea-status"],
    queryFn: api.giteaStatusAll,
    staleTime: 60_000,
  });

  const tokenOk = !!auth.data?.[0];
  const tokenUser = auth.data?.[1] ?? "";
  const remaining = rate.data?.[0] ?? -1;
  const limit = rate.data?.[1] ?? -1;
  // Single locked Gitea instance (AlmaviaCX).
  const g = (gitea.data ?? [])[0];
  const giteaOk = !!g?.ok;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-card/40 px-3 py-1.5">
      <HealthPill
        icon={Key}
        label="GitHub"
        value={tokenOk ? `@${tokenUser}` : "non connecté"}
        tone={tokenOk ? "ok" : "warn"}
        title={
          tokenOk
            ? `Connecté en tant que @${tokenUser}${
                remaining >= 0 ? ` · quota ${remaining}/${limit}` : ""
              }`
            : "Aucun token GitHub configuré (Paramètres)"
        }
        onClick={() => openSettingsTo("connexions")}
      />
      <span className="text-muted-foreground/30">·</span>
      <HealthPill
        icon={Server}
        label="Gitea"
        value={
          giteaOk ? `@${g?.user}` : g?.hasToken ? "auth échouée" : "non connecté"
        }
        tone={giteaOk ? "ok" : "warn"}
        title={
          giteaOk
            ? `Gitea: connecté en tant que @${g?.user}`
            : "Gitea : non connecté — VPN GlobalProtect + token requis (Paramètres)"
        }
        onClick={() => openSettingsTo("connexions", "gitea")}
      />
    </div>
  );
}

function OutdatedRow({
  plugin,
  onOpen,
  onUpdate,
  busy,
}: {
  plugin: Plugin;
  onOpen: () => void;
  onUpdate: () => void;
  busy: boolean;
}) {
  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={`${plugin.name}@${plugin.marketplaceName}`}
      >
        <Package className="h-4 w-4 shrink-0 text-amber-400/80" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{plugin.name}</span>
          <span className="ml-1 text-xs text-muted-foreground">
            {plugin.marketplaceName}
          </span>
        </span>
        <span className="hidden shrink-0 whitespace-nowrap text-xs text-muted-foreground sm:inline">
          {plugin.installedVersion ?? "—"} → {plugin.latestVersion ?? "—"}
        </span>
      </button>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        onClick={onUpdate}
        disabled={busy}
      >
        <Download className="mr-1 h-3 w-3" />
        Mettre à jour
      </Button>
    </div>
  );
}

function NeedsAttentionSection() {
  const navigate = useNavigate();
  const marketplaces = useApp((s) => s.marketplaces);
  const setSelection = useApp((s) => s.setSelection);
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);

  const outdated = useMemo(
    () =>
      marketplaces
        .flatMap((m) => m.plugins)
        .filter((p) => p.installState === "outdated"),
    [marketplaces]
  );

  const installMutation = useMutation({
    mutationFn: api.installPlugin,
    onSuccess: (_, plugin) => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
      notify({ kind: "success", title: "Plugin mis à jour", body: plugin.name });
    },
    onError: (e, plugin) =>
      notify({
        kind: "error",
        title: `Échec de la mise à jour : ${plugin.name}`,
        body: errMsg(e),
      }),
  });

  const totalItems = outdated.length;
  const pendingPluginName = installMutation.isPending
    ? installMutation.variables?.name
    : undefined;

  return (
    <section className="flex flex-col">
      <div className="mb-3 flex items-center gap-2">
        <Pencil className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">À traiter</h2>
        {totalItems > 0 && <Badge variant="warning">{totalItems}</Badge>}
      </div>

      {totalItems === 0 ? (
        <Card className="flex-1">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            Tout est à jour — aucun plugin obsolète.
          </CardContent>
        </Card>
      ) : (
        <Card className="flex flex-1 flex-col">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Download className="h-4 w-4 text-amber-500" />
                Plugins obsolètes
              </CardTitle>
              <Badge variant="warning">{outdated.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex-1 space-y-1">
            {outdated.slice(0, 5).map((p) => (
              <OutdatedRow
                key={`${p.marketplaceName}/${p.name}`}
                plugin={p}
                busy={pendingPluginName === p.name}
                onOpen={() => {
                  setSelection({
                    kind: "plugin",
                    marketplace: p.marketplaceName,
                    plugin: p.name,
                  });
                  navigate("/skills");
                }}
                onUpdate={() => installMutation.mutate(p)}
              />
            ))}
            {outdated.length > 5 && (
              <button
                type="button"
                onClick={() => {
                  setSelection(null);
                  navigate("/skills");
                }}
                className="mt-2 flex w-full items-center justify-center gap-1 rounded-md py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                +{outdated.length - 5} de plus
                <ArrowRight className="h-3 w-3" />
              </button>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

type ActivityKind = "install" | "uninstall" | "install-mp" | "uninstall-mp" | "pr";
type ActivityLevel = "ok" | "error";

interface ActivityEvent {
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
];

const ACTIVITY_ICONS: Record<ActivityKind, React.ComponentType<{ className?: string }>> = {
  install: Download,
  uninstall: Trash2,
  "install-mp": Globe,
  "uninstall-mp": Trash2,
  pr: GitPullRequest,
};

const ACTIVITY_OK_COLORS: Record<ActivityKind, string> = {
  install: "text-emerald-500",
  uninstall: "text-muted-foreground",
  "install-mp": "text-sky-500",
  "uninstall-mp": "text-muted-foreground",
  pr: "text-violet-500",
};

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

function parseActivity(log: string, limit: number): ActivityEvent[] {
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
  return events.slice(0, limit);
}

function RecentActivitySection() {
  useTicker(60_000);
  const logTail = useQuery({
    queryKey: ["log-tail"],
    queryFn: () => api.loggingTail(128_000),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const events = useMemo(
    () => parseActivity(logTail.data ?? "", 5),
    [logTail.data]
  );

  return (
    <section className="flex flex-col">
      <div className="mb-3 flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Activité récente</h2>
      </div>
      <Card className="flex-1">
        <CardContent className="py-3">
          {logTail.isLoading && events.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">Chargement…</p>
          ) : events.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              Aucun événement d'installation, désinstallation ou PR enregistré.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {events.map((ev, i) => {
                const Icon = ACTIVITY_ICONS[ev.kind];
                const isError = ev.level === "error";
                const iconColor = isError
                  ? "text-destructive"
                  : ACTIVITY_OK_COLORS[ev.kind];
                const rowProps = ev.url
                  ? {
                      role: "button" as const,
                      tabIndex: 0,
                      onClick: () => openExternal(ev.url!),
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openExternal(ev.url!);
                        }
                      },
                      className: cn(
                        "flex items-center gap-3 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      ),
                    }
                  : {
                      className: cn(
                        "flex items-center gap-3 rounded-md px-2 py-1.5 text-sm"
                      ),
                    };
                return (
                  <li key={`${ev.timestamp}-${i}`} {...rowProps}>
                    <Icon className={cn("h-4 w-4 shrink-0", iconColor)} />
                    <span
                      className={cn(
                        "shrink-0 font-medium",
                        isError && "text-destructive"
                      )}
                    >
                      {ev.message}
                    </span>
                    <Badge
                      variant={isError ? "destructive" : "success"}
                      className="shrink-0 px-1.5 py-0 text-xs"
                    >
                      {isError ? "échec" : "ok"}
                    </Badge>
                    <span
                      className="min-w-0 flex-1 truncate text-muted-foreground"
                      title={ev.detail}
                    >
                      {ev.detail}
                    </span>
                    <span
                      className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
                      title={new Date(ev.timestamp).toLocaleString()}
                    >
                      {relativeTime(ev.timestamp)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ============================================================
// Marketplace PR tracking summary
// ============================================================

function MarketplaceTrackingSection() {
  const navigate = useNavigate();
  const settings = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
    staleTime: 60_000,
  });
  const trackedNames = useMemo(
    () =>
      (settings.data?.marketplaces ?? [])
        .filter((m) => m.trackPrs)
        .map((m) => m.name),
    [settings.data]
  );
  const tracked = useQuery({
    queryKey: ["tracked-prs"],
    queryFn: () => api.trackedMarketplacePrs(),
    staleTime: 5 * 60_000,
    enabled: trackedNames.length > 0,
    refetchOnWindowFocus: false,
  });

  // Open PR count per tracked marketplace (marketplace-scope + plugin-scope).
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const name of trackedNames) map.set(name, 0);
    for (const pr of tracked.data ?? []) {
      map.set(pr.marketplaceName, (map.get(pr.marketplaceName) ?? 0) + 1);
    }
    return map;
  }, [tracked.data, trackedNames]);

  const total = tracked.data?.length ?? 0;

  return (
    <section className="flex flex-col">
      <div className="mb-3 flex items-center gap-2">
        <Radar className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Suivi des marketplaces</h2>
        {trackedNames.length > 0 && total > 0 && (
          <Badge variant="secondary">{total} PR</Badge>
        )}
      </div>
      <Card
        role="button"
        tabIndex={0}
        onClick={() => navigate("/admin", { state: { tab: "tracking" } })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigate("/admin", { state: { tab: "tracking" } });
          }
        }}
        className="flex flex-1 flex-col cursor-pointer transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CardContent className="flex flex-1 flex-col justify-center py-4">
          {trackedNames.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun marketplace suivi. Activez le toggle <strong>Suivi PR</strong>{" "}
              sur un marketplace dans <strong>Administration → Gérer mon poste</strong>.
            </p>
          ) : tracked.isLoading ? (
            <p className="text-sm text-muted-foreground">Chargement des PR en cours…</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-3">
                <GitPullRequest className="h-7 w-7 text-sky-500" />
                <div>
                  <div className="text-2xl font-semibold">{total}</div>
                  <div className="text-xs text-muted-foreground">
                    PR ouverte{total === 1 ? "" : "s"} sur{" "}
                    {trackedNames.length} marketplace
                    {trackedNames.length === 1 ? "" : "s"} suivi
                    {trackedNames.length === 1 ? "" : "s"} (+ plugins)
                  </div>
                </div>
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                {Array.from(counts.entries()).map(([name, n]) => (
                  <Badge
                    key={name}
                    variant={n > 0 ? "secondary" : "outline"}
                    className="max-w-[14rem] truncate"
                    title={`${name}: ${n} PR`}
                  >
                    {name} · {n}
                  </Badge>
                ))}
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ============================================================
// AlmaviaCX marketplace highlight
// ============================================================

const ACX_REPO_URL = "https://git.almaviacx.local/Claude/acx-cl-marketplace";
const ACX_GITEA_HOST = "git.almaviacx.local";

function AcxMarketplaceCard() {
  const openSettingsTo = useSettingsDialog((s) => s.openTo);
  const gitea = useQuery({
    queryKey: ["gitea-status"],
    queryFn: api.giteaStatusAll,
    staleTime: 60_000,
  });
  const status = (gitea.data ?? []).find((g) => g.host === ACX_GITEA_HOST);
  const connected = !!status?.ok;

  return (
    <Card className="flex flex-1 flex-col border-primary/30 bg-primary/[0.03]">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-primary" />
            acx-cl-marketplace
          </CardTitle>
          {connected ? (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Connecté à Gitea{status?.user ? ` @${status.user}` : ""}
            </Badge>
          ) : (
            <Badge variant="warning" className="gap-1">
              <Server className="h-3 w-3" />
              Non connecté
            </Badge>
          )}
        </div>
        <CardDescription>
          Marketplace dédiée, maintenue et enrichie par AlmaviaCX.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <button
          type="button"
          onClick={() => openExternal(ACX_REPO_URL)}
          className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          title="Ouvrir le repo dans le navigateur"
        >
          <Globe className="h-3.5 w-3.5" />
          {ACX_REPO_URL}
          <ExternalLink className="h-3 w-3" />
        </button>

        <div className="rounded-md border bg-card/40 p-3">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            Pour récupérer les mises à jour de la marketplace et upgrader les
            skills :
          </div>
          <ul className="space-y-1 text-xs">
            <li className="flex items-center gap-2">
              {connected ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Server className="h-3.5 w-3.5 text-amber-500" />
              )}
              VPN <strong>GlobalProtect</strong> actif
            </li>
            <li className="flex items-center gap-2">
              {connected ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Key className="h-3.5 w-3.5 text-amber-500" />
              )}
              <span>
                Connexion <strong>Gitea</strong> configurée (
                <button
                  type="button"
                  onClick={() => openSettingsTo("connexions", "gitea")}
                  className="font-medium text-primary hover:underline"
                >
                  Paramètres → Gitea
                </button>
                )
              </span>
            </li>
          </ul>
          {!connected && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3 h-7 text-xs"
              onClick={() => openSettingsTo("connexions", "gitea")}
            >
              <Key className="mr-1 h-3 w-3" />
              Configurer Gitea
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// First-run guided onboarding ("Démarrer ici")
// ============================================================

function StepRow({
  index,
  done,
  title,
  desc,
  actionLabel,
  onAction,
}: {
  index: number;
  done: boolean;
  title: string;
  desc: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={cn(
          "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
          done
            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            : "bg-primary/10 text-primary"
        )}
      >
        {done ? <CheckCircle2 className="h-4 w-4" /> : index}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-sm font-medium",
            done && "text-muted-foreground line-through"
          )}
        >
          {title}
        </div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
      {!done && (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onAction}>
          {actionLabel}
          <ArrowRight className="ml-1 h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

function GettingStartedCard() {
  const navigate = useNavigate();
  const openSettingsTo = useSettingsDialog((s) => s.openTo);
  const marketplaces = useApp((s) => s.marketplaces);

  const auth = useQuery({
    queryKey: ["github-auth"],
    queryFn: api.githubAuthCheck,
    staleTime: 60_000,
  });
  const gitea = useQuery({
    queryKey: ["gitea-status"],
    queryFn: api.giteaStatusAll,
    staleTime: 60_000,
  });

  const connected =
    !!auth.data?.[0] || (gitea.data ?? []).some((g) => g.ok);
  const hasInstalledMarketplace = marketplaces.some((m) => m.installed);
  const hasInstalledPlugin = marketplaces.some((m) =>
    m.plugins.some(
      (p) => p.installState === "installed" || p.installState === "outdated"
    )
  );
  const anyEnabled = marketplaces.some((m) =>
    m.plugins.some((p) => p.enabled)
  );

  // The first run is over once you're connected AND at least one plugin is
  // actually installed — a marketplace alone only clones the index (no skills
  // downloaded yet), so we keep guiding until a plugin lands.
  if (connected && hasInstalledPlugin) return null;

  return (
    <Card className="mb-4 border-primary/30 bg-primary/[0.03]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Rocket className="h-5 w-5 text-primary" />
          Démarrer ici
        </CardTitle>
        <CardDescription>
          Trois étapes pour commencer à utiliser vos compétences Claude Code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <StepRow
          index={1}
          done={connected}
          title="Se connecter à un gestionnaire de version"
          desc="GitHub (token) ou Gitea (instance interne + VPN) pour récupérer les catalogues."
          actionLabel="Configurer"
          onAction={() => openSettingsTo("connexions")}
        />
        <StepRow
          index={2}
          done={hasInstalledMarketplace}
          title="Installer un catalogue (marketplace)"
          desc="Ajoutez puis installez un marketplace : son catalogue de plugins devient visible. Cela clone seulement l'index — aucun plugin n'est encore téléchargé."
          actionLabel="Gérer mon poste"
          onAction={() => navigate("/admin", { state: { tab: "local" } })}
        />
        <StepRow
          index={3}
          done={hasInstalledPlugin}
          title="Installer un plugin"
          desc="Depuis le catalogue, installez un plugin : son contenu (skills) est alors téléchargé dans ~/.claude/plugins/cache."
          actionLabel="Ouvrir Skills"
          onAction={() => navigate("/skills")}
        />
        <StepRow
          index={4}
          done={anyEnabled}
          title="Activer des compétences"
          desc="Dépliez un plugin installé et activez-le : Claude Code ne charge que les packs activés."
          actionLabel="Ouvrir Skills"
          onAction={() => navigate("/skills")}
        />
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const navigate = useNavigate();
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  const setSelection = useApp((s) => s.setSelection);
  const version = useAppVersion();

  const totalPlugins = marketplaces.reduce((acc, m) => acc + m.plugins.length, 0);
  const installedPlugins = marketplaces
    .flatMap((m) => m.plugins)
    .filter(
      (p) => p.installState === "installed" || p.installState === "outdated"
    ).length;
  const totalSkills =
    marketplaces.flatMap((m) => m.plugins).reduce((acc, p) => acc + p.skills.length, 0) +
    (localOnly?.plugins.length ?? 0);

  return (
    <div className="h-full w-full overflow-auto">
      <div className="flex w-full flex-col p-6">
        <header className="mb-4">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Dashboard</h1>
            {version && (
              <Badge variant="outline" className="font-mono text-xs">
                v{version}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Aperçu de vos plugins, skills et marketplaces Claude Code.
          </p>
        </header>

        <HealthBar />

        <GettingStartedCard />

        {/* Indicateurs (pleine largeur, en haut) */}
        <Card>
          <CardContent className="grid grid-cols-3 divide-x divide-border p-0">
            <CounterCell
              icon={Globe}
              label="Marketplaces"
              value={marketplaces.filter((m) => m.installed).length}
              hint={`installées · ${marketplaces.length} connues`}
              onClick={() => {
                setSelection(null);
                navigate("/skills");
              }}
            />
            <CounterCell
              icon={Package}
              label="Plugins"
              value={installedPlugins}
              hint={`installés · ${totalPlugins} connus`}
              onClick={() => {
                setSelection(null);
                navigate("/skills");
              }}
            />
            <CounterCell
              icon={Sparkles}
              label="Skills"
              value={totalSkills}
              hint="au total"
              onClick={() => {
                setSelection(null);
                navigate("/skills");
              }}
            />
          </CardContent>
        </Card>

        {/* À traiter (gauche) + Suivi des marketplaces (droite) — juste sous les indicateurs */}
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-stretch">
          <NeedsAttentionSection />
          <MarketplaceTrackingSection />
        </div>

        {/* Marketplace AlmaviaCX (gauche) + Activité récente (droite) — même hauteur */}
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-stretch">
          <section className="flex flex-col">
            <div className="mb-3 flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Marketplace AlmaviaCX</h2>
            </div>
            <AcxMarketplaceCard />
          </section>
          <RecentActivitySection />
        </div>
      </div>
    </div>
  );
}

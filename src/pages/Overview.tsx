import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock,
  Download,
  Gauge,
  GitPullRequest,
  Globe,
  History,
  Key,
  Package,
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
import { api } from "@/lib/api";
import { cn, openExternal, shortDate } from "@/lib/utils";
import type { Plugin } from "@/lib/types";
import { useAppVersion } from "@/hooks/useAppVersion";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function useTicker(periodMs: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), periodMs);
    return () => window.clearInterval(id);
  }, [periodMs]);
}

function StatCard({
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
  const clickable = !!onClick;
  return (
    <Card
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={cn(
        clickable &&
          "cursor-pointer transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
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
  const navigate = useNavigate();
  useTicker(30_000);

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
  const refresh = useQuery({
    queryKey: ["refresh"],
    queryFn: api.refreshAll,
    staleTime: 60_000,
  });

  const tokenOk = !!auth.data?.[0];
  const tokenUser = auth.data?.[1] ?? "";
  const remaining = rate.data?.[0] ?? -1;
  const limit = rate.data?.[1] ?? -1;
  const rateLow = remaining >= 0 && limit > 0 && remaining / limit < 0.1;
  const lastRefresh = refresh.dataUpdatedAt
    ? relativeTime(refresh.dataUpdatedAt)
    : "never";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-card/40 px-3 py-1.5">
      <HealthPill
        icon={Key}
        label="Token"
        value={tokenOk ? `@${tokenUser}` : "missing"}
        tone={tokenOk ? "ok" : "warn"}
        title={tokenOk ? `Signed in as @${tokenUser}` : "No GitHub token set"}
        onClick={() => navigate("/settings")}
      />
      <span className="text-muted-foreground/30">·</span>
      <HealthPill
        icon={Gauge}
        label="Rate limit"
        value={remaining >= 0 ? `${remaining} / ${limit}` : "n/a"}
        tone={rateLow ? "warn" : "ok"}
        title={
          rateLow
            ? "Less than 10% of your GitHub rate-limit remains"
            : "Remaining GitHub API calls"
        }
      />
      <span className="text-muted-foreground/30">·</span>
      <HealthPill
        icon={Clock}
        label="Last refresh"
        value={lastRefresh}
        tone={refresh.dataUpdatedAt ? "muted" : "warn"}
        title={
          refresh.dataUpdatedAt
            ? new Date(refresh.dataUpdatedAt).toLocaleString()
            : "Refresh hasn't completed yet"
        }
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
        Update
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

  const history = useQuery({
    queryKey: ["pr-history"],
    queryFn: api.prHistoryList,
    staleTime: 60_000,
  });

  const outdated = useMemo(
    () =>
      marketplaces
        .flatMap((m) => m.plugins)
        .filter((p) => p.installState === "outdated"),
    [marketplaces]
  );

  const openPRs = useMemo(
    () => (history.data ?? []).filter((p) => p.status === "open"),
    [history.data]
  );

  const installMutation = useMutation({
    mutationFn: api.installPlugin,
    onSuccess: (_, plugin) => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
      notify({ kind: "success", title: "Plugin updated", body: plugin.name });
    },
    onError: (e, plugin) =>
      notify({
        kind: "error",
        title: `Update failed: ${plugin.name}`,
        body: errMsg(e),
      }),
  });

  const totalItems = outdated.length + openPRs.length;
  const pendingPluginName = installMutation.isPending
    ? installMutation.variables?.name
    : undefined;

  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold">Needs attention</h2>
        {totalItems > 0 && <Badge variant="warning">{totalItems}</Badge>}
      </div>

      {totalItems === 0 ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            All caught up — no outdated plugins, no open PRs.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="flex flex-col">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Download className="h-4 w-4 text-amber-500" />
                  Outdated plugins
                </CardTitle>
                {outdated.length > 0 && (
                  <Badge variant="warning">{outdated.length}</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 space-y-1">
              {outdated.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  All installed plugins are up to date.
                </p>
              ) : (
                <>
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
                        navigate("/plugins");
                      }}
                      onUpdate={() => installMutation.mutate(p)}
                    />
                  ))}
                  {outdated.length > 5 && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelection(null);
                        navigate("/plugins");
                      }}
                      className="mt-2 flex w-full items-center justify-center gap-1 rounded-md py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                    >
                      +{outdated.length - 5} more
                      <ArrowRight className="h-3 w-3" />
                    </button>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <GitPullRequest className="h-4 w-4 text-sky-500" />
                  Open PRs
                </CardTitle>
                {openPRs.length > 0 && (
                  <Badge variant="secondary">{openPRs.length}</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 space-y-1">
              {openPRs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No PRs awaiting merge.
                </p>
              ) : (
                <>
                  {openPRs.slice(0, 5).map((pr) => (
                    <button
                      type="button"
                      key={`${pr.repo}#${pr.number}`}
                      onClick={() => openExternal(pr.url)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={`${pr.repo} #${pr.number} — ${pr.title}`}
                    >
                      <Badge
                        variant="outline"
                        className="shrink-0 font-mono text-[10px]"
                      >
                        #{pr.number}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                      <span className="hidden shrink-0 whitespace-nowrap text-xs text-muted-foreground sm:inline">
                        {shortDate(pr.createdAt)}
                      </span>
                    </button>
                  ))}
                  {openPRs.length > 5 && (
                    <button
                      type="button"
                      onClick={() => navigate("/admin")}
                      className="mt-2 flex w-full items-center justify-center gap-1 rounded-md py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                    >
                      +{openPRs.length - 5} more
                      <ArrowRight className="h-3 w-3" />
                    </button>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
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
      message: "Uninstalled plugin",
      detail: `${m[1]} · ${m[2]}`,
    }),
  },
  {
    re: /\buninstall_plugin failed: (\S+)@(\S+): (.+)/,
    build: (m) => ({
      kind: "uninstall",
      level: "error",
      message: "Uninstall failed",
      detail: `${m[1]} · ${m[2]} — ${m[3]}`,
    }),
  },
  // --- plugin install ---
  {
    re: /\binstall_plugin ok: (\S+)@(\S+)/,
    build: (m) => ({
      kind: "install",
      level: "ok",
      message: "Installed plugin",
      detail: `${m[1]} · ${m[2]}`,
    }),
  },
  {
    re: /\binstall_plugin failed: (\S+)@(\S+): (.+)/,
    build: (m) => ({
      kind: "install",
      level: "error",
      message: "Install failed",
      detail: `${m[1]} · ${m[2]} — ${m[3]}`,
    }),
  },
  // --- marketplace uninstall ---
  {
    re: /\buninstall_marketplace ok: (\S+)/,
    build: (m) => ({
      kind: "uninstall-mp",
      level: "ok",
      message: "Removed marketplace",
      detail: m[1],
    }),
  },
  {
    re: /\buninstall_marketplace failed: (\S+): (.+)/,
    build: (m) => ({
      kind: "uninstall-mp",
      level: "error",
      message: "Marketplace removal failed",
      detail: `${m[1]} — ${m[2]}`,
    }),
  },
  // --- marketplace install ---
  {
    re: /\binstall_marketplace ok: (\S+) from (\S+)/,
    build: (m) => ({
      kind: "install-mp",
      level: "ok",
      message: "Installed marketplace",
      detail: `${m[1]} · ${m[2]}`,
    }),
  },
  {
    re: /\binstall_marketplace failed: (\S+) from (\S+): (.+)/,
    build: (m) => ({
      kind: "install-mp",
      level: "error",
      message: "Marketplace install failed",
      detail: `${m[1]} · ${m[2]} — ${m[3]}`,
    }),
  },
  // --- PR submission ---
  {
    re: /admin\.submit_changes ok: PR #(\d+) (\S+)/,
    build: (m) => ({
      kind: "pr",
      level: "ok",
      message: "Opened PR",
      detail: `#${m[1]}`,
      url: m[2],
    }),
  },
  {
    re: /admin\.submit_changes failed: (.+): (.+)/,
    build: (m) => ({
      kind: "pr",
      level: "error",
      message: "PR submission failed",
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
    <section className="mt-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold">Recent activity</h2>
        <History className="h-4 w-4 text-muted-foreground" />
      </div>
      <Card>
        <CardContent className="py-3">
          {logTail.isLoading && events.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
          ) : events.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              No install, uninstall or PR events logged yet.
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
                      className="shrink-0 px-1.5 py-0 text-[10px]"
                    >
                      {isError ? "failed" : "ok"}
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

  const goToMarketplace = (name: string) => {
    setSelection({ kind: "marketplace", marketplace: name });
    navigate("/plugins");
  };

  return (
    <div className="h-full w-full overflow-auto">
      <div className="flex w-full flex-col p-6">
        <header className="mb-4">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Overview</h1>
            {version && (
              <Badge variant="outline" className="font-mono text-[11px]">
                v{version}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Snapshot of your Claude Code plugins, skills and marketplaces.
          </p>
        </header>

        <HealthBar />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={Globe}
            label="Marketplaces"
            value={marketplaces.length}
            hint={`${marketplaces.filter((m) => m.installed).length} installed`}
            onClick={() => {
              setSelection(null);
              navigate("/plugins");
            }}
          />
          <StatCard
            icon={Package}
            label="Plugins"
            value={installedPlugins}
            hint={`${totalPlugins} known`}
            onClick={() => {
              setSelection(null);
              navigate("/plugins");
            }}
          />
          <StatCard
            icon={Sparkles}
            label="Skills"
            value={totalSkills}
            onClick={() => {
              setSelection(null);
              navigate("/skills");
            }}
          />
          <StatCard
            icon={Activity}
            label="GitHub"
            value={
              auth.data?.[0] ? (
                <span className="text-base font-normal">@{auth.data[1]}</span>
              ) : (
                <span className="text-base font-normal text-muted-foreground">
                  no token
                </span>
              )
            }
            hint={
              rate.data && rate.data[0] >= 0
                ? `rate-limit: ${rate.data[0]}/${rate.data[1]}`
                : undefined
            }
            onClick={() => navigate("/settings")}
          />
        </div>

        <NeedsAttentionSection />

        <RecentActivitySection />

        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Marketplaces</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {marketplaces.map((m) => (
              <Card
                key={m.name}
                role="button"
                tabIndex={0}
                onClick={() => goToMarketplace(m.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    goToMarketplace(m.name);
                  }
                }}
                className="cursor-pointer transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="truncate text-base">{m.name}</CardTitle>
                    {m.installed ? (
                      <Badge variant="success" className="shrink-0">
                        installed
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="shrink-0">
                        not installed
                      </Badge>
                    )}
                  </div>
                  <CardDescription className="truncate">
                    {m.sourceRepo || m.sourcePath || m.sourceKind}
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  {m.plugins.length} plugin{m.plugins.length === 1 ? "" : "s"}
                  {m.editable && (
                    <Badge variant="secondary" className="ml-2">
                      editable
                    </Badge>
                  )}
                </CardContent>
              </Card>
            ))}
            {marketplaces.length === 0 && (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                  No marketplaces configured yet. Add one from the Settings page.
                </CardContent>
              </Card>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

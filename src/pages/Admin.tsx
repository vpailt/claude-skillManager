import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Trash2,
  RefreshCw,
  ShieldCheck,
  ListChecks,
  Globe,
  Sparkles,
  Upload,
  HardDrive,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { openExternal, shortDate } from "@/lib/utils";
import {
  AddPluginButton,
  PluginActionsRow,
  useEditableMarketplaces,
  WizardHost,
  type WizardKind,
} from "@/components/AdminWizards";
import { AdminLocalPanel } from "@/components/AdminLocalPanel";
import { useApp } from "@/stores/app";
import { useNotifications } from "@/stores/notifications";
import type { PendingPR, Plugin, RemoteSkillInfo } from "@/lib/types";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function statusVariant(status: string) {
  if (status === "merged") return "success" as const;
  if (status === "closed") return "destructive" as const;
  return "secondary" as const;
}

// ============================================================
// Marketplace + plugins admin section
// ============================================================

function MarketplaceAdminSection({
  onLaunch,
}: {
  onLaunch: (w: WizardKind) => void;
}) {
  const editable = useEditableMarketplaces();
  const allMarketplaces = useApp((s) => s.marketplaces);
  const [selectedMp, setSelectedMp] = useState<string>("");
  const [pluginFilter, setPluginFilter] = useState("");
  const findMarketplace = useApp((s) => s.findMarketplace);

  useEffect(() => {
    if (editable.length === 0) {
      if (selectedMp !== "") setSelectedMp("");
      return;
    }
    if (!editable.some((m) => m.name === selectedMp)) {
      setSelectedMp(editable[0].name);
    }
  }, [editable, selectedMp]);

  const mp = selectedMp ? findMarketplace(selectedMp) : undefined;
  const filteredPlugins = useMemo(() => {
    if (!mp) return [];
    const q = pluginFilter.trim().toLowerCase();
    return mp.plugins.filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [mp, pluginFilter]);

  if (editable.length === 0) {
    const githubBacked = allMarketplaces.filter((m) => m.sourceRepo);
    const unconfigured = allMarketplaces.filter((m) => !m.sourceRepo);
    return (
      <Card>
        <CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            No editable marketplace available.
          </p>
          {allMarketplaces.length === 0 && (
            <p>
              No marketplace registered yet. Add one from the <strong>Admin local</strong>{" "}
              tab using <em>Add from URL</em>.
            </p>
          )}
          {unconfigured.length > 0 && (
            <p>
              These marketplaces have no GitHub repo configured:{" "}
              <span className="font-mono text-foreground">
                {unconfigured.map((m) => m.name).join(", ")}
              </span>
              .
            </p>
          )}
          {githubBacked.length > 0 && (
            <p>
              Your GitHub token does not have push access on:{" "}
              <span className="font-mono text-foreground">
                {githubBacked.map((m) => `${m.name} (${m.sourceRepo})`).join(", ")}
              </span>
              . Use a token with the <code>repo</code> scope (classic PAT) or{" "}
              <code>Contents: write</code> + <code>Pull requests: write</code>{" "}
              (fine-grained), then refresh.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Marketplace:</span>
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          value={selectedMp}
          onChange={(e) => setSelectedMp(e.target.value)}
        >
          {editable.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} — {m.sourceRepo}
            </option>
          ))}
        </select>
        {mp && <AddPluginButton marketplace={mp.name} onLaunch={onLaunch} />}
      </div>

      {mp && (
        <div className="space-y-3">
          <Input
            placeholder="Filter plugins…"
            value={pluginFilter}
            onChange={(e) => setPluginFilter(e.target.value)}
          />
          <div className="space-y-2">
            {filteredPlugins.map((p) => (
              <PluginAdminCard
                key={p.name}
                marketplace={mp.name}
                plugin={p}
                onLaunch={onLaunch}
              />
            ))}
            {filteredPlugins.length === 0 && (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                  No plugins listed in this marketplace yet. Click{" "}
                  <em>Add plugin</em> to register one.
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PluginAdminCard({
  marketplace,
  plugin,
  onLaunch,
}: {
  marketplace: string;
  plugin: Plugin;
  onLaunch: (w: WizardKind) => void;
}) {
  const qc = useQueryClient();
  const [showSkills, setShowSkills] = useState(false);
  const remote = useQuery({
    enabled: showSkills,
    queryKey: ["remote-skills", marketplace, plugin.name],
    queryFn: () => api.adminListRemoteSkills(marketplace, plugin.name),
  });
  const pending = useQuery({
    enabled: showSkills,
    queryKey: ["pending-prs"],
    queryFn: api.pendingPrsList,
    staleTime: 10_000,
  });

  // Index pending PRs by skill name so each row can show its in-flight state.
  // Also surface skills that exist only in a pending PR (add-skill not yet
  // merged), so a refresh doesn't make them disappear.
  const pendingBySkill = useMemo(() => {
    const map = new Map<string, PendingPR>();
    for (const p of pending.data ?? []) {
      if (
        p.marketplaceName !== marketplace ||
        p.pluginName !== plugin.name ||
        !p.skillName
      ) {
        continue;
      }
      map.set(p.skillName, p);
    }
    return map;
  }, [pending.data, marketplace, plugin.name]);

  const remoteByName = useMemo(() => {
    const m = new Map<string, RemoteSkillInfo>();
    for (const r of remote.data ?? []) m.set(r.name, r);
    return m;
  }, [remote.data]);

  // Merge real remote skills with skill-scoped pending PRs so users see
  // "still in review" entries even before the merge propagates upstream.
  const merged = useMemo(() => {
    const out: {
      name: string;
      version: string;
      localFolder?: string;
      localVersion?: string;
      pending?: PendingPR;
    }[] = [];
    for (const r of remote.data ?? []) {
      out.push({
        name: r.name,
        version: r.version,
        localFolder: r.localMatch?.folder,
        localVersion: r.localMatch?.version,
        pending: pendingBySkill.get(r.name),
      });
    }
    for (const [name, p] of pendingBySkill) {
      if (!remoteByName.has(name)) {
        out.push({
          name,
          version: p.newVersion,
          pending: p,
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [remote.data, pendingBySkill, remoteByName]);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["remote-skills", marketplace, plugin.name] });
    qc.invalidateQueries({ queryKey: ["pending-prs"] });
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{plugin.name}</CardTitle>
            <CardDescription className="line-clamp-2">
              {plugin.description || plugin.source?.repo || "—"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">v{plugin.latestVersion || "?"}</Badge>
            {plugin.source?.repo && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  openExternal(`https://github.com/${plugin.source!.repo}`)
                }
              >
                <ExternalLink className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <PluginActionsRow
          marketplace={marketplace}
          plugin={plugin}
          onLaunch={onLaunch}
        />
        <div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowSkills((v) => !v)}
            >
              <Sparkles className="mr-1 h-3 w-3" />
              {showSkills ? "Hide" : "Show"} remote skills
            </Button>
            {showSkills && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={refreshAll}
                disabled={remote.isFetching || pending.isFetching}
                title="Refresh remote skills (including pending PRs)"
              >
                <RefreshCw
                  className={`h-3 w-3 ${
                    remote.isFetching || pending.isFetching
                      ? "animate-spin"
                      : ""
                  }`}
                />
              </Button>
            )}
          </div>
          {showSkills && (
            <div className="mt-2 space-y-1">
              {remote.isLoading && (
                <div className="text-xs text-muted-foreground">
                  Loading remote skills…
                </div>
              )}
              {remote.error && (
                <div className="text-xs text-destructive">
                  {(remote.error as Error).message}
                </div>
              )}
              {merged.length === 0 && !remote.isLoading && (
                <div className="text-xs text-muted-foreground">
                  No skills found in plugin source repo.
                </div>
              )}
              {merged.map((s) => {
                const action = s.pending?.action;
                const isDeleting = action === "delete-skill";
                const isAdding = action === "add-skill";
                const isUpdating = action === "update-skill";
                const inReview = isAdding || isUpdating || isDeleting;
                return (
                  <div
                    key={s.name}
                    className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${
                      isDeleting
                        ? "border-destructive/40 bg-destructive/5"
                        : inReview
                        ? "border-amber-500/40 bg-amber-500/5"
                        : "bg-muted/30"
                    }`}
                  >
                    <Sparkles className="h-3 w-3" />
                    <span
                      className={`font-medium ${
                        isDeleting ? "line-through opacity-70" : ""
                      }`}
                    >
                      {s.name}
                    </span>
                    {s.version && (
                      <Badge variant="outline" className="text-[10px]">
                        v{s.version}
                      </Badge>
                    )}
                    {s.localFolder && (
                      <Badge variant="success" className="text-[10px]">
                        local: v{s.localVersion || "?"}
                      </Badge>
                    )}
                    {inReview && s.pending && (
                      <button
                        type="button"
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium hover:underline ${
                          isDeleting
                            ? "bg-destructive/10 text-destructive"
                            : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                        }`}
                        title={`Open PR #${s.pending.prNumber}`}
                        onClick={() => openExternal(s.pending!.prUrl)}
                      >
                        {isDeleting
                          ? "deletion pending"
                          : isAdding
                          ? "add pending"
                          : "update pending"}
                        <ExternalLink className="h-2.5 w-2.5" />
                      </button>
                    )}
                    <div className="ml-auto flex gap-1">
                      {s.localFolder && !isDeleting && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() =>
                            onLaunch({
                              kind: "uploadSkill",
                              marketplace,
                              plugin,
                              initialTargetName: s.name,
                              initialLocalFolder: s.localFolder,
                            })
                          }
                        >
                          <Upload className="mr-1 h-3 w-3" />
                          Upgrade
                        </Button>
                      )}
                      {!isDeleting && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs text-destructive"
                          onClick={() =>
                            onLaunch({
                              kind: "deleteSkill",
                              marketplace,
                              plugin,
                              skillName: s.name,
                            })
                          }
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// PR history
// ============================================================

function PrHistorySection() {
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);
  const history = useQuery({ queryKey: ["pr-history"], queryFn: api.prHistoryList });

  const refreshStatus = useMutation({
    mutationFn: ({ repo, number }: { repo: string; number: number }) =>
      api.prHistoryRefreshStatus(repo, number),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pr-history"] }),
    onError: (e, vars) =>
      notify({
        kind: "error",
        title: `Refresh PR #${vars.number} failed`,
        body: errMsg(e),
      }),
  });
  const removeRecord = useMutation({
    mutationFn: ({ repo, number }: { repo: string; number: number }) =>
      api.prHistoryRemove(repo, number),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pr-history"] }),
    onError: (e, vars) =>
      notify({
        kind: "error",
        title: `Remove PR #${vars.number} failed`,
        body: errMsg(e),
      }),
  });
  const clearAll = useMutation({
    mutationFn: api.prHistoryClear,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pr-history"] }),
    onError: (e) =>
      notify({
        kind: "error",
        title: "Clear PR history failed",
        body: errMsg(e),
      }),
  });

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">PR history</h3>
          {history.data && history.data.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => clearAll.mutate()}>
              Clear all
            </Button>
          )}
        </div>
        <div className="space-y-2">
          {history.data?.length === 0 && (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                <ListChecks className="h-8 w-8 opacity-40" />
                <span>No PR history yet.</span>
              </CardContent>
            </Card>
          )}
          {history.data?.map((r) => (
            <Card key={`${r.repo}#${r.number}`}>
              <CardContent className="flex flex-wrap items-center gap-2 p-3 text-sm">
                <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                <button
                  type="button"
                  className="truncate text-left font-medium hover:underline"
                  title={r.url || "no URL"}
                  onClick={(e) => {
                    e.stopPropagation();
                    openExternal(r.url);
                  }}
                >
                  {r.title}
                </button>
                <Badge variant="outline" className="text-[10px]">
                  {r.kind || "—"}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {r.repo} #{r.number} · {shortDate(r.createdAt)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  title={r.url || "no URL"}
                  onClick={(e) => {
                    e.stopPropagation();
                    openExternal(r.url);
                  }}
                  disabled={!r.url}
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  title="Refresh status from GitHub"
                  onClick={() =>
                    refreshStatus.mutate({ repo: r.repo, number: r.number })
                  }
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  title="Remove from history"
                  onClick={() =>
                    removeRecord.mutate({ repo: r.repo, number: r.number })
                  }
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export function AdminPage() {
  const [tab, setTab] = useState<"local" | "remote" | "history">("local");
  const [wizard, setWizard] = useState<WizardKind | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Admin</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          <strong>Local</strong> — install / uninstall / enable plugins on your
          machine. <strong>Distant</strong> — push registry changes to GitHub
          via Pull Requests.
        </p>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant={tab === "local" ? "default" : "ghost"}
            onClick={() => setTab("local")}
          >
            <HardDrive className="mr-1 h-3 w-3" />
            Admin local
          </Button>
          <Button
            size="sm"
            variant={tab === "remote" ? "default" : "ghost"}
            onClick={() => setTab("remote")}
          >
            <Globe className="mr-1 h-3 w-3" />
            Admin distant
          </Button>
          <Button
            size="sm"
            variant={tab === "history" ? "default" : "ghost"}
            onClick={() => setTab("history")}
          >
            <ListChecks className="mr-1 h-3 w-3" />
            PR history
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-4">
          {tab === "local" && <AdminLocalPanel />}
          {tab === "remote" && <MarketplaceAdminSection onLaunch={setWizard} />}
          {tab === "history" && <PrHistorySection />}
        </div>
      </div>

      <WizardHost active={wizard} onClose={() => setWizard(null)} />
    </div>
  );
}

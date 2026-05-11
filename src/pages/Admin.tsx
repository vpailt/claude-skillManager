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
  Trash,
  HardDrive,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { shortDate } from "@/lib/utils";
import {
  AddPluginButton,
  PluginActionsRow,
  useEditableMarketplaces,
  WizardHost,
  type WizardKind,
} from "@/components/AdminWizards";
import { AdminLocalPanel } from "@/components/AdminLocalPanel";
import { useApp } from "@/stores/app";
import type { Plugin } from "@/lib/types";

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

  // Default the dropdown to the first editable marketplace once data arrives,
  // and clear the selection if the current pick disappears (e.g. token revoked).
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
              No marketplace registered yet. Add one in <strong>Settings</strong>{" "}
              with an <code>owner/repo</code>.
            </p>
          )}
          {unconfigured.length > 0 && (
            <p>
              These marketplaces have no GitHub repo configured — open{" "}
              <strong>Settings</strong> and fill in <code>owner/repo</code> for:{" "}
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
  const [showSkills, setShowSkills] = useState(false);
  const remote = useQuery({
    enabled: showSkills,
    queryKey: ["remote-skills", marketplace, plugin.name],
    queryFn: () => api.adminListRemoteSkills(marketplace, plugin.name),
  });

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
                  openUrl(`https://github.com/${plugin.source!.repo}`)
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowSkills((v) => !v)}
          >
            <Sparkles className="mr-1 h-3 w-3" />
            {showSkills ? "Hide" : "Show"} remote skills
          </Button>
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
              {remote.data?.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No skills found in plugin source repo.
                </div>
              )}
              {remote.data?.map((s) => (
                <div
                  key={s.name}
                  className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-xs"
                >
                  <Sparkles className="h-3 w-3" />
                  <span className="font-medium">{s.name}</span>
                  {s.version && (
                    <Badge variant="outline" className="text-[10px]">
                      v{s.version}
                    </Badge>
                  )}
                  {s.localMatch && (
                    <Badge variant="success" className="text-[10px]">
                      local: v{s.localMatch.version || "?"}
                    </Badge>
                  )}
                  <div className="ml-auto flex gap-1">
                    {s.localMatch && (
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
                            initialLocalFolder: s.localMatch!.folder,
                          })
                        }
                      >
                        <Upload className="mr-1 h-3 w-3" />
                        Upgrade
                      </Button>
                    )}
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
                      <Trash className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// PR history & pending
// ============================================================

function PrHistorySection() {
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ["pr-history"], queryFn: api.prHistoryList });
  const pending = useQuery({ queryKey: ["pending-prs"], queryFn: api.pendingPrsList });

  const refreshStatus = useMutation({
    mutationFn: ({ repo, number }: { repo: string; number: number }) =>
      api.prHistoryRefreshStatus(repo, number),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pr-history"] }),
  });
  const removeRecord = useMutation({
    mutationFn: ({ repo, number }: { repo: string; number: number }) =>
      api.prHistoryRemove(repo, number),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pr-history"] }),
  });
  const clearAll = useMutation({
    mutationFn: api.prHistoryClear,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pr-history"] }),
  });

  return (
    <div className="space-y-6">
      {pending.data && pending.data.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Pending PRs</h3>
          <div className="space-y-2">
            {pending.data.map((p) => (
              <Card key={`${p.marketplaceName}/${p.pluginName}/${p.action}`}>
                <CardContent className="flex items-center gap-2 p-3 text-sm">
                  <Badge variant="warning">{p.action}</Badge>
                  <span className="font-medium">{p.pluginName}</span>
                  <span className="text-xs text-muted-foreground">
                    in {p.marketplaceName}
                  </span>
                  {p.newVersion && (
                    <Badge variant="secondary" className="text-[10px]">
                      → v{p.newVersion}
                    </Badge>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    PR #{p.prNumber} · {shortDate(p.createdAt)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openUrl(p.prUrl)}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

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
              <CardContent className="p-6 text-sm text-muted-foreground">
                No PR history yet.
              </CardContent>
            </Card>
          )}
          {history.data?.map((r) => (
            <Card key={`${r.repo}#${r.number}`}>
              <CardContent className="flex items-center gap-2 p-3 text-sm">
                <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                <span className="font-medium">{r.title}</span>
                <Badge variant="outline" className="text-[10px]">
                  {r.kind || "—"}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {r.repo} #{r.number} · {shortDate(r.createdAt)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => openUrl(r.url)}>
                  <ExternalLink className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    refreshStatus.mutate({ repo: r.repo, number: r.number })
                  }
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
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
    <div className="flex h-full flex-col">
      <header className="border-b p-4">
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

      <ScrollArea className="flex-1">
        <div className="p-4">
          {tab === "local" && <AdminLocalPanel />}
          {tab === "remote" && <MarketplaceAdminSection onLaunch={setWizard} />}
          {tab === "history" && <PrHistorySection />}
        </div>
      </ScrollArea>

      <WizardHost active={wizard} onClose={() => setWizard(null)} />
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Trash2,
  RefreshCw,
  ShieldCheck,
  Globe,
  Sparkles,
  Upload,
  HardDrive,
  Radar,
  GitPullRequest,
  Package,
  Loader2,
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
import type { PendingPR, Plugin, RemoteSkillInfo, TrackedPr } from "@/lib/types";

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
            Aucun marketplace éditable disponible.
          </p>
          {allMarketplaces.length === 0 && (
            <p>
              Aucun marketplace enregistré pour le moment. Ajoutes-en un depuis l'onglet{" "}
              <strong>Admin local</strong> via <em>Ajouter depuis URL</em>.
            </p>
          )}
          {unconfigured.length > 0 && (
            <p>
              Ces marketplaces n'ont aucun repo GitHub configuré :{" "}
              <span className="font-mono text-foreground">
                {unconfigured.map((m) => m.name).join(", ")}
              </span>
              .
            </p>
          )}
          {githubBacked.length > 0 && (
            <p>
              Ton token GitHub n'a pas d'accès en écriture sur :{" "}
              <span className="font-mono text-foreground">
                {githubBacked.map((m) => `${m.name} (${m.sourceRepo})`).join(", ")}
              </span>
              . Utilise un token avec le scope <code>repo</code> (PAT classique) ou{" "}
              <code>Contents: write</code> + <code>Pull requests: write</code>{" "}
              (fine-grained), puis rafraîchis.
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
            placeholder="Filtrer les plugins…"
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
                  Aucun plugin listé dans ce marketplace pour le moment. Clique sur{" "}
                  <em>Ajouter un plugin</em> pour en enregistrer un.
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

  // Re-checks each pending PR on this plugin against GitHub before refreshing
  // the local data. Otherwise the "update pending" badges stick around after
  // a merge until the opt-in polling job runs (which may be disabled).
  const refreshAll = async () => {
    const items = (pending.data ?? []).filter(
      (p) => p.marketplaceName === marketplace && p.pluginName === plugin.name,
    );
    await Promise.allSettled(
      items.map((p) => api.prHistoryRefreshStatus(p.targetRepo, p.prNumber)),
    );
    qc.invalidateQueries({ queryKey: ["remote-skills", marketplace, plugin.name] });
    qc.invalidateQueries({ queryKey: ["pending-prs"] });
    qc.invalidateQueries({ queryKey: ["pr-history"] });
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
              {showSkills ? "Masquer" : "Afficher"} les skills distants
            </Button>
            {showSkills && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={refreshAll}
                disabled={remote.isFetching || pending.isFetching}
                title="Rafraîchir les skills distants (y compris les PR en attente)"
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
                  Chargement des skills distants…
                </div>
              )}
              {remote.error && (
                <div className="text-xs text-destructive">
                  {(remote.error as Error).message}
                </div>
              )}
              {merged.length === 0 && !remote.isLoading && (
                <div className="text-xs text-muted-foreground">
                  Aucun skill trouvé dans le repo source du plugin.
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
                        local : v{s.localVersion || "?"}
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
                        title={`Ouvrir la PR #${s.pending.prNumber}`}
                        onClick={() => openExternal(s.pending!.prUrl)}
                      >
                        {isDeleting
                          ? "suppression en attente"
                          : isAdding
                          ? "ajout en attente"
                          : "mise à jour en attente"}
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
                          Mettre à niveau
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
// Marketplace PR tracking ("Suivi Marketplace")
// ============================================================

function TrackedPrRow({ pr }: { pr: TrackedPr }) {
  return (
    <button
      type="button"
      onClick={() => openExternal(pr.url)}
      disabled={!pr.url}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
      title={`${pr.repo} #${pr.number} — ${pr.title}`}
    >
      <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
        #{pr.number}
      </Badge>
      <span className="min-w-0 flex-1 truncate">{pr.title || "(sans titre)"}</span>
      {pr.author && (
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          @{pr.author}
        </span>
      )}
      {pr.createdAt && (
        <span className="hidden shrink-0 whitespace-nowrap text-xs text-muted-foreground md:inline">
          {shortDate(pr.createdAt)}
        </span>
      )}
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

function TrackingSection() {
  const settingsQuery = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });
  const tracked = useQuery({
    queryKey: ["tracked-prs"],
    queryFn: () => api.trackedMarketplacePrs(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const trackedNames = useMemo(
    () =>
      (settingsQuery.data?.marketplaces ?? [])
        .filter((m) => m.trackPrs)
        .map((m) => m.name),
    [settingsQuery.data],
  );

  // Group PRs: marketplace-scoped first, then per-plugin, under each marketplace.
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      { marketplace: TrackedPr[]; plugins: Map<string, TrackedPr[]> }
    >();
    for (const name of trackedNames) {
      map.set(name, { marketplace: [], plugins: new Map() });
    }
    for (const pr of tracked.data ?? []) {
      if (!map.has(pr.marketplaceName)) {
        map.set(pr.marketplaceName, { marketplace: [], plugins: new Map() });
      }
      const g = map.get(pr.marketplaceName)!;
      if (pr.scope === "plugin") {
        const arr = g.plugins.get(pr.pluginName) ?? [];
        arr.push(pr);
        g.plugins.set(pr.pluginName, arr);
      } else {
        g.marketplace.push(pr);
      }
    }
    return map;
  }, [tracked.data, trackedNames]);

  const total = tracked.data?.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Radar className="h-4 w-4 text-primary" />
            Suivi Marketplace
            {total > 0 && <Badge variant="secondary">{total}</Badge>}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            PR ouvertes sur les marketplaces dont le <strong>Suivi PR</strong> est
            actif (onglet Admin local) et sur les repos de leurs plugins.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => tracked.refetch()}
          disabled={tracked.isFetching}
        >
          <RefreshCw
            className={`mr-1 h-3 w-3 ${tracked.isFetching ? "animate-spin" : ""}`}
          />
          Rafraîchir
        </Button>
      </div>

      {trackedNames.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <Radar className="h-8 w-8 opacity-40" />
            <span>
              Aucun marketplace suivi. Active le toggle <strong>Suivi PR</strong>{" "}
              sur un marketplace dans l'onglet <strong>Admin local</strong>.
            </span>
          </CardContent>
        </Card>
      ) : tracked.isLoading ? (
        <Card>
          <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Récupération des PR en cours…
          </CardContent>
        </Card>
      ) : tracked.error ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {(tracked.error as Error).message}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {Array.from(grouped.entries()).map(([name, g]) => {
            const count =
              g.marketplace.length +
              Array.from(g.plugins.values()).reduce((a, v) => a + v.length, 0);
            return (
              <Card key={name}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      {name}
                    </CardTitle>
                    <Badge variant={count > 0 ? "secondary" : "outline"}>
                      {count} PR
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {count === 0 ? (
                    <p className="px-2 text-xs text-muted-foreground">
                      Aucune PR ouverte sur ce marketplace ni ses plugins.
                    </p>
                  ) : (
                    <>
                      {g.marketplace.length > 0 && (
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            <GitPullRequest className="h-3 w-3" />
                            Marketplace
                          </div>
                          {g.marketplace.map((pr) => (
                            <TrackedPrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
                          ))}
                        </div>
                      )}
                      {Array.from(g.plugins.entries()).map(([plugin, prs]) => (
                        <div key={plugin} className="space-y-0.5">
                          <div className="flex items-center gap-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            <Package className="h-3 w-3" />
                            {plugin}
                          </div>
                          {prs.map((pr) => (
                            <TrackedPrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
                          ))}
                        </div>
                      ))}
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export function AdminPage() {
  const location = useLocation();
  const initialTab =
    (location.state as { tab?: "local" | "remote" | "tracking" } | null)?.tab ??
    "local";
  const [tab, setTab] = useState<"local" | "remote" | "tracking">(initialTab);
  const [wizard, setWizard] = useState<WizardKind | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Admin</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          <strong>Local</strong> — installer / désinstaller / activer des plugins sur
          ta machine. <strong>Distant</strong> — pousser des changements de registre
          vers GitHub via des Pull Requests.
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
            variant={tab === "tracking" ? "default" : "ghost"}
            onClick={() => setTab("tracking")}
          >
            <Radar className="mr-1 h-3 w-3" />
            Suivi Marketplace
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-4">
          {tab === "local" && <AdminLocalPanel />}
          {tab === "remote" && <MarketplaceAdminSection onLaunch={setWizard} />}
          {tab === "tracking" && <TrackingSection />}
        </div>
      </div>

      <WizardHost active={wizard} onClose={() => setWizard(null)} />
    </div>
  );
}

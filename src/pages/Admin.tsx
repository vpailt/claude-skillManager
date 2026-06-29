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
  Radar,
  GitPullRequest,
  Package,
  Loader2,
  Lock,
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
import { useApp } from "@/stores/app";
import { useTrackingView } from "@/stores/trackingView";
import type { PendingPR, Plugin, RemoteSkillInfo, TrackedPr } from "@/lib/types";

// Compare two dotted version strings numerically (semver-ish), falling back to
// a lexical compare on non-numeric segments. Returns -1 | 0 | 1 (a vs b). Used
// to decide whether the local copy of a skill actually differs from the repo,
// so equal versions don't render as a misleading two-badge "mismatch".
function cmpVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    const na = Number.parseInt(sa, 10);
    const nb = Number.parseInt(sb, 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      if (sa !== sb) return sa < sb ? -1 : 1;
    } else if (na !== nb) {
      return na < nb ? -1 : 1;
    }
  }
  return 0;
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
            Aucun marketplace éditable disponible.
          </p>
          {allMarketplaces.length === 0 && (
            <p>
              Aucun marketplace enregistré pour le moment. Ajoutez-en un depuis l'onglet{" "}
              <strong>Skills</strong> via <em>Ajouter depuis URL</em>.
            </p>
          )}
          {unconfigured.length > 0 && (
            <p>
              Ces marketplaces n'ont aucun repo GitHub ou Gitea configuré :{" "}
              <span className="font-mono text-foreground">
                {unconfigured.map((m) => m.name).join(", ")}
              </span>
              .
            </p>
          )}
          {githubBacked.length > 0 && (
            <p>
              Votre token (GitHub ou Gitea) n'a pas d'accès en écriture sur :{" "}
              <span className="font-mono text-foreground">
                {githubBacked.map((m) => `${m.name} (${m.sourceRepo})`).join(", ")}
              </span>
              . Sur <strong>GitHub</strong>, utilisez un token avec le scope{" "}
              <code>repo</code> (PAT classique) ou <code>Contents: write</code> +{" "}
              <code>Pull requests: write</code> (fine-grained). Sur{" "}
              <strong>Gitea</strong>, un token avec les permissions{" "}
              <code>repository</code> (read+write) et <code>pull request</code>.
              Puis rafraîchissez.
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
                  Aucun plugin listé dans ce marketplace pour le moment. Cliquez sur{" "}
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
          // For an in-review add-skill row, show the skill's own SKILL.md
          // version, not the plugin's bumped manifest version. Older pending
          // records predate skillVersion, so fall back to newVersion.
          name,
          version: p.skillVersion || p.newVersion,
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
                      <Badge
                        variant="outline"
                        className="text-xs"
                        title="Version déclarée dans le SKILL.md du repo du plugin (branche par défaut)"
                      >
                        v{s.version}
                      </Badge>
                    )}
                    {s.localFolder &&
                      (() => {
                        const remoteV = (s.version ?? "").trim();
                        const localV = (s.localVersion ?? "").trim();
                        if (!localV) {
                          return (
                            <Badge
                              variant="outline"
                              className="text-xs"
                              title="Présent dans ~/.claude/skills sans champ version dans le SKILL.md"
                            >
                              local : v?
                            </Badge>
                          );
                        }
                        if (!remoteV) {
                          return (
                            <Badge
                              variant="outline"
                              className="text-xs"
                              title={`Copie locale (~/.claude/skills) — v${localV}`}
                            >
                              local : v{localV}
                            </Badge>
                          );
                        }
                        const cmp = cmpVersions(localV, remoteV);
                        if (cmp === 0) {
                          return (
                            <Badge
                              variant="success"
                              className="text-xs"
                              title={`Copie locale (~/.claude/skills) à jour — v${localV}`}
                            >
                              local à jour
                            </Badge>
                          );
                        }
                        return (
                          <Badge
                            variant="warning"
                            className="text-xs"
                            title={`Copie locale (~/.claude/skills) v${localV} — diffère du repo (v${remoteV})`}
                          >
                            local : v{localV} {cmp > 0 ? "⬆" : "⬇"}
                          </Badge>
                        );
                      })()}
                    {inReview && s.pending && (
                      <button
                        type="button"
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium hover:underline ${
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
      <Badge variant="outline" className="shrink-0 font-mono text-xs">
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

// Group a flat PR list by marketplace, marketplace-scoped first then per-plugin.
// Only marketplaces actually present in `prs` get a group (no empty seeding) —
// each role section shows just the marketplaces with PRs in that role.
function groupPrs(prs: TrackedPr[]) {
  const map = new Map<
    string,
    { marketplace: TrackedPr[]; plugins: Map<string, TrackedPr[]> }
  >();
  for (const pr of prs) {
    let g = map.get(pr.marketplaceName);
    if (!g) {
      g = { marketplace: [], plugins: new Map() };
      map.set(pr.marketplaceName, g);
    }
    if (pr.scope === "plugin") {
      const arr = g.plugins.get(pr.pluginName) ?? [];
      arr.push(pr);
      g.plugins.set(pr.pluginName, arr);
    } else {
      g.marketplace.push(pr);
    }
  }
  return map;
}

// Renders one Card per marketplace, with marketplace- then plugin-scoped PRs.
// Shared by both "Mes demandes" and "Demandes à valider".
function GroupedPrCards({ prs }: { prs: TrackedPr[] }) {
  const grouped = useMemo(() => groupPrs(prs), [prs]);
  return (
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
              {g.marketplace.length > 0 && (
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <GitPullRequest className="h-3 w-3" />
                    Marketplace
                  </div>
                  {g.marketplace.map((pr) => (
                    <TrackedPrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
                  ))}
                </div>
              )}
              {Array.from(g.plugins.entries()).map(([plugin, prs2]) => (
                <div key={plugin} className="space-y-0.5">
                  <div className="flex items-center gap-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <Package className="h-3 w-3" />
                    {plugin}
                  </div>
                  {prs2.map((pr) => (
                    <TrackedPrRow key={`${pr.repo}#${pr.number}`} pr={pr} />
                  ))}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
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

  // Flag this view as active while mounted so the sidebar Refresh button also
  // refreshes the PR tracking here (this tab has no dedicated refresh button).
  const setTrackingActive = useTrackingView((s) => s.setActive);
  useEffect(() => {
    setTrackingActive(true);
    return () => setTrackingActive(false);
  }, [setTrackingActive]);

  // Review rights = push/maintain/admin on a tracked repo (the `editable` flag
  // from the forge token's permissions). Used only to decide whether to show
  // the "Demandes à valider" section when its queue is currently empty.
  const appMarketplaces = useApp((s) => s.marketplaces);

  const trackedNames = useMemo(
    () =>
      (settingsQuery.data?.marketplaces ?? [])
        .filter((m) => m.trackPrs)
        .map((m) => m.name),
    [settingsQuery.data],
  );

  const all = tracked.data ?? [];
  // "Mes demandes" = PRs I opened; "Demandes à valider" = others' PRs I can
  // approve (per the backend's hybrid branch-protection / push-rights check).
  const mine = useMemo(() => all.filter((p) => p.mine), [all]);
  const toValidate = useMemo(
    () => all.filter((p) => !p.mine && p.canApprove),
    [all],
  );
  // Leftovers: PRs by others on a repo you only *watch* (track_prs) without
  // approval rights. Kept visible (read-only) so the header count and the
  // sections stay consistent; empty for any marketplace you maintain.
  const others = useMemo(
    () => all.filter((p) => !p.mine && !p.canApprove),
    [all],
  );

  // Show "Demandes à valider" when there is something to review now, or when the
  // user has approval rights somewhere (so the empty queue is still visible and
  // explains itself, rather than the whole section silently vanishing).
  const hasReviewRights = useMemo(
    () => toValidate.length > 0 || appMarketplaces.some((m) => m.editable),
    [toValidate.length, appMarketplaces],
  );

  const total = all.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Radar className="h-4 w-4 text-primary" />
            Suivi Marketplace
            {total > 0 && <Badge variant="secondary">{total}</Badge>}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            PR ouvertes sur les marketplaces dont le <strong>Suivi PR</strong> est
            actif (onglet Skills, en cliquant sur un marketplace) et sur les repos
            de leurs plugins. Utilisez <strong>Rafraîchir</strong> (barre de gauche)
            pour actualiser.
          </p>
        </div>
        {tracked.isFetching && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Actualisation…
          </span>
        )}
      </div>

      {trackedNames.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <Radar className="h-8 w-8 opacity-40" />
            <span>
              Aucun marketplace suivi. Activez le toggle <strong>Suivi PR</strong>{" "}
              sur un marketplace dans l'onglet <strong>Skills</strong>.
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
        <>
          <section className="space-y-3">
            <h4 className="flex items-center gap-2 text-sm font-semibold">
              <GitPullRequest className="h-4 w-4 text-sky-500" />
              Mes demandes
              {mine.length > 0 && (
                <Badge variant="secondary">{mine.length}</Badge>
              )}
            </h4>
            {mine.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">
                Vous n'avez aucune PR ouverte sur les marketplaces suivis.
              </p>
            ) : (
              <GroupedPrCards prs={mine} />
            )}
          </section>

          {hasReviewRights && (
            <section className="space-y-3">
              <div>
                <h4 className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  Demandes à valider
                  {toValidate.length > 0 && (
                    <Badge variant="secondary">{toValidate.length}</Badge>
                  )}
                </h4>
                <p className="mt-1 px-1 text-xs text-muted-foreground">
                  PR ouvertes par d'autres que vous pouvez approuver (selon la
                  règle de protection de branche, sinon vos droits de push).
                </p>
              </div>
              {toValidate.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">
                  Aucune PR en attente de votre validation.
                </p>
              ) : (
                <GroupedPrCards prs={toValidate} />
              )}
            </section>
          )}

          {others.length > 0 && (
            <section className="space-y-3">
              <div>
                <h4 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                  <Lock className="h-4 w-4" />
                  Autres PR suivies
                  <Badge variant="outline">{others.length}</Badge>
                </h4>
                <p className="mt-1 px-1 text-xs text-muted-foreground">
                  PR sur des marketplaces que vous suivez sans droit de
                  validation (lecture seule).
                </p>
              </div>
              <GroupedPrCards prs={others} />
            </section>
          )}
        </>
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
    (location.state as { tab?: "remote" | "tracking" } | null)?.tab ?? "remote";
  const [tab, setTab] = useState<"remote" | "tracking">(initialTab);
  const [wizard, setWizard] = useState<WizardKind | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Administration</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          <strong>Proposer une amélioration</strong> — pousser des changements de
          registre vers GitHub ou Gitea via des Pull Requests.{" "}
          <strong>Suivi Marketplace</strong> — suivre les PR ouvertes. (La gestion
          locale des marketplaces et plugins se fait désormais dans l'onglet{" "}
          <strong>Skills</strong>.)
        </p>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant={tab === "remote" ? "default" : "ghost"}
            onClick={() => setTab("remote")}
          >
            <Globe className="mr-1 h-3 w-3" />
            Proposer une amélioration
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
          {tab === "remote" && <MarketplaceAdminSection onLaunch={setWizard} />}
          {tab === "tracking" && <TrackingSection />}
        </div>
      </div>

      <WizardHost active={wizard} onClose={() => setWizard(null)} />
    </div>
  );
}

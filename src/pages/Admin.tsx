import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  ShieldCheck,
  Globe,
  Radar,
  GitPullRequest,
  Package,
  Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { openExternal, shortDate } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { useTrackingView } from "@/stores/trackingView";
import type { TrackedPr } from "@/lib/types";

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
            Suivi marketplace
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

        </>
      )}
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export function AdminPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b p-4">
        <div className="flex items-center gap-2">
          <Radar className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Suivi marketplace</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Les Pull Requests ouvertes sur les marketplaces que vous suivez et sur
          leurs plugins. Pour proposer un changement, passez par l'onglet{" "}
          <strong>Changements</strong> ; la gestion locale des marketplaces et
          des plugins se fait dans l'onglet <strong>Skills</strong>.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-4">
          <TrackingSection />
        </div>
      </div>
    </div>
  );
}

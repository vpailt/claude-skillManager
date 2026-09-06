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
import { PAGE_HEADER } from "@/lib/headerStyles";
import { cn, openExternal, shortDate } from "@/lib/utils";
import { useApp } from "@/stores/app";
import { useTrackingView } from "@/stores/trackingView";
import type { TrackedPr } from "@/lib/types";
import { ScrollFade } from "@/components/ScrollFade";

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

/** One of the page's three blocks: a named, outlined region rather than a bare
 *  heading — what tells "Mes demandes" apart from "Suivi" is the box, not the
 *  weight of a word. */
function Section({
  icon: Icon,
  iconClassName,
  title,
  count,
  busy,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  title: string;
  count?: number;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card/30">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Icon className={cn("h-4 w-4 shrink-0", iconClassName ?? "text-primary")} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h3>
        {busy && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Actualisation…
          </span>
        )}
        {count !== undefined && count > 0 && (
          <Badge variant="secondary" className="shrink-0">
            {count}
          </Badge>
        )}
      </div>
      <div className="p-3">{children}</div>
    </section>
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
    // Same staleness as the dashboard's summary: one key with two different
    // staleTimes refetches on whichever observer is the most aggressive, so the
    // shorter one here made every visit to either view pay for the tracking.
    staleTime: 5 * 60_000,
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
    <div className="space-y-4">
      {/* Three sections, three questions: what is being watched, what I asked
          for, what is waiting on me. They used to run together as one column of
          headings, and the second and third read as sub-parts of the first. */}
      <Section
        icon={Radar}
        title="Suivi"
        count={trackedNames.length}
        busy={tracked.isFetching}
      >
        <p className="text-xs text-muted-foreground">
          PR ouvertes sur les marketplaces dont le <strong>Suivi PR</strong> est
          actif (onglet Skills, en cliquant sur un marketplace) et sur les repos
          de leurs plugins. Utilisez <strong>Rafraîchir</strong> (barre de
          gauche) pour actualiser.
        </p>
        {trackedNames.length === 0 ? (
          <div className="mt-3 flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
            <Radar className="h-8 w-8 opacity-40" />
            <span>
              Aucun marketplace suivi. Activez le toggle{" "}
              <strong>Suivi PR</strong> sur un marketplace dans l'onglet{" "}
              <strong>Skills</strong>.
            </span>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {trackedNames.map((n) => (
              <Badge key={n} variant="secondary" className="gap-1">
                <Globe className="h-3 w-3" />
                {n}
              </Badge>
            ))}
            <Badge variant="outline">
              {total} PR ouverte{total > 1 ? "s" : ""}
            </Badge>
          </div>
        )}
        {tracked.isLoading && (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Récupération des PR en cours…
          </div>
        )}
        {tracked.error && (
          <div className="mt-3 text-sm text-destructive">
            {(tracked.error as Error).message}
          </div>
        )}
      </Section>

      {trackedNames.length > 0 && !tracked.isLoading && !tracked.error && (
        <>
          <Section
            icon={GitPullRequest}
            iconClassName="text-sky-500"
            title="Mes demandes"
            count={mine.length}
          >
            {mine.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Vous n'avez aucune PR ouverte sur les marketplaces suivis.
              </p>
            ) : (
              <GroupedPrCards prs={mine} />
            )}
          </Section>

          {hasReviewRights && (
            <Section
              icon={ShieldCheck}
              iconClassName="text-emerald-600 dark:text-emerald-400"
              title="Demandes à valider"
              count={toValidate.length}
            >
              <p className="mb-3 text-xs text-muted-foreground">
                PR ouvertes par d'autres que vous pouvez approuver (selon la
                règle de protection de branche, sinon vos droits de push).
              </p>
              {toValidate.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Aucune PR en attente de votre validation.
                </p>
              ) : (
                <GroupedPrCards prs={toValidate} />
              )}
            </Section>
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
    <div className="panel flex h-full min-h-0 flex-col">
      <div className={PAGE_HEADER}>
        <Radar className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="shrink-0 text-sm font-semibold">Suivi marketplace</h2>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          Les PR ouvertes sur les marketplaces suivis et leurs plugins — pour
          proposer un changement, passez par l'onglet Changements.
        </span>
      </div>

      <ScrollFade className="flex-1">
        <div className="p-4">
          <TrackingSection />
        </div>
      </ScrollFade>
    </div>
  );
}

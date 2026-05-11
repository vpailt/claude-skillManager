import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/stores/app";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Activity, Package, Sparkles, Globe } from "lucide-react";

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

export function OverviewPage() {
  const navigate = useNavigate();
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  const setSelection = useApp((s) => s.setSelection);

  const totalPlugins = marketplaces.reduce((acc, m) => acc + m.plugins.length, 0);
  const installedPlugins = marketplaces
    .flatMap((m) => m.plugins)
    .filter((p) => p.installState === "installed" || p.installState === "outdated").length;
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
    <div className="h-full overflow-auto p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Snapshot of your Claude Code plugins, skills and marketplaces.
        </p>
      </header>
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
              <span className="text-base font-normal">
                @{auth.data[1]}
              </span>
            ) : (
              <span className="text-base font-normal text-muted-foreground">no token</span>
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

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Marketplaces</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{m.name}</CardTitle>
                  {m.installed ? (
                    <Badge variant="success">installed</Badge>
                  ) : (
                    <Badge variant="outline">not installed</Badge>
                  )}
                </div>
                <CardDescription>
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
  );
}

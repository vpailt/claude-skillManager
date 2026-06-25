import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Sparkles,
  ShieldCheck,
  Settings,
  Sun,
  Moon,
  MonitorSmartphone,
  RefreshCw,
  ChevronsLeft,
  ChevronsRight,
  Search,
  HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { HelpDialog } from "@/components/HelpDialog";
import { useAppVersion } from "@/hooks/useAppVersion";
import { useHelpDialog } from "@/stores/helpDialog";
import { useSettingsDialog } from "@/stores/settingsDialog";

interface NavItem {
  to: string;
  label: string;
  subtitle: string;
  tooltip: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  {
    to: "/",
    label: "Dashboard",
    subtitle: "Aperçu & état",
    tooltip: "Dashboard — vue d'ensemble globale, mises à jour récentes, état des plugins",
    icon: LayoutDashboard,
  },
  {
    to: "/skills",
    label: "Skills",
    subtitle: "Installer et parcourir",
    tooltip: "Skills — vue unifiée Marketplace → Plugin → Skills : installer/activer les plugins, parcourir le contenu SKILL.md, gérer doublons & archivés, filtrer par état d'installation",
    icon: Sparkles,
  },
  {
    to: "/admin",
    label: "Administration",
    subtitle: "PR vers les marketplaces",
    tooltip: "Administration — proposer des changements aux marketplaces via des pull requests GitHub",
    icon: ShieldCheck,
  },
];

const THEME_CYCLE = ["light", "dark", "auto"] as const;

const THEME_TOOLTIP: Record<(typeof THEME_CYCLE)[number], string> = {
  light: "Thème : clair — clic pour sombre",
  dark: "Thème : sombre — clic pour auto",
  auto: "Thème : auto (suit l'OS) — clic pour clair",
};

export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const qc = useQueryClient();
  const collapsed = useUi((s) => s.ui.sidebarCollapsed);
  const theme = useUi((s) => s.ui.theme);
  const patch = useUi((s) => s.patch);
  const helpOpen = useHelpDialog((s) => s.open);
  const setHelpOpen = useHelpDialog((s) => s.setOpen);
  const openSettings = useSettingsDialog((s) => s.openTo);
  const version = useAppVersion();
  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(theme);
    patch({ theme: THEME_CYCLE[(idx + 1) % THEME_CYCLE.length] });
  };

  const isRefreshing = useIsFetching({ queryKey: ["refresh"] }) > 0;

  const rate = useQuery({
    queryKey: ["github-rate"],
    queryFn: api.githubRateLimit,
    staleTime: 60_000,
  });
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

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r bg-card/40 transition-[width] duration-150",
        collapsed ? "w-14" : "w-60"
      )}
    >
      {/* Brand */}
      <div className="flex items-center gap-2 px-3 py-4">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold">SkillManager</div>
            <div className="text-xs text-muted-foreground">Claude Code</div>
          </div>
        )}
      </div>

      <Separator />

      {/* Actions: Search + Refresh — separated from navigation */}
      <div
        className={cn(
          "space-y-1 py-2",
          collapsed ? "px-2" : "px-2"
        )}
      >
        <button
          type="button"
          title="Ouvrir la palette de commandes (Ctrl+K) — accédez à tout"
          onClick={onOpenPalette}
          className={cn(
            "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            collapsed && "justify-center px-0"
          )}
        >
          <Search className="h-4 w-4 shrink-0" />
          {!collapsed && (
            <>
              <span>Rechercher</span>
              <kbd className="ml-auto rounded border px-1 text-xs">⌃K</kbd>
            </>
          )}
        </button>
        <button
          type="button"
          title={
            isRefreshing
              ? "Rafraîchissement…"
              : "Rafraîchir — re-scanne l'installation locale et GitHub (quota limité)"
          }
          onClick={() => qc.invalidateQueries({ queryKey: ["refresh"] })}
          className={cn(
            "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            collapsed && "justify-center px-0"
          )}
        >
          <RefreshCw
            className={cn("h-4 w-4 shrink-0", isRefreshing && "animate-spin")}
          />
          {!collapsed && <span>Rafraîchir</span>}
        </button>
      </div>

      <Separator />

      {/* Navigation */}
      {!collapsed && (
        <div className="px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
          Naviguer
        </div>
      )}
      <nav className={cn("flex-1 space-y-0.5 py-2", collapsed ? "px-2" : "px-2")}>
        {NAV.map(({ to, label, subtitle, tooltip, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            title={collapsed ? tooltip : tooltip}
            className={({ isActive }) =>
              cn(
                "flex items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                collapsed && "items-center justify-center px-0 py-2",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0 self-center" />
            {!collapsed && (
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate font-medium">{label}</div>
                <div className="truncate text-xs text-muted-foreground/80">
                  {subtitle}
                </div>
              </div>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Forge connection status (only when expanded) */}
      {!collapsed &&
        (auth.data || rate.data || (gitea.data?.length ?? 0) > 0) && (
          <>
            <Separator />
            <div className="space-y-1 px-3 py-2 text-xs text-muted-foreground">
              {auth.data && (
                <div
                  className="truncate"
                  title={auth.data[0] ? `GitHub : authentifié en tant que @${auth.data[1]}` : "Aucun token GitHub configuré (Paramètres)"}
                >
                  GitHub : {auth.data[0] ? `@${auth.data[1]}` : "pas de token"}
                </div>
              )}
              {rate.data &&
                rate.data[0] >= 0 &&
                rate.data[1] > 0 &&
                rate.data[0] < Math.max(50, rate.data[1] * 0.1) && (
                  <div
                    className="text-amber-500"
                    title="Quota d'appels à l'API GitHub bientôt épuisé — il se réinitialise au début de l'heure suivante"
                  >
                    GitHub : quota bas ({rate.data[0]}/{rate.data[1]})
                  </div>
                )}
              {(gitea.data ?? []).map((g) => (
                <div
                  key={g.baseUrl}
                  className="truncate"
                  title={
                    g.ok
                      ? `Gitea ${g.host} : authentifié en tant que @${g.user}${
                          g.insecureTls ? " (vérification TLS désactivée)" : ""
                        }`
                      : `Gitea ${g.host} : ${g.user}`
                  }
                >
                  {g.host}:{" "}
                  {g.ok ? `@${g.user}` : g.hasToken ? "échec auth" : "pas de token"}
                </div>
              ))}
            </div>
          </>
        )}

      <Separator />

      {/* Utilities cluster: Settings, Help, Theme, Collapse */}
      <div
        className={cn(
          "flex items-center gap-1 px-2 py-2",
          collapsed ? "flex-col" : "justify-between px-3"
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={() => openSettings("general")}
          title="Paramètres — token, polling, logs, thème"
          aria-label="Paramètres"
        >
          <Settings className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setHelpOpen(true)}
          title="Aide — guide & raccourcis"
          aria-label="Aide"
        >
          <HelpCircle className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={cycleTheme}
          title={THEME_TOOLTIP[theme]}
          aria-label="Changer de thème"
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : theme === "light" ? (
            <Moon className="h-4 w-4" />
          ) : (
            <MonitorSmartphone className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => patch({ sidebarCollapsed: !collapsed })}
          title={collapsed ? "Déplier la barre" : "Replier la barre en icônes"}
          aria-label={collapsed ? "Déplier la barre" : "Replier la barre"}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <ChevronsLeft className="h-4 w-4" />
          )}
        </Button>
      </div>
      {!collapsed && (
        <div className="px-3 pb-2 text-center text-xs text-muted-foreground/60">
          <div>Conçu par @vpailt</div>
          {version && <div>v{version}</div>}
        </div>
      )}
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </aside>
  );
}

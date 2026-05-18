import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Package,
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
    subtitle: "Overview & status",
    tooltip: "Dashboard — global snapshot, recent updates, plugin status",
    icon: LayoutDashboard,
  },
  {
    to: "/plugins",
    label: "Plugins",
    subtitle: "Install & enable",
    tooltip: "Plugins — install, update, enable/disable, uninstall",
    icon: Package,
  },
  {
    to: "/skills",
    label: "Skills",
    subtitle: "Browse & read",
    tooltip: "Skills — browse SKILL.md content, manage duplicates & archived",
    icon: Sparkles,
  },
  {
    to: "/admin",
    label: "Administration",
    subtitle: "PRs to marketplaces",
    tooltip: "Administration — propose changes to marketplaces via GitHub pull requests",
    icon: ShieldCheck,
  },
];

const THEME_CYCLE = ["light", "dark", "auto"] as const;

const THEME_TOOLTIP: Record<(typeof THEME_CYCLE)[number], string> = {
  light: "Theme: light — click for dark",
  dark: "Theme: dark — click for auto",
  auto: "Theme: auto (follow OS) — click for light",
};

export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const qc = useQueryClient();
  const collapsed = useUi((s) => s.ui.sidebarCollapsed);
  const theme = useUi((s) => s.ui.theme);
  const patch = useUi((s) => s.patch);
  const [helpOpen, setHelpOpen] = useState(false);
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
          title="Open command palette (Ctrl+K) — jump to anything"
          onClick={onOpenPalette}
          className={cn(
            "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            collapsed && "justify-center px-0"
          )}
        >
          <Search className="h-4 w-4 shrink-0" />
          {!collapsed && (
            <>
              <span>Search</span>
              <kbd className="ml-auto rounded border px-1 text-[10px]">⌃K</kbd>
            </>
          )}
        </button>
        <button
          type="button"
          title={
            isRefreshing
              ? "Refreshing…"
              : "Refresh — re-scan local install and GitHub (rate-limited)"
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
          {!collapsed && <span>Refresh</span>}
        </button>
      </div>

      <Separator />

      {/* Navigation */}
      {!collapsed && (
        <div className="px-4 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Navigate
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
                <div className="truncate text-[11px] text-muted-foreground/80">
                  {subtitle}
                </div>
              </div>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          title="Help — what each section does and where data lives"
          className={cn(
            "flex w-full items-start gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            collapsed && "items-center justify-center px-0 py-2"
          )}
        >
          <HelpCircle className="h-4 w-4 shrink-0 self-center" />
          {!collapsed && (
            <div className="min-w-0 flex-1 leading-tight text-left">
              <div className="truncate font-medium">Help</div>
              <div className="truncate text-[11px] text-muted-foreground/80">
                Guide & shortcuts
              </div>
            </div>
          )}
        </button>
      </nav>

      {/* GitHub status (only when expanded) */}
      {!collapsed && (auth.data || rate.data) && (
        <>
          <Separator />
          <div className="space-y-1 px-3 py-2 text-[11px] text-muted-foreground">
            {auth.data && (
              <div
                className="truncate"
                title={auth.data[0] ? `Authenticated as @${auth.data[1]}` : "No GitHub token configured (Settings)"}
              >
                {auth.data[0] ? `@${auth.data[1]}` : "no token"}
              </div>
            )}
            {rate.data && rate.data[0] >= 0 && (
              <div title="Remaining GitHub API requests / total quota for this hour">
                GitHub: {rate.data[0]}/{rate.data[1]}
              </div>
            )}
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
        <NavLink to="/settings" title="Settings — token, polling, logging, theme">
          {({ isActive }) => (
            <Button
              variant="ghost"
              size="icon"
              className={cn(isActive && "bg-accent")}
              aria-label="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
        </NavLink>
        <Button
          variant="ghost"
          size="icon"
          onClick={cycleTheme}
          title={THEME_TOOLTIP[theme]}
          aria-label="Cycle theme"
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
          title={collapsed ? "Expand sidebar" : "Collapse sidebar to icons"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <ChevronsLeft className="h-4 w-4" />
          )}
        </Button>
      </div>
      {!collapsed && (
        <div className="px-3 pb-2 text-center text-[10px] text-muted-foreground/60">
          <div>Designed by @vpailt</div>
          {version && <div>v{version}</div>}
        </div>
      )}
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </aside>
  );
}

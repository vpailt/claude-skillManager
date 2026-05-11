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

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/plugins", label: "Plugins", icon: Package },
  { to: "/skills", label: "Skills", icon: Sparkles },
  { to: "/admin", label: "Admin", icon: ShieldCheck },
];

const THEME_CYCLE = ["light", "dark", "auto"] as const;

export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const qc = useQueryClient();
  const collapsed = useUi((s) => s.ui.sidebarCollapsed);
  const theme = useUi((s) => s.ui.theme);
  const patch = useUi((s) => s.patch);
  const [helpOpen, setHelpOpen] = useState(false);
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
        collapsed ? "w-14" : "w-56"
      )}
    >
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
      <nav className={cn("flex-1 space-y-1 py-3", collapsed ? "px-2" : "px-2")}>
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                collapsed && "justify-center px-0",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && label}
          </NavLink>
        ))}
        <button
          type="button"
          title="Search (Ctrl+K)"
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
      </nav>
      <Separator />
      {!collapsed && (
        <div className="space-y-1 px-3 py-2 text-[11px] text-muted-foreground">
          {auth.data && (
            <div className="truncate">
              {auth.data[0] ? `@${auth.data[1]}` : "no token"}
            </div>
          )}
          {rate.data && rate.data[0] >= 0 && (
            <div>
              GitHub: {rate.data[0]}/{rate.data[1]}
            </div>
          )}
        </div>
      )}
      <Separator />
      <div
        className={cn(
          "flex items-center gap-1 px-2 py-2",
          collapsed ? "flex-col" : "justify-between px-3"
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={() => qc.invalidateQueries({ queryKey: ["refresh"] })}
          title={isRefreshing ? "Refreshing…" : "Refresh all"}
        >
          <RefreshCw
            className={cn("h-4 w-4", isRefreshing && "animate-spin")}
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setHelpOpen(true)}
          title="Help — how the app works"
        >
          <HelpCircle className="h-4 w-4" />
        </Button>
        <NavLink to="/settings" title="Settings">
          {({ isActive }) => (
            <Button
              variant="ghost"
              size="icon"
              className={cn(isActive && "bg-accent")}
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
        </NavLink>
        <Button
          variant="ghost"
          size="icon"
          onClick={cycleTheme}
          title={`Theme: ${theme} (click to cycle)`}
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
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
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
          Designed by Valentin
        </div>
      )}
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </aside>
  );
}

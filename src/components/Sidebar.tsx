import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Package,
  Sparkles,
  ShieldCheck,
  Settings,
  Sun,
  Moon,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useTheme } from "@/stores/theme";
import { useQueryClient } from "@tanstack/react-query";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/plugins", label: "Plugins", icon: Package },
  { to: "/skills", label: "Skills", icon: Sparkles },
  { to: "/admin", label: "Admin", icon: ShieldCheck },
];

export function Sidebar() {
  const { theme, toggle } = useTheme();
  const qc = useQueryClient();

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-card/40">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">SkillManager</div>
          <div className="text-xs text-muted-foreground">Claude Code</div>
        </div>
      </div>
      <Separator />
      <nav className="flex-1 space-y-1 px-2 py-3">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </nav>
      <Separator />
      <div className="flex items-center justify-between px-3 py-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => qc.invalidateQueries({ queryKey: ["refresh"] })}
          title="Refresh all"
        >
          <RefreshCw className="h-4 w-4" />
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
        <Button variant="ghost" size="icon" onClick={toggle} title="Toggle theme">
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>
      </div>
    </aside>
  );
}

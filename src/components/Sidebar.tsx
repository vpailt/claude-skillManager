import { useCallback, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Sparkles,
  Radar,
  BarChart3,
  UploadCloud,
  Settings,
  Sun,
  Moon,
  MonitorSmartphone,
  RefreshCw,
  History,
  ScrollText,
  ChevronsLeft,
  ChevronsRight,
  Search,
  HelpCircle,
  ArrowUpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { HelpDialog } from "@/components/HelpDialog";
import { useHelpDialog } from "@/stores/helpDialog";
import { useSettingsDialog } from "@/stores/settingsDialog";
import { useTrackingView } from "@/stores/trackingView";
import { useAppUpdate } from "@/stores/appUpdate";
import { usePendingChangesCount } from "@/lib/changes";
import { forceRefresh } from "@/hooks/useRefresh";
import { restartNow } from "@/hooks/useAppUpdateEvents";

interface NavItem {
  to: string;
  label: string;
  subtitle: string;
  tooltip: string;
  icon: typeof LayoutDashboard;
}

interface NavGroup {
  /** Section heading, or null for the lone entry that needs none. */
  title: string | null;
  items: NavItem[];
}

// Four sections, because the tabs answer four different questions and used to
// sit in one undifferentiated list: where do I stand, what is installed here,
// what do I owe the forge, and what happened. The headings are what make the
// last two tell themselves apart — "Audit d'utilisation" and "Changements" read
// as neighbours in a flat list, and they have nothing to do with each other.
const NAV: NavGroup[] = [
  {
    title: null,
    items: [
      {
        to: "/",
        label: "Dashboard",
        subtitle: "Aperçu & état",
        tooltip:
          "Dashboard — vue d'ensemble globale, mises à jour récentes, état des plugins",
        icon: LayoutDashboard,
      },
    ],
  },
  {
    title: "En local",
    items: [
      {
        to: "/skills",
        label: "Skills",
        subtitle: "Installer et parcourir",
        tooltip:
          "Skills — vue unifiée Marketplace → Plugin → Skills : installer/activer les plugins, parcourir le contenu SKILL.md, gérer doublons & archivés, filtrer par état d'installation",
        icon: Sparkles,
      },
    ],
  },
  {
    title: "En ligne",
    items: [
      {
        to: "/changes",
        label: "Changements",
        subtitle: "Compétences à publier",
        tooltip:
          "Changements — compétences modifiées, ajoutées ou supprimées localement, groupées par plugin : une PR par plugin, diff à l'appui",
        icon: UploadCloud,
      },
      {
        to: "/tracking",
        label: "Suivi marketplace",
        subtitle: "PR ouvertes à suivre",
        tooltip:
          "Suivi marketplace — les Pull Requests ouvertes sur les marketplaces que vous suivez et sur leurs plugins",
        icon: Radar,
      },
    ],
  },
  {
    title: "Traçabilité",
    items: [
      {
        to: "/audit",
        label: "Audit d'utilisation",
        subtitle: "Usage réel des plugins & skills",
        tooltip:
          "Audit d'utilisation — top plugins, plugins non utilisés et détail des skills (nb d'utilisations + projets), sur une plage de dates, avec export Excel. Reconstruit depuis les transcripts de session locaux.",
        icon: BarChart3,
      },
      {
        to: "/activity",
        label: "Activité récente",
        subtitle: "Ce que l'app a fait",
        tooltip:
          "Activité récente — installations, désinstallations, PR, exports et mises à jour, horodatés, filtrables, avec vidage de l'historique. La version complète de la carte du dashboard.",
        icon: History,
      },
      {
        to: "/logs",
        label: "Logs",
        subtitle: "Journaux de l'application",
        tooltip:
          "Logs — le contenu des fichiers de journal de l'application, un par jour : filtre par niveau, par plage horaire et recherche plein texte",
        icon: ScrollText,
      },
    ],
  },
];

const THEME_CYCLE = ["light", "dark", "auto"] as const;

const THEME_TOOLTIP: Record<(typeof THEME_CYCLE)[number], string> = {
  light: "Thème : clair — clic pour sombre",
  dark: "Thème : sombre — clic pour auto",
  auto: "Thème : auto (suit l'OS) — clic pour clair",
};

/** Icon-only width — what the old `w-14` was. */
const COLLAPSED_WIDTH = 56;
/** Drag below this and releasing collapses the bar: the handle *is* the
 *  collapse control, the button in the footer is only the shortcut. */
const COLLAPSE_THRESHOLD = 140;
/** Narrowest the bar can be while still showing labels. Between the threshold
 *  and here it snaps up to this, so collapsing takes a deliberate further 40 px
 *  instead of happening on the wobble that ends every drag. */
const SNAP_WIDTH = 180;
const MAX_WIDTH = 380;
/** What the bar opens at, and what `w-60` used to hard-code. */
export const DEFAULT_SIDEBAR_WIDTH = 240;

interface DragState {
  collapsed: boolean;
  width: number;
}

/**
 * What the bar should look like with the pointer `x` pixels from its left edge.
 * The snap zone resolves *upwards* — you cross it to collapse, you never drift
 * into a 150 px bar whose labels are all ellipses.
 */
function resolveWidth(x: number): DragState {
  if (x < COLLAPSE_THRESHOLD) return { collapsed: true, width: COLLAPSED_WIDTH };
  if (x < SNAP_WIDTH) return { collapsed: false, width: SNAP_WIDTH };
  return { collapsed: false, width: Math.min(Math.round(x), MAX_WIDTH) };
}

export function Sidebar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const pendingChanges = usePendingChangesCount();
  const qc = useQueryClient();
  const collapsed = useUi((s) => s.ui.sidebarCollapsed);
  const storedWidth = useUi((s) => s.ui.sidebarWidth);
  const theme = useUi((s) => s.ui.theme);
  const patch = useUi((s) => s.patch);
  const patchPersisted = useUi((s) => s.patchPersisted);
  const helpOpen = useHelpDialog((s) => s.open);
  const setHelpOpen = useHelpDialog((s) => s.setOpen);
  const openSettings = useSettingsDialog((s) => s.openTo);
  const staged = useAppUpdate((s) => s.staged);
  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(theme);
    patch({ theme: THEME_CYCLE[(idx + 1) % THEME_CYCLE.length] });
  };

  const isRefreshing = useIsFetching({ queryKey: ["refresh"] }) > 0;

  // Live drag, held locally: the store write (and with it localStorage) happens
  // once, on release. `drag` is also what tells the handle it is active.
  const [drag, setDrag] = useState<DragState | null>(null);
  const asideRef = useRef<HTMLElement>(null);

  const expandedWidth = Math.min(
    Math.max(storedWidth || DEFAULT_SIDEBAR_WIDTH, SNAP_WIDTH),
    MAX_WIDTH
  );
  const shownCollapsed = drag ? drag.collapsed : collapsed;
  const shownWidth = drag
    ? drag.width
    : collapsed
      ? COLLAPSED_WIDTH
      : expandedWidth;

  // Collapsing deliberately leaves `sidebarWidth` alone, so re-opening the bar
  // returns it to the width the user had chosen rather than to the default.
  // Persisted, not merely stored: this bar's geometry has to survive the window
  // being rebuilt, which tray mode does on every close.
  const commit = useCallback(
    (d: DragState) => {
      // A click on the handle that moved nothing, or a drag that ended where it
      // started, is not a change: without this it would still cost a settings
      // write on every press.
      if (d.collapsed === collapsed && (d.collapsed || d.width === expandedWidth))
        return;
      if (d.collapsed) patchPersisted({ sidebarCollapsed: true });
      else patchPersisted({ sidebarCollapsed: false, sidebarWidth: d.width });
    },
    [patchPersisted, collapsed, expandedWidth]
  );

  const widthAtPointer = (clientX: number) =>
    clientX - (asideRef.current?.getBoundingClientRect().left ?? 0);

  const onHandleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      // From the collapsed state the only meaningful step is "open again" —
      // nudging 20 px at a time through the threshold would take six presses
      // to do nothing visible.
      if (shownCollapsed) {
        if (e.key === "ArrowRight")
          commit({ collapsed: false, width: expandedWidth });
        return;
      }
      commit(resolveWidth(shownWidth + (e.key === "ArrowRight" ? 20 : -20)));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(
        shownCollapsed
          ? { collapsed: false, width: expandedWidth }
          : { collapsed: true, width: COLLAPSED_WIDTH }
      );
    }
  };

  return (
    <aside
      ref={asideRef}
      style={{ width: shownWidth }}
      className={cn(
        // No right border and no surface of its own: this bar and the status
        // bar are one continuous sheet of chrome, and the page is held off it
        // by the gutter, not by a rule.
        "relative flex h-full shrink-0 flex-col bg-chrome",
        // The transition is what makes the collapse read as a fold; during a
        // drag it would only lag the pointer.
        drag ? "select-none" : "transition-[width] duration-150"
      )}
    >
      {/* The resize handle, straddling the edge so it is grabbable from the
          gutter as well. Dragging under COLLAPSE_THRESHOLD folds the bar to
          icons — the footer button and this are the same action. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionner la barre latérale"
        aria-valuenow={shownWidth}
        aria-valuemin={COLLAPSED_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        title="Glisser pour redimensionner — sous 140 px, la barre se replie en icônes. Double-cliquer pour replier ou déplier."
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(resolveWidth(widthAtPointer(e.clientX)));
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          setDrag(resolveWidth(widthAtPointer(e.clientX)));
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          e.currentTarget.releasePointerCapture(e.pointerId);
          commit(drag);
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onDoubleClick={() =>
          commit(
            collapsed
              ? { collapsed: false, width: expandedWidth }
              : { collapsed: true, width: COLLAPSED_WIDTH }
          )
        }
        onKeyDown={onHandleKeyDown}
        className="group absolute inset-y-0 right-0 z-20 w-gutter translate-x-1/2 cursor-col-resize focus-visible:outline-none"
      >
        <div
          className={cn(
            "mx-auto h-full w-[3px] rounded-full transition-colors",
            drag
              ? "bg-primary/50"
              : "bg-transparent group-hover:bg-primary/40 group-focus-visible:bg-primary/60"
          )}
        />
      </div>
      {/* Brand */}
      <div className="flex items-center gap-2 px-3 py-4">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        {!shownCollapsed && (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold">SkillManager</div>
            <div className="text-xs text-muted-foreground">Claude Code</div>
          </div>
        )}
      </div>

      <Separator />

      {/* Actions: Search + Refresh — separated from navigation */}
      <div className="space-y-1 px-2 py-2">
        <button
          type="button"
          title="Ouvrir la palette de commandes (Ctrl+K) — accédez à tout"
          onClick={onOpenPalette}
          className={cn(
            "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            shownCollapsed && "justify-center px-0"
          )}
        >
          <Search className="h-4 w-4 shrink-0" />
          {!shownCollapsed && (
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
              : "Rafraîchir — re-scanne l'installation locale et les forges (GitHub / Gitea), quota limité"
          }
          onClick={() => {
            // "user": the person is present, so this is the expensive sweep —
            // no reuse window, full probing, and a host written off by the
            // circuit breaker gets another go ("reconnect the VPN, press
            // Rafraîchir" has to work at once).
            forceRefresh(qc, "user");
            // Recompute the usage audit (dashboard top-3 skills + audit page)
            // from the transcripts — the index re-parses only changed files.
            qc.invalidateQueries({ queryKey: ["usage-audit"] });
            // On the Suivi Marketplace tab, also refresh the (network-heavy) PR
            // tracking — this button replaces the tab's own refresh button.
            if (useTrackingView.getState().active) {
              qc.invalidateQueries({ queryKey: ["tracked-prs"] });
            }
          }}
          className={cn(
            "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            shownCollapsed && "justify-center px-0"
          )}
        >
          <RefreshCw
            className={cn("h-4 w-4 shrink-0", isRefreshing && "animate-spin")}
          />
          {!shownCollapsed && <span>Rafraîchir</span>}
        </button>
      </div>

      <Separator />

      {/* Navigation, in four sections. The headings are dropped when the bar
          is collapsed to icons — a two-letter stub would read as a broken
          label — and a thin rule stands in for them, so the grouping survives
          the collapse instead of dissolving into one column of icons. */}
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {NAV.map((group, gi) => (
          <div key={group.title ?? `g${gi}`} className={cn(gi > 0 && "mt-2")}>
            {group.title &&
              (shownCollapsed ? (
                <div className="mx-2 mb-1 border-t" title={group.title} />
              ) : (
                <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  {group.title}
                </div>
              ))}
            <div className="space-y-0.5">
              {group.items.map(({ to, label, subtitle, tooltip, icon: Icon }) => {
                // Only the Changes tab carries a count today; keep the lookup
                // local so adding a second badge later is a map entry, not a
                // new branch.
                const badge = to === "/changes" ? pendingChanges : 0;
                return (
                  <NavLink
                    key={to}
                    to={to}
                    end={to === "/"}
                    title={tooltip}
                    className={({ isActive }) =>
                      cn(
                        "flex items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                        shownCollapsed && "items-center justify-center px-0 py-2",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      )
                    }
                  >
                    <div className="relative shrink-0 self-center">
                      <Icon className="h-4 w-4" />
                      {badge > 0 && shownCollapsed && (
                        <span className="absolute -right-1.5 -top-1.5 h-2 w-2 rounded-full bg-amber-500" />
                      )}
                    </div>
                    {!shownCollapsed && (
                      <div className="min-w-0 flex-1 leading-tight">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{label}</span>
                          {badge > 0 && (
                            <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                              {badge}
                            </span>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground/80">
                          {subtitle}
                        </div>
                      </div>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Forge connection status used to sit here. It is now a segment of the
          status bar (`components/StatusBar.tsx`), which is visible on every
          page *and* independent of this bar being collapsed to icons — the two
          reasons it was moved out of the dashboard in the first place. */}
      <Separator />

      {/* Utilities cluster: Settings, Help, Theme, Collapse */}
      <div
        className={cn(
          "flex items-center gap-1 px-2 py-2",
          shownCollapsed ? "flex-col" : "justify-between px-3"
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
          onClick={() =>
            commit(
              collapsed
                ? { collapsed: false, width: expandedWidth }
                : { collapsed: true, width: COLLAPSED_WIDTH }
            )
          }
          title={shownCollapsed ? "Déplier la barre" : "Replier la barre en icônes"}
          aria-label={shownCollapsed ? "Déplier la barre" : "Replier la barre"}
        >
          {shownCollapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <ChevronsLeft className="h-4 w-4" />
          )}
        </Button>
      </div>
      {staged && (
        <button
          type="button"
          onClick={restartNow}
          title={`SkillManager ${staged.version} est installé — redémarrer pour l'utiliser`}
          className={cn(
            "mx-2 mb-2 flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300",
            shownCollapsed && "justify-center px-0"
          )}
        >
          <ArrowUpCircle className="h-4 w-4 shrink-0" />
          {!shownCollapsed && (
            <span className="min-w-0 text-left leading-tight">
              <span className="block font-medium">{staged.version} prête</span>
              <span className="block text-[11px] opacity-80">
                Redémarrer maintenant
              </span>
            </span>
          )}
        </button>
      )}
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </aside>
  );
}

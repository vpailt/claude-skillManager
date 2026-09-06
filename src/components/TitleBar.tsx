import { useEffect, useState } from "react";
import { Copy, Minus, Search, Sparkles, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import { useUi, toggleSidebar } from "@/stores/ui";
import { useHelpDialog } from "@/stores/helpDialog";
import { useSettingsDialog } from "@/stores/settingsDialog";
import { useReleaseNotes } from "@/stores/releaseNotes";
import { checkForUpdate } from "@/hooks/useAppUpdateEvents";
import { HelpDialog } from "@/components/HelpDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ThemePref, UiDensity } from "@/lib/types";

const log = createLogger("titlebar");

/**
 * The window's own title bar — Windows draws none, `decorations` is off in
 * `tauri.conf.json`. Which means everything the OS used to provide lives here:
 * the drag region, the double-click to maximise, and the three window buttons.
 *
 * It is chrome, like the sidebar and the status bar below it, and it carries
 * what used to sit at the two ends of the sidebar: the application menus
 * (Fichier / Affichage / Aide — settings, theme, density, help, the sidebar
 * fold) and the search field that opens the command palette.
 *
 * `data-tauri-drag-region` is what makes a bare patch of this bar drag the
 * window: Tauri only acts on the element directly under the pointer, so every
 * gap gets the attribute and no control ever does.
 */

const THEME_LABEL: Record<ThemePref, string> = {
  light: "Clair",
  dark: "Sombre",
  auto: "Auto (suit le système)",
};

const DENSITY_LABEL: Record<UiDensity, string> = {
  comfortable: "Confortable",
  compact: "Compacte",
};

/** One top-level menu: a label in the bar, a dropdown under it. */
function Menu({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-full shrink-0 items-center rounded-sm px-2 text-xs text-foreground/80 outline-none transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
        >
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={2} className="min-w-[14rem]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Minimise / maximise / close. Windows conventions: 46 px wide, no gap, and
 * close goes red rather than accent — it is the one button whose mistake costs
 * something.
 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = () => {
      win
        .isMaximized()
        .then(setMaximized)
        .catch(() => {});
    };
    sync();
    // Maximising, restoring and snapping all arrive as a resize; there is no
    // dedicated event, so this is what keeps the middle button's icon honest.
    win
      .onResized(sync)
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  const btn =
    "grid h-full w-[46px] shrink-0 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground";

  return (
    <div className="flex h-full shrink-0 items-stretch">
      <button
        type="button"
        className={btn}
        title="Réduire"
        aria-label="Réduire la fenêtre"
        onClick={() => void getCurrentWindow().minimize()}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={btn}
        title={maximized ? "Restaurer" : "Agrandir"}
        aria-label={maximized ? "Restaurer la fenêtre" : "Agrandir la fenêtre"}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? (
          <Copy className="h-3.5 w-3.5 -scale-x-100" />
        ) : (
          <Square className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        className={cn(
          btn,
          "hover:bg-[#e81123] hover:text-white focus-visible:bg-[#e81123] focus-visible:text-white"
        )}
        // `close()`, not `destroy()`: the close-to-tray setting is enforced on
        // the CloseRequested event in `lib.rs`, and skipping it here would make
        // this button behave unlike every other way of closing the window.
        title="Fermer"
        aria-label="Fermer la fenêtre"
        onClick={() => void getCurrentWindow().close()}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function TitleBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const theme = useUi((s) => s.ui.theme);
  const density = useUi((s) => s.ui.density);
  const collapsed = useUi((s) => s.ui.sidebarCollapsed);
  const patchPersisted = useUi((s) => s.patchPersisted);
  const openSettings = useSettingsDialog((s) => s.openTo);
  const helpOpen = useHelpDialog((s) => s.open);
  const setHelpOpen = useHelpDialog((s) => s.setOpen);
  const openNotes = useReleaseNotes((s) => s.setOpen);

  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-stretch gap-0 bg-chrome pl-2 text-sm"
    >
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-2 pr-1"
      >
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
      </div>

      <Menu label="Fichier">
        <DropdownMenuItem onSelect={() => openSettings("general")}>
          Paramètres…
          <DropdownMenuShortcut>Ctrl+,</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          // Really quit, tray or not: `app.exit(0)` passes a code, and the
          // ExitRequested guard in `lib.rs` only holds the process back when
          // there is none (the last window closing).
          onSelect={() => {
            void api.appQuit().catch((e) => log.error("quit failed", e));
          }}
        >
          Quitter
        </DropdownMenuItem>
      </Menu>

      <Menu label="Affichage">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Thème</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(v) =>
                patchPersisted({ theme: v as ThemePref })
              }
            >
              {(Object.keys(THEME_LABEL) as ThemePref[]).map((t) => (
                <DropdownMenuRadioItem key={t} value={t}>
                  {THEME_LABEL[t]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Densité</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={density}
              onValueChange={(v) =>
                patchPersisted({ density: v as UiDensity })
              }
            >
              {(Object.keys(DENSITY_LABEL) as UiDensity[]).map((d) => (
                <DropdownMenuRadioItem key={d} value={d}>
                  {DENSITY_LABEL[d]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={toggleSidebar}>
          {collapsed ? "Déplier la barre latérale" : "Replier la barre latérale"}
          <DropdownMenuShortcut>Ctrl+B</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenPalette}>
          Palette de commandes…
          <DropdownMenuShortcut>Ctrl+K</DropdownMenuShortcut>
        </DropdownMenuItem>
      </Menu>

      <Menu label="Aide">
        <DropdownMenuItem onSelect={() => setHelpOpen(true)}>
          Guide & raccourcis
          <DropdownMenuShortcut>F1</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openNotes(true)}>
          Notes de version
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void checkForUpdate()}>
          Rechercher une mise à jour
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings("about")}>
          À propos de SkillManager
        </DropdownMenuItem>
      </Menu>

      {/* The middle stretch is drag surface, with the search field floating in
          it — the field is the palette's front door, not an input: typing
          happens in the palette itself, so this is a button that looks like
          one. */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center justify-center px-2"
      >
        <button
          type="button"
          onClick={onOpenPalette}
          title="Ouvrir la palette de commandes (Ctrl+K) — accédez à tout"
          className="flex h-6 w-full max-w-[34rem] items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-background"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Rechercher plugins, skills, actions…</span>
          <kbd className="ml-auto shrink-0 rounded border px-1 text-[10px] leading-4">
            Ctrl+K
          </kbd>
        </button>
      </div>

      <WindowControls />
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </header>
  );
}

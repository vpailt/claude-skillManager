import { useEffect, useState } from "react";
import { Copy, HelpCircle, Minus, Sparkles, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";
import { useHelpDialog } from "@/stores/helpDialog";
import { HelpDialog } from "@/components/HelpDialog";
import { SearchBox } from "@/components/SearchBox";

/**
 * The window's own title bar — Windows draws none, `decorations` is off in
 * `tauri.conf.json`. Which means everything the OS used to provide lives here:
 * the drag region, the double-click to maximise, and the three window buttons.
 *
 * It is chrome, like the sidebar and the status bar below it, and it carries
 * three things and no more: the search field (which takes the typing itself and
 * drops its results under the bar, `components/SearchBox.tsx`), the help
 * button, and the window controls. There is no menu bar — settings live at the
 * foot of the sidebar, theme and density in Paramètres → Apparence, and the
 * shortcuts in `App.tsx` work whether or not anything is open.
 *
 * `data-tauri-drag-region` is what makes a bare patch of this bar drag the
 * window: Tauri only acts on the element directly under the pointer, so every
 * gap gets the attribute and no control ever does.
 */

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

export function TitleBar() {
  const helpOpen = useHelpDialog((s) => s.open);
  const setHelpOpen = useHelpDialog((s) => s.setOpen);

  return (
    <header
      data-tauri-drag-region
      // `relative z-30`: the search panel hangs out of this bar and over the
      // page, and a page is free to position things of its own.
      className="relative z-30 flex h-9 shrink-0 items-stretch gap-0 bg-chrome pl-2 text-sm"
    >
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-2 pr-1"
      >
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
      </div>

      {/* The middle stretch is drag surface, with the search field floating in
          it. The field takes the typing itself and drops its results just under
          the bar (`components/SearchBox.tsx`). */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center justify-center px-2"
      >
        <SearchBox />
      </div>

      {/* Help sits just left of the window buttons, as a round pill rather
          than one of their squares: it belongs to the application, not to the
          window frame, and the shape is what says so. */}
      <div data-tauri-drag-region className="flex shrink-0 items-center pr-1">
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          title="Aide — à quoi sert l'application, connexions, raccourcis (F1)"
          aria-label="Aide"
          className="grid h-6 w-6 place-items-center rounded-full bg-accent/60 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      </div>

      <WindowControls />
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </header>
  );
}

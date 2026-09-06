import { ArrowUpCircle, CheckCircle2, Download, FileText, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dismissUpdate, restartNow, startUpdate } from "@/hooks/useAppUpdateEvents";
import { useAppUpdate } from "@/stores/appUpdate";
import { useReleaseNotes } from "@/stores/releaseNotes";

/**
 * A sub-window stacked above the page, in the same gutter and with the same
 * rounded corner — the sidebar and the status bar run past it, since those two
 * are the chrome. It exists to offer an *action*, and it has two faces, in
 * strict priority order:
 *
 * 1. **staged** — the binary is on disk. Nothing left to do but restart, so the
 *    bar says exactly that and offers the button.
 * 2. **available** — a release exists and nothing has been downloaded yet (the
 *    backend never downloads on its own). Install, read the notes, or dismiss.
 *
 * The third face — the download itself — moved to the status bar
 * (`components/StatusBar.tsx`), which is where every other long-running
 * operation now reports. Two progress bars for the same download, one at each
 * end of the window, is not information twice over; it is the same information
 * competing with itself. There is nothing to act on while it runs anyway, so
 * this bar simply steps aside until the swap lands and turns it into `staged`.
 *
 * Dismissal hides the offer outright until a newer release appears or the app
 * restarts — there is no sidebar pill for this state, only for `staged`. It is
 * recorded in the Rust process (`app_update_dismiss`), because the store dies
 * with the webview and tray mode destroys that on every close.
 */
export function UpdateBanner() {
  const available = useAppUpdate((s) => s.available);
  const staged = useAppUpdate((s) => s.staged);
  const installing = useAppUpdate((s) => s.installing);
  const installError = useAppUpdate((s) => s.installError);
  const dismissedVersion = useAppUpdate((s) => s.dismissedVersion);
  const openNotes = useReleaseNotes((s) => s.setOpen);

  // A sub-window like the page below it — same corner, same gutter — rather
  // than a full-width band welded to the top of the window.
  const shell =
    "flex shrink-0 items-center gap-3 rounded-panel border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-800 dark:text-emerald-200";

  // The status bar has it while it runs.
  if (installing) return null;

  if (staged) {
    return (
      <div className={shell}>
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <strong>SkillManager {staged.version}</strong> est installée —
          redémarrez l'application pour l'utiliser.
        </span>
        <Button size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={restartNow}>
          <RotateCw className="mr-1 h-3 w-3" />
          Redémarrer
        </Button>
      </div>
    );
  }

  const version = available?.version;
  if (!version || dismissedVersion === version) return null;

  return (
    <div className={shell}>
      <ArrowUpCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <strong>SkillManager {version}</strong> est disponible — vous êtes en{" "}
        {available.runningVersion}.
        {installError && (
          <span className="ml-2 text-red-600 dark:text-red-400">
            Dernière tentative échouée : {installError}
          </span>
        )}
      </span>

      <Button
        size="sm"
        variant="ghost"
        className="h-7 shrink-0 px-2 text-xs"
        onClick={() => openNotes(true)}
      >
        <FileText className="mr-1 h-3 w-3" />
        Notes de version
      </Button>

      <Button size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={startUpdate}>
        <Download className="mr-1 h-3 w-3" />
        Installer
      </Button>

      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        onClick={() => dismissUpdate(version)}
        title="Masquer ce bandeau jusqu'à la prochaine version"
        aria-label="Masquer le bandeau de mise à jour"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

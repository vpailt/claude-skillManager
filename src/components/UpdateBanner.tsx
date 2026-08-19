import { ArrowUpCircle, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openExternal } from "@/lib/utils";
import { useAppUpdate } from "@/stores/appUpdate";
import { useSettingsDialog } from "@/stores/settingsDialog";

/**
 * Full-width bar above the sidebar and the page, shown **only** while a new
 * version is available and still waiting on the user — i.e. the in-place swap
 * could not run (install directory read-only, or a release with no portable
 * binary), or a manual check turned one up that hasn't been installed yet.
 *
 * Deliberately nothing for the "already installed, restart when you like" case:
 * there the work is done, the app is perfectly usable as it stands, and a
 * permanent bar would be pure noise. That state lives on the sidebar pill (plus
 * its one-off toast), which costs no vertical space.
 *
 * Dismissal only hides the bar for that version, for the session.
 */
export function UpdateBanner() {
  const available = useAppUpdate((s) => s.available);
  const dismissedVersion = useAppUpdate((s) => s.dismissedVersion);
  const dismiss = useAppUpdate((s) => s.dismiss);
  const openSettings = useSettingsDialog((s) => s.openTo);

  const version = available?.version;
  if (!version || dismissedVersion === version) return null;

  return (
    <div className="flex items-center gap-3 border-b border-sky-500/40 bg-sky-500/10 px-4 py-2 text-sm text-sky-800 dark:text-sky-200">
      <ArrowUpCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <strong>SkillManager {version}</strong> est disponible — vous êtes en{" "}
        {available.runningVersion}.
      </span>

      {available.releaseUrl && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={() => openExternal(available.releaseUrl!)}
        >
          <ExternalLink className="mr-1 h-3 w-3" />
          Notes de version
        </Button>
      )}

      <Button
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        onClick={() => openSettings("about")}
      >
        Mettre à jour
      </Button>

      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        onClick={() => dismiss(version)}
        title="Masquer ce bandeau"
        aria-label="Masquer le bandeau de mise à jour"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

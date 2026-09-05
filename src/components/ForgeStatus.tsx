// Forge connection state, in the sidebar.
//
// This used to be a strip across the top of the dashboard *and* a block of
// plain text in the sidebar: two renderings of the same three queries, one of
// them clickable, neither visible when the sidebar was collapsed. It belongs
// next to navigation, not in the middle of the content the user came for — it
// is chrome, and it is the same on every page.
//
// Each row is a button onto the settings section that fixes it, because the
// only reason to read this is to act on it.
import { Key, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { useForgeStatus } from "@/hooks/useForgeStatus";
import { useSettingsDialog } from "@/stores/settingsDialog";

type Tone = "ok" | "warn";

function ForgeRow({
  icon: Icon,
  label,
  value,
  tone,
  title,
  collapsed,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: Tone;
  title: string;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
        collapsed && "justify-center px-0 py-2"
      )}
    >
      <span className="relative shrink-0">
        <Icon
          className={cn(
            "h-4 w-4",
            tone === "ok" ? "text-emerald-500" : "text-amber-500"
          )}
        />
        {/* Collapsed to icons, the dot is the only thing left carrying the
            state — the label and value are both gone. */}
        {collapsed && (
          <span
            className={cn(
              "absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-card",
              tone === "ok" ? "bg-emerald-500" : "bg-amber-500"
            )}
          />
        )}
      </span>
      {!collapsed && (
        <>
          <span className="truncate">{label}</span>
          <span className="ml-auto min-w-0 truncate font-medium text-foreground">
            {value}
          </span>
        </>
      )}
    </button>
  );
}

export function ForgeStatus({ collapsed }: { collapsed: boolean }) {
  const openSettingsTo = useSettingsDialog((s) => s.openTo);
  const { github, gitea, loading } = useForgeStatus();

  // Nothing has answered yet: render nothing rather than a row that flips from
  // "non connecté" to a login a moment later.
  if (loading) return null;

  return (
    <div className={cn("space-y-0.5 py-2", collapsed ? "px-2" : "px-2")}>
      {github.known && (
        <ForgeRow
          icon={Key}
          label="GitHub"
          value={github.ok ? `@${github.user}` : "non connecté"}
          tone={github.ok ? "ok" : "warn"}
          collapsed={collapsed}
          title={
            github.ok
              ? `GitHub : connecté en tant que @${github.user}${
                  github.remaining >= 0
                    ? ` · quota ${github.remaining}/${github.limit}`
                    : ""
                }`
              : "GitHub : aucun token configuré — ouvrir les paramètres"
          }
          onClick={() => openSettingsTo("connexions")}
        />
      )}
      {github.lowQuota && !collapsed && (
        <div
          className="px-3 text-[11px] text-amber-500"
          title="Quota d'appels à l'API GitHub bientôt épuisé — il se réinitialise au début de l'heure suivante"
        >
          quota bas ({github.remaining}/{github.limit})
        </div>
      )}
      {gitea.map((g) => (
        <ForgeRow
          key={g.baseUrl}
          icon={Server}
          label={g.host}
          value={g.ok ? `@${g.user}` : g.hasToken ? "auth échouée" : "non connecté"}
          tone={g.ok ? "ok" : "warn"}
          collapsed={collapsed}
          title={
            g.ok
              ? `Gitea ${g.host} : connecté en tant que @${g.user}${
                  g.insecureTls ? " (vérification TLS désactivée)" : ""
                }`
              : `Gitea ${g.host} : ${g.user} — VPN GlobalProtect + token requis`
          }
          onClick={() => openSettingsTo("connexions", "gitea")}
        />
      ))}
    </div>
  );
}

// The permanent bar across the bottom of the window.
//
// Four things live here, and they are all things that were previously either
// invisible or duplicated:
//
// 1. **The running version.** It was a grey line at the bottom of the sidebar,
//    gone the moment the bar was collapsed to icons.
// 2. **Forge connection state.** It used to be a strip on the dashboard *and* a
//    text block in the sidebar; the sidebar won, and it now lands here — same
//    single `useForgeStatus` declaration, one rendering, present on every page
//    whatever the sidebar is doing.
// 3. **A progress slot**, on the right next to the bell. New. Everything slow
//    in this app (a sweep, an install, a PR upload, a self-update) used to run
//    behind a spinning icon at best, with no indication of what it was doing or
//    how far along it was.
// 4. **The notification bell**, at the right end. Toasts expire after eight
//    seconds; the notifications themselves now outlive them, and this is where
//    they are read back.
//
// It is chrome: fixed height, never scrolls, never pushes the page around.
import { useMemo, useState } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { Github, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { GiteaIcon } from "@/components/GiteaIcon";
import { NotificationCenter } from "@/components/NotificationCenter";
import { useForgeStatus } from "@/hooks/useForgeStatus";
import { useSettingsDialog } from "@/stores/settingsDialog";
import { useReleaseNotes } from "@/stores/releaseNotes";
import { useAppVersion } from "@/hooks/useAppVersion";
import { useAppUpdate } from "@/stores/appUpdate";
import { pickVisible, useProgress, type ProgressTask } from "@/stores/progress";

const PHASE_LABEL = {
  downloading: "Téléchargement de la mise à jour",
  verifying: "Vérification de la signature",
  installing: "Installation de la mise à jour",
} as const;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

/** One clickable segment, VS Code style: icon, text, hover fill. */
function Segment({
  children,
  title,
  onClick,
  className,
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
  className?: string;
}) {
  const shell = cn(
    // `shrink-0`: a compressed segment clipped the host name it exists to
    // show. Progress, on the right, is what gives way when width runs short —
    // and past that the left group clips, never the bell.
    "flex h-full shrink-0 items-center gap-1.5 px-2.5 text-xs leading-none text-muted-foreground",
    onClick && "transition-colors hover:bg-accent hover:text-accent-foreground",
    className
  );
  if (!onClick) {
    return (
      <div className={shell} title={title}>
        {children}
      </div>
    );
  }
  return (
    <button type="button" className={shell} title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

/** The thin bar itself. `pct === null` means "running, length unknown". */
function Track({ pct }: { pct: number | null }) {
  return (
    <div
      className="h-1 w-28 shrink-0 overflow-hidden rounded-full bg-primary/20"
      role="progressbar"
      aria-label="Progression de l'opération en cours"
      aria-valuenow={pct ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={pct === null ? "Progression inconnue" : `${pct} %`}
    >
      <div
        className={
          pct === null
            ? "h-full w-1/3 animate-pulse rounded-full bg-primary"
            : "h-full rounded-full bg-primary transition-[width] duration-200"
        }
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * The progress slot.
 *
 * A single line at a time, chosen by priority: the self-update first (it is
 * swapping the binary under the running process — nothing outranks that), then
 * whatever `stores/progress` holds. Extra concurrent tasks are counted rather
 * than stacked, so the bar's height never moves.
 */
function ProgressSlot() {
  const installing = useAppUpdate((s) => s.installing);
  const updateProgress = useAppUpdate((s) => s.progress);
  const tasks = useProgress((s) => s.tasks);

  // Two queries slow enough to be worth a line, but owned by their pages rather
  // than by an explicit task: the transcript audit (parses every session file
  // on a cold index) and the PR tracking sweep (one listing per tracked repo,
  // VPN-gated). Deriving them from the fetch state costs nothing and avoids
  // wrapping every call site.
  const auditing = useIsFetching({ queryKey: ["usage-audit"] }) > 0;
  const tracking = useIsFetching({ queryKey: ["tracked-prs"] }) > 0;

  const ambient = useMemo<ProgressTask[]>(() => {
    const out: ProgressTask[] = [];
    if (auditing)
      out.push({
        id: "ambient-audit",
        kind: "audit",
        label: "Audit d'utilisation",
        detail: "lecture des transcripts",
        pct: null,
        startedAt: 0,
      });
    if (tracking)
      out.push({
        id: "ambient-tracking",
        kind: "tracking",
        label: "Suivi des PR",
        detail: "interrogation des forges",
        pct: null,
        startedAt: 0,
      });
    return out;
  }, [auditing, tracking]);

  if (installing) {
    const phase = updateProgress?.phase ?? "downloading";
    const total = updateProgress?.total ?? 0;
    const done = updateProgress?.downloaded ?? 0;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
    return (
      <div className="flex h-full items-center gap-2 px-2 text-xs leading-none text-emerald-600 dark:text-emerald-400">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="shrink-0 font-medium">{PHASE_LABEL[phase]}</span>
        {total > 0 && phase === "downloading" && (
          <span className="shrink-0 tabular-nums opacity-80">
            {mb(done)} / {mb(total)}
          </span>
        )}
        <Track pct={pct} />
        {pct !== null && (
          <span className="w-8 shrink-0 text-right tabular-nums">{pct} %</span>
        )}
      </div>
    );
  }

  const all = [...tasks, ...ambient];
  const visible = pickVisible(all);
  if (!visible) return null;
  const others = all.length - 1;

  return (
    <div className="flex h-full min-w-0 items-center gap-2 px-2 text-xs leading-none text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      <span className="shrink-0 font-medium text-foreground">{visible.label}</span>
      {visible.detail && (
        <span className="min-w-0 max-w-[22rem] truncate" title={visible.detail}>
          {visible.detail}
        </span>
      )}
      <Track pct={visible.pct} />
      {visible.pct !== null && (
        <span className="w-8 shrink-0 text-right tabular-nums">{visible.pct} %</span>
      )}
      {others > 0 && (
        <span
          className="shrink-0 rounded-full bg-muted px-1.5"
          title={all
            .filter((t) => t.id !== visible.id)
            .map((t) => [t.label, t.detail].filter(Boolean).join(" · "))
            .join("\n")}
        >
          +{others}
        </span>
      )}
    </div>
  );
}

export function StatusBar() {
  const version = useAppVersion();
  const staged = useAppUpdate((s) => s.staged);
  const available = useAppUpdate((s) => s.available);
  const openSettingsTo = useSettingsDialog((s) => s.openTo);
  const openNotes = useReleaseNotes((s) => s.setOpen);
  const { github, gitea, loading } = useForgeStatus();

  const [bellOpen, setBellOpen] = useState(false);
  const forgeShown = !loading && (github.known || gitea.length > 0);

  return (
    // No `overflow-hidden` here, ever: the bell's panel is positioned against
    // this element and opens *upwards*, out of the bar. Clipping the footer
    // clipped the panel to nothing — the bell answered the click and nothing
    // appeared. Overflow is handled by the two inner groups instead.
    <footer className="flex h-9 shrink-0 items-stretch gap-0 border-t bg-card/60 text-muted-foreground">
      {/* Everything on the left in one clipping group. The segments inside are
          `shrink-0`, so this group is the last thing to give way — after the
          progress slot, and never at the expense of the bell. */}
      <div className="flex min-w-0 items-stretch overflow-hidden">
        {/* Version — the one place it is always readable, sidebar collapsed or
            not. Clicking it opens the release history, which is the only
            question anyone has when they read a version number. */}
        <Segment
          title={
            staged
              ? `SkillManager ${version ?? "?"} — la version ${staged.version} est installée, redémarrez pour l'utiliser`
              : available
                ? `SkillManager ${version ?? "?"} — la version ${available.version} est disponible`
                : `SkillManager ${version ?? "?"} — voir les notes de version`
          }
          onClick={() => openNotes(true)}
        >
          <span className="font-medium text-foreground">v{version ?? "…"}</span>
          {staged && (
            <span className="rounded-full bg-emerald-500/15 px-1.5 font-medium text-emerald-600 dark:text-emerald-400">
              {staged.version} prête
            </span>
          )}
          {!staged && available && (
            <span className="rounded-full bg-emerald-500/15 px-1.5 font-medium text-emerald-600 dark:text-emerald-400">
              {available.version} dispo
            </span>
          )}
        </Segment>

        <div className="my-1.5 w-px bg-border" />

        {/* Forge connection. Green connected, red not — the icon carries it, so
            the state survives the window being narrow enough to clip the text. */}
        {!loading && github.known && (
          <Segment
            title={
              github.ok
                ? `GitHub : connecté en tant que @${github.user}${
                    github.remaining >= 0
                      ? ` · quota ${github.remaining}/${github.limit}`
                      : ""
                  }`
                : "GitHub : aucun token valide — ouvrir les paramètres"
            }
            onClick={() => openSettingsTo("connexions")}
          >
            <Github
              className={cn(
                "h-4 w-4 shrink-0",
                github.ok ? "text-emerald-500" : "text-red-500"
              )}
            />
            <span className="whitespace-nowrap">
              {github.ok ? `@${github.user}` : "GitHub non connecté"}
            </span>
            {github.lowQuota && (
              <span
                className="text-amber-500"
                title="Quota d'appels à l'API GitHub bientôt épuisé — il se réinitialise au début de l'heure suivante"
              >
                quota {github.remaining}/{github.limit}
              </span>
            )}
          </Segment>
        )}

        {!loading &&
          gitea.map((g) => (
            <Segment
              key={g.baseUrl}
              title={
                g.ok
                  ? `Gitea ${g.host} : connecté en tant que @${g.user}${
                      g.insecureTls ? " (vérification TLS désactivée)" : ""
                    }`
                  : `Gitea ${g.host} : ${
                      g.hasToken ? "authentification échouée" : "aucun token"
                    } — VPN GlobalProtect + token requis`
              }
              onClick={() => openSettingsTo("connexions", "gitea")}
            >
              <GiteaIcon
                className={cn(
                  "h-4 w-4 shrink-0",
                  g.ok ? "text-emerald-500" : "text-red-500"
                )}
              />
              {/* No `max-w` here: `git.almaviacx.local` is 19 characters and the
                  whole point of the segment is to say *which* instance is down.
                  `whitespace-nowrap` keeps it on one line in a 36 px bar. */}
              <span className="whitespace-nowrap">
                {g.ok ? `@${g.user}` : g.host}
              </span>
            </Segment>
          ))}

        {/* Closing delimiter, mirroring the one before the forge block, so the
            connections read as a group rather than as a run of items. */}
        {forgeShown && <div className="my-1.5 w-px bg-border" />}
      </div>

      {/* Progress and the bell close the bar on the right, in that order.
          Progress is the one thing here allowed to give way (`min-w-0` and its
          own clip): its label and detail are as long as whatever is running,
          and it must never push the bell off the edge. */}
      <div className="ml-auto flex min-w-0 items-stretch">
        <div className="flex min-w-0 items-stretch overflow-hidden">
          <ProgressSlot />
        </div>
        <div className="my-1.5 w-px shrink-0 bg-border" />
        <div className="flex shrink-0 items-stretch">
          <NotificationCenter open={bellOpen} onOpenChange={setBellOpen} />
        </div>
      </div>
    </footer>
  );
}

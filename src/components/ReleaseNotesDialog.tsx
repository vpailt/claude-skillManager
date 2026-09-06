import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScrollFade } from "@/components/ScrollFade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SkillMarkdown } from "@/components/SkillMarkdown";
import { api } from "@/lib/api";
import { cn, openExternal } from "@/lib/utils";
import { useAppVersion } from "@/hooks/useAppVersion";
import { useReleaseNotes } from "@/stores/releaseNotes";
import { useAppUpdate } from "@/stores/appUpdate";
import { installVersion } from "@/hooks/useAppUpdateEvents";
import type { ReleaseNote } from "@/lib/types";

/** GitHub tags carry a leading `v`, `getVersion()` doesn't. */
function sameVersion(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.replace(/^v/i, "").trim() === b.replace(/^v/i, "").trim();
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("fr-FR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function ReleaseEntry({
  release,
  current,
  older,
  defaultOpen,
}: {
  release: ReleaseNote;
  current: boolean;
  /** Published before the running version — the button then says "revenir à". */
  older: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const installing = useAppUpdate((s) => s.installing);
  const staged = useAppUpdate((s) => s.staged);
  const date = formatDate(release.publishedAt);
  // Nothing to install on the version already running, nor once a binary is
  // staged: the swap slot holds one build, and it is taken until a restart.
  const canInstall = release.installable && !current && !staged;
  return (
    <section
      className={cn(
        "rounded-md border",
        current ? "border-emerald-500/50 bg-emerald-500/5" : "border-border"
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="font-semibold">{release.name}</span>
        {release.name !== release.version && (
          <Badge variant="outline" className="font-mono text-[10px]">
            {release.version}
          </Badge>
        )}
        {current && (
          <Badge variant="success" className="text-[10px]">
            installée
          </Badge>
        )}
        {release.prerelease && (
          <Badge variant="warning" className="text-[10px]">
            pré-version
          </Badge>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{date}</span>
      </button>
      {open && (
        <div className="border-t px-3 py-3">
          {release.body.trim() ? (
            <SkillMarkdown content={release.body} className="text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">
              Cette release n'a pas de description.
            </p>
          )}
          {/* The actions close the panel, both of them, GitHub on the left and
              the install on the right: you read what a version contains, then
              you act on it. Outside the header's toggle button, because a
              button inside a button is invalid markup — and because installing
              a version is not "expand its notes". */}
          <div className="mt-3 flex items-center gap-2 border-t pt-3">
            {release.url && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => openExternal(release.url!)}
              >
                <ExternalLink className="mr-1 h-3 w-3" />
                Ouvrir sur GitHub
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              {/* Said out loud rather than left as an absence: an entry with no
                  button reads as one that failed to offer it. */}
              {current && (
                <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Version installée
                </span>
              )}
              {!current && !release.installable && (
                <span className="text-xs text-muted-foreground">
                  Pas de binaire autonome — installation impossible depuis ici
                </span>
              )}
              {canInstall && (
                <Button
                  size="sm"
                  variant={older ? "outline" : "default"}
                  className="h-7 px-2 text-xs"
                  disabled={installing}
                  onClick={() => void installVersion(release.version)}
                  title={
                    older
                      ? `Réinstaller ${release.version} par-dessus la version en cours`
                      : `Installer ${release.version}`
                  }
                >
                  <Download className="mr-1 h-3 w-3" />
                  {older
                    ? `Revenir à ${release.version}`
                    : `Installer ${release.version}`}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The "Notes de mise à jour" panel: the published release history, newest
 * first, with the running version badged.
 *
 * It reads `/releases` rather than `/releases/latest` on purpose — the point is
 * to be able to look up what changed in the version you are *on*, not only in
 * the one being offered. Bodies go through `SkillMarkdown`, which is already
 * behind a `React.lazy` boundary, so the markdown stack stays out of the entry
 * chunk. Opened from Settings → À propos and from the update banner, both
 * through `stores/releaseNotes`.
 */
export function ReleaseNotesDialog() {
  const open = useReleaseNotes((s) => s.open);
  const setOpen = useReleaseNotes((s) => s.setOpen);
  const appVersion = useAppVersion();

  const q = useQuery({
    queryKey: ["release-notes"],
    queryFn: () => api.appReleaseNotes(15),
    // These change once per release; refetching on every open would just spend
    // GitHub's 60-req/h unauthenticated budget for nothing.
    staleTime: 30 * 60 * 1000,
    enabled: open,
  });

  const releases = useMemo(() => q.data ?? [], [q.data]);
  const currentIndex = releases.findIndex((r) => sameVersion(r.version, appVersion));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-3xl gap-0 p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Notes de mise à jour
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto mr-6 h-7 px-2 text-xs"
              onClick={() => q.refetch()}
              disabled={q.isFetching}
            >
              <RefreshCw className={cn("mr-1 h-3 w-3", q.isFetching && "animate-spin")} />
              Actualiser
            </Button>
          </DialogTitle>
          <DialogDescription>
            Les releases publiées sur <code>vpailt/claude-skillManager</code>, de
            la plus récente à la plus ancienne. Votre version est signalée, et
            chacune des autres peut être installée d'ici — y compris une plus
            ancienne, pour revenir en arrière. Le remplacement se fait au
            prochain démarrage.
          </DialogDescription>
        </DialogHeader>
        <ScrollFade className="max-h-[70vh]" wraps>
          <ScrollArea className="max-h-[70vh]">
            <div className="space-y-2 px-6 py-5">
            {q.isPending && (
              <p className="text-sm text-muted-foreground">Chargement…</p>
            )}
            {q.isError && (
              <p className="text-sm text-red-600 dark:text-red-400">
                Impossible de récupérer les notes : {String(q.error)}
              </p>
            )}
            {!q.isPending && !q.isError && releases.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Aucune release n'a encore été publiée.
              </p>
            )}
            {releases.map((r, i) => (
              <ReleaseEntry
                key={r.version || i}
                release={r}
                current={i === currentIndex}
                // The list is newest-first, so anything below the running
                // version is a downgrade — and the button says so rather than
                // calling it an install.
                older={currentIndex >= 0 && i > currentIndex}
                // The newest release and the one you are running: the two
                // anyone opening this panel actually came to read.
                defaultOpen={i === 0 || i === currentIndex}
              />
            ))}
            </div>
          </ScrollArea>
        </ScrollFade>
      </DialogContent>
    </Dialog>
  );
}

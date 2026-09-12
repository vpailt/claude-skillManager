import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { forceRefresh } from "@/hooks/useRefresh";
import { refreshLocalSkills } from "@/stores/app";
import { useNotifications } from "@/stores/notifications";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  HardDrive,
  Loader2,
  Package,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SkillMarkdown } from "@/components/SkillMarkdown";
import { api } from "@/lib/api";
import { cn, shortDate } from "@/lib/utils";
import type {
  ArchivedSkill,
  DuplicateCopy,
  DuplicateSkill,
} from "@/lib/types";

function CopyCard({
  copy,
  origin,
}: {
  copy: DuplicateCopy;
  origin: "local" | "plugin";
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        {origin === "local" ? (
          <HardDrive className="h-3 w-3 text-muted-foreground" />
        ) : (
          <Package className="h-3 w-3 text-muted-foreground" />
        )}
        <span className="font-medium text-foreground">{copy.source}</span>
        {copy.version ? (
          <Badge variant="outline" className="text-xs">
            v{copy.version}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs text-muted-foreground">
            aucune version
          </Badge>
        )}
      </div>
      <div className="space-y-0.5 text-muted-foreground">
        <div>
          <span className="text-foreground/70">Modifié :</span>{" "}
          {copy.lastModified ? shortDate(copy.lastModified) : "—"}
        </div>
        <div className="break-all">
          <span className="text-foreground/70">Dossier :</span> {copy.folder}
        </div>
        {copy.description && (
          <div className="line-clamp-3 italic">{copy.description}</div>
        )}
      </div>
    </div>
  );
}

interface DuplicateSkillsPanelProps {
  selectedFolder: string | null;
  onSelect: (dup: DuplicateSkill) => void;
}

export function DuplicateSkillsPanel({
  selectedFolder,
  onSelect,
}: DuplicateSkillsPanelProps) {
  const dup = useQuery({
    queryKey: ["duplicate-skills"],
    queryFn: api.listDuplicateSkills,
    staleTime: 60_000,
  });

  if (dup.isLoading || !dup.data) return null;
  if (dup.data.length === 0) return null;

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardContent className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h3 className="text-sm font-semibold">
            Skills en doublon ({dup.data.length})
          </h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Présent à la fois dans <code>~/.claude/skills/</code> et dans un
          plugin installé. Cliquez pour comparer.
        </p>
        <div className="space-y-1">
          {dup.data.map((d) => {
            const localDate = d.local.lastModified
              ? new Date(d.local.lastModified).getTime()
              : 0;
            const newestPluginDate = d.pluginCopies.reduce((acc, c) => {
              const t = c.lastModified
                ? new Date(c.lastModified).getTime()
                : 0;
              return t > acc ? t : acc;
            }, 0);
            const localIsNewer = localDate > 0 && localDate > newestPluginDate;
            const localIsOlder =
              newestPluginDate > 0 && localDate < newestPluginDate;
            const isSelected = selectedFolder === d.local.folder;
            return (
              <button
                key={`${d.name}:${d.local.folder}`}
                type="button"
                onClick={() => onSelect(d)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                  isSelected
                    ? "border-amber-500/50 bg-amber-500/10"
                    : "border-transparent",
                )}
              >
                <span className="truncate font-medium">{d.name}</span>
                <span className="text-muted-foreground">
                  · {d.pluginCopies.length} copie
                  {d.pluginCopies.length === 1 ? "" : "s"} dans un plugin
                </span>
                {localIsNewer && (
                  <Badge variant="secondary" className="ml-auto text-xs">
                    local plus récent
                  </Badge>
                )}
                {localIsOlder && (
                  <Badge variant="outline" className="ml-auto text-xs">
                    local plus ancien
                  </Badge>
                )}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

interface DuplicateSkillDetailProps {
  dup: DuplicateSkill;
  onArchived: () => void;
}

export function DuplicateSkillDetail({
  dup,
  onArchived,
}: DuplicateSkillDetailProps) {
  const qc = useQueryClient();
  const archive = useMutation({
    mutationFn: () => api.archiveUserSkill(dup.local.folder),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["duplicate-skills"] });
      qc.invalidateQueries({ queryKey: ["archived-skills"] });
      // Le dossier local a disparu : le nœud « Local » le dit maintenant, sans
      // attendre le sweep.
      void refreshLocalSkills();
      forceRefresh(qc);
      onArchived();
    },
  });

  const localDate = dup.local.lastModified
    ? new Date(dup.local.lastModified).getTime()
    : 0;
  const newestPluginDate = dup.pluginCopies.reduce((acc, c) => {
    const t = c.lastModified ? new Date(c.lastModified).getTime() : 0;
    return t > acc ? t : acc;
  }, 0);
  const localIsNewer = localDate > 0 && localDate > newestPluginDate;
  const localIsOlder = newestPluginDate > 0 && localDate < newestPluginDate;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h2 className="text-base font-semibold">{dup.name}</h2>
          <Badge variant="warning" className="text-xs">
            doublon
          </Badge>
          {localIsNewer && (
            <Badge variant="secondary" className="text-xs">
              local plus récent
            </Badge>
          )}
          {localIsOlder && (
            <Badge variant="outline" className="text-xs">
              local plus ancien
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Ce skill est installé localement et est aussi inclus dans{" "}
          {dup.pluginCopies.length} copie
          {dup.pluginCopies.length === 1 ? "" : "s"} de plugin. L'archivage
          déplace la copie locale vers <code>~/.claude/skills_archive/</code> —
          Claude Code arrêtera de charger le doublon, mais vous pourrez le
          restaurer plus tard.
        </p>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <CopyCard copy={dup.local} origin="local" />
          <div className="space-y-2">
            {dup.pluginCopies.map((c, i) => (
              <CopyCard key={i} copy={c} origin="plugin" />
            ))}
          </div>
        </div>
        {archive.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {archive.error instanceof Error
              ? archive.error.message
              : String(archive.error)}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => archive.mutate()}
            disabled={archive.isPending}
          >
            {archive.isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Archive className="mr-1 h-3 w-3" />
            )}
            Archiver la copie locale
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface ArchivedSkillDetailProps {
  skill: ArchivedSkill;
  /** Reçoit le dossier où le skill vient d'atterrir sous `~/.claude/skills/` —
   *  le nom peut différer de l'original (suffixe de collision), et c'est ce
   *  chemin-là que la page sélectionne pour montrer où il est reparti. */
  onRestored: (folder: string) => void;
}

export function ArchivedSkillDetail({
  skill,
  onRestored,
}: ArchivedSkillDetailProps) {
  const qc = useQueryClient();
  const push = useNotifications((s) => s.push);
  const restore = useMutation({
    mutationFn: () => api.restoreArchivedSkill(skill.folder),
    onSuccess: async (dest) => {
      qc.invalidateQueries({ queryKey: ["archived-skills"] });
      qc.invalidateQueries({ queryKey: ["duplicate-skills"] });
      // Attendu, pas lancé : `onRestored` sélectionne la ligne restaurée, et
      // elle n'existe dans le store qu'une fois ce scan appliqué. Le balayage
      // derrière `forceRefresh` dirait la même chose, mais des secondes plus
      // tard — c'est exactement ce qui faisait paraître la restauration sans
      // effet.
      await refreshLocalSkills();
      forceRefresh(qc);
      push({
        kind: "success",
        title: "Compétence restaurée",
        body: `${skill.name} — de retour dans ~/.claude/skills/.`,
      });
      onRestored(dest);
    },
  });
  const content = useQuery({
    enabled: !!skill.skillMdPath,
    queryKey: ["archived-skill-md", skill.skillMdPath],
    queryFn: () => api.readTextFile(skill.skillMdPath as string),
  });

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">{skill.name}</h2>
          <Badge variant="outline" className="text-xs">
            archivé
          </Badge>
          {skill.version && (
            <Badge variant="outline" className="text-xs">
              v{skill.version}
            </Badge>
          )}
        </div>
        {skill.description && (
          <p className="text-sm text-muted-foreground">{skill.description}</p>
        )}
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>
            <span className="text-foreground/70">Archivé :</span>{" "}
            {skill.archivedAt ? shortDate(skill.archivedAt) : "—"}
          </div>
          <div>
            <span className="text-foreground/70">Nom d'origine :</span>{" "}
            {skill.originalName}
          </div>
          <div className="break-all">
            <span className="text-foreground/70">Dossier :</span> {skill.folder}
          </div>
        </div>
        {restore.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {restore.error instanceof Error
              ? restore.error.message
              : String(restore.error)}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => restore.mutate()}
            disabled={restore.isPending}
          >
            {restore.isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <ArchiveRestore className="mr-1 h-3 w-3" />
            )}
            Restaurer vers ~/.claude/skills/
          </Button>
        </div>
        {skill.skillMdPath && (
          <div className="max-h-96 overflow-auto rounded-md border bg-card p-3">
            {content.isLoading ? (
              <div className="text-xs text-muted-foreground">Chargement…</div>
            ) : content.data ? (
              <SkillMarkdown content={content.data} />
            ) : (
              <div className="text-xs text-muted-foreground">
                (échec de lecture)
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

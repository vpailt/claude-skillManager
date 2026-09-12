// Pending skill changes, grouped the way they will be published: one group per
// (marketplace, plugin) — because that is exactly one pull request.
//
// Lives here rather than in the Changes page so the sidebar can count them
// without pulling the diff viewer into the entry chunk.
import { useMemo } from "react";
import { useApp } from "@/stores/app";
import { isActionable, useSkillSync } from "@/stores/skillSync";
import type { Marketplace, Plugin, SkillSyncStatus } from "@/lib/types";

export interface ChangeItem {
  /** Watch key: `folder` when installed, `watchFolder` when deleted locally. */
  folder: string;
  /** Frontmatter name, for display. */
  skillName: string;
  /** Folder basename — what the skill is called in the repo. */
  targetName: string;
  status: SkillSyncStatus;
}

export interface ChangeGroup {
  key: string;
  marketplace: Marketplace;
  plugin: Plugin;
  /** Whether a PR can actually be opened (push rights + a known source repo).
   *  Detection never depends on this — only the button does. */
  editable: boolean;
  /** Le plugin est installé mais absent du registre de sa marketplace : publier
   *  demande donc **deux** PR, le contenu sur le dépôt du plugin et la fiche de
   *  registre sur celui de la marketplace.
   *
   *  `local_only` est exactement ce signal : `merge_local_remote` ne le pose que
   *  lorsque le registre a bien été lu et ne liste pas le plugin — une lecture
   *  ratée laisse l'état local intact, donc jamais de faux positif hors ligne. */
  needsRegistry: boolean;
  items: ChangeItem[];
}

export function groupKey(marketplace: string, plugin: string) {
  // Newline separator: marketplace and plugin names can both carry spaces,
  // so a printable one could make two different pairs collide on one key.
  return `${marketplace}\n${plugin}`;
}

function basename(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
}

export function buildChangeGroups(
  marketplaces: Marketplace[],
  syncMap: Record<string, SkillSyncStatus>
): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  for (const m of marketplaces) {
    for (const p of m.plugins) {
      const items: ChangeItem[] = [];
      for (const s of p.skills) {
        const folder = s.folder ?? s.watchFolder;
        if (!folder) continue;
        const status = syncMap[folder] ?? "unknown";
        if (!isActionable(status)) continue;
        items.push({
          folder,
          skillName: s.name,
          targetName: basename(folder),
          status,
        });
      }
      // Le pseudo-marketplace « Local » n'a pas de registre où s'inscrire.
      const needsRegistry =
        p.installState === "local_only" &&
        !!m.sourceRepo &&
        m.sourceKind !== "local";
      // Un plugin que sa marketplace ne référence pas est un changement en
      // attente *par lui-même* : son entrée de registre reste à publier même
      // s'il n'apporte aucun skill à pousser — un plugin sans skill est un cas
      // parfaitement légitime, et c'est précisément celui qui disparaissait de
      // cet onglet.
      if (items.length === 0 && !needsRegistry) continue;
      items.sort((a, b) => a.targetName.localeCompare(b.targetName));
      groups.push({
        key: groupKey(m.name, p.name),
        marketplace: m,
        plugin: p,
        editable: !!m.editable && !!m.sourceRepo,
        needsRegistry,
        items,
      });
    }
  }
  groups.sort((a, b) => a.key.localeCompare(b.key));
  return groups;
}

/** Groups of pending changes, live. */
export function usePendingChanges(): ChangeGroup[] {
  const marketplaces = useApp((s) => s.marketplaces);
  const syncMap = useSkillSync((s) => s.status);
  return useMemo(
    () => buildChangeGroups(marketplaces, syncMap),
    [marketplaces, syncMap]
  );
}

/** Number of skill folders waiting to be published — drives the sidebar badge. */
export function usePendingChangesCount(): number {
  const groups = usePendingChanges();
  return useMemo(
    () => groups.reduce((n, g) => n + g.items.length, 0),
    [groups]
  );
}

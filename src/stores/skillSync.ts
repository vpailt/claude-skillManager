// Where each local skill folder stands relative to its plugin's remote repo —
// the source of truth for the Skills-tab badges and the push affordances.
//
// Seeded by `skillSyncList` after each refresh (the Rust sweep settles the
// statuses; this only reads them back) and kept live by the backend
// `skill-sync-changed` event. Keyed by the folder path exactly as it appears on
// `skill.folder`, so lookups are a direct hit.
import { create } from "zustand";
import type { SkillSyncState, SkillSyncStatus } from "@/lib/types";

interface SkillSyncStore {
  status: Record<string, SkillSyncStatus>;
  setMany: (items: SkillSyncState[]) => void;
  setOne: (folder: string, status: SkillSyncStatus) => void;
}

export const useSkillSync = create<SkillSyncStore>((set) => ({
  status: {},
  setMany: (items) =>
    set((s) => {
      const next = { ...s.status };
      for (const it of items) next[it.folder] = it.status;
      return { status: next };
    }),
  setOne: (folder, status) =>
    set((s) => ({ status: { ...s.status, [folder]: status } })),
}));

/** Reactive selector: this folder's status. Safe with null/undefined folders. */
export function useSkillStatus(
  folder: string | null | undefined
): SkillSyncStatus {
  return useSkillSync((s) => (folder ? s.status[folder] ?? "unknown" : "unknown"));
}

/** Whether a status is something the user may want to push upstream. Mirrors
 *  `SkillSync::is_actionable` on the Rust side — keep the two in step. */
export function isActionable(status: SkillSyncStatus): boolean {
  return status === "modified" || status === "new" || status === "deleted";
}

/** Reactive selector: does this folder need pushing? */
export function useIsSkillDirty(folder: string | null | undefined): boolean {
  return useSkillSync((s) =>
    folder ? isActionable(s.status[folder] ?? "unknown") : false
  );
}

/** Label + dot color per status, so the tree, the detail banner and the bulk
 *  bar all describe a status the same way. `synced`/`unknown` render no dot. */
export const SYNC_BADGE: Record<
  SkillSyncStatus,
  { label: string; dot: string; title: string } | null
> = {
  synced: null,
  unknown: null,
  modified: {
    label: "modifié",
    dot: "bg-amber-500",
    title: "Modifié localement — non poussé",
  },
  new: {
    label: "nouveau",
    dot: "bg-emerald-500",
    title: "Absent du dépôt distant — à pousser",
  },
  deleted: {
    label: "supprimé",
    dot: "bg-red-500",
    title: "Supprimé localement — encore présent sur le dépôt distant",
  },
};

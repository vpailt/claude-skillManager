// Tracks which skill folders have local edits not yet pushed — the source of
// truth for the "modifié" badge and the "Pousser la modification" banner in the
// Skills tab. Seeded by `skillWatchSet` (after each refresh) and kept live by
// the backend `skill-dirty` filesystem-watcher event. Keyed by the folder path
// exactly as it appears on `skill.folder`, so lookups are a direct hit.
import { create } from "zustand";
import type { SkillDirtyState } from "@/lib/types";

interface SkillDirtyStore {
  dirty: Record<string, boolean>;
  setMany: (items: SkillDirtyState[]) => void;
  setOne: (folder: string, dirty: boolean) => void;
}

export const useSkillDirty = create<SkillDirtyStore>((set) => ({
  dirty: {},
  setMany: (items) =>
    set((s) => {
      const next = { ...s.dirty };
      for (const it of items) next[it.folder] = it.dirty;
      return { dirty: next };
    }),
  setOne: (folder, dirty) =>
    set((s) => ({ dirty: { ...s.dirty, [folder]: dirty } })),
}));

/** Reactive selector: is this folder dirty? Safe with null/undefined folders. */
export function useIsSkillDirty(folder: string | null | undefined): boolean {
  return useSkillDirty((s) => (folder ? !!s.dirty[folder] : false));
}

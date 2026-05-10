import { create } from "zustand";
import type { Marketplace, Plugin, Skill } from "@/lib/types";

export type Selection =
  | { kind: "marketplace"; marketplace: string }
  | { kind: "plugin"; marketplace: string; plugin: string }
  | { kind: "skill"; marketplace: string; plugin: string; skill: string }
  | null;

interface AppState {
  selection: Selection;
  setSelection: (s: Selection) => void;

  marketplaces: Marketplace[];
  localOnly: Marketplace | null;
  setMarketplaces: (mps: Marketplace[], localOnly: Marketplace) => void;

  // Helpers
  findPlugin: (marketplace: string, plugin: string) => Plugin | undefined;
  findSkill: (
    marketplace: string,
    plugin: string,
    skill: string
  ) => Skill | undefined;
  findMarketplace: (marketplace: string) => Marketplace | undefined;
}

export const useApp = create<AppState>((set, get) => ({
  selection: null,
  setSelection: (selection) => set({ selection }),

  marketplaces: [],
  localOnly: null,
  setMarketplaces: (mps, localOnly) =>
    set({ marketplaces: mps, localOnly }),

  findMarketplace: (marketplace) => {
    const { marketplaces, localOnly } = get();
    if (localOnly && localOnly.name === marketplace) return localOnly;
    return marketplaces.find((m) => m.name === marketplace);
  },
  findPlugin: (marketplace, plugin) => {
    const m = get().findMarketplace(marketplace);
    return m?.plugins.find((p) => p.name === plugin);
  },
  findSkill: (marketplace, plugin, skill) => {
    const p = get().findPlugin(marketplace, plugin);
    return p?.skills.find((s) => s.name === skill);
  },
}));

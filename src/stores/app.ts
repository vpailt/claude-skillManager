import { create } from "zustand";
import { api } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import type { Marketplace, Plugin, Skill } from "@/lib/types";

const log = createLogger("app-store");

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
  setLocalOnly: (localOnly: Marketplace) => void;

  /**
   * Apply what an install/uninstall/toggle just did, without waiting for the
   * sweep that confirms it.
   *
   * The refresh behind one of those clicks is a remote pass — bounded, but
   * still seconds — and until it lands the tree showed the *previous* state, so
   * the app looked frozen after every click. These patch the one plugin the
   * user acted on; the sweep overwrites the whole tree a moment later with the
   * authoritative version, including the parts we deliberately don't guess
   * (a freshly installed plugin's skills, which only a local scan knows).
   */
  patchPlugin: (
    marketplace: string,
    plugin: string,
    patch: Partial<Plugin>
  ) => void;
  markPluginInstalled: (plugin: Plugin) => void;
  markPluginUninstalled: (plugin: Plugin) => void;
  markPluginEnabled: (
    marketplace: string,
    plugin: string,
    value: boolean
  ) => void;

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
  setLocalOnly: (localOnly) => set({ localOnly }),

  patchPlugin: (marketplace, plugin, patch) =>
    set((state) => ({
      marketplaces: state.marketplaces.map((m) =>
        m.name !== marketplace
          ? m
          : {
              ...m,
              plugins: m.plugins.map((p) =>
                p.name === plugin ? { ...p, ...patch } : p
              ),
            }
      ),
    })),

  markPluginInstalled: (plugin) =>
    get().patchPlugin(plugin.marketplaceName, plugin.name, {
      installState: "installed",
      // An update installs the version the catalogue advertised; a first
      // install has nothing better either. The sweep replaces it with what the
      // install record actually says.
      installedVersion: plugin.latestVersion ?? plugin.installedVersion ?? null,
      // The tracked ref was just fetched, so whatever divergence the badge
      // showed is gone.
      remoteContentChanged: false,
      // `/plugin install` semantics: enabled unless it already had an entry.
      enabled: plugin.enabled ?? true,
    }),

  markPluginUninstalled: (plugin) =>
    get().patchPlugin(plugin.marketplaceName, plugin.name, {
      installState: "not_installed",
      installedVersion: null,
      installPath: null,
      gitCommitSha: null,
      enabled: null,
      remoteContentChanged: false,
      // The folder is gone, so the skills under it are too. Leaving them would
      // keep an uninstalled plugin's subtree browsable until the sweep lands.
      skills: [],
    }),

  markPluginEnabled: (marketplace, plugin, value) =>
    get().patchPlugin(marketplace, plugin, { enabled: value }),

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

/**
 * Re-read `~/.claude/skills/` and apply it to the `Local` node, now.
 *
 * The sweep behind {@link forceRefresh} is the authority, but it reads the
 * forge — so archiving, restoring or deleting a local skill left the tree
 * showing the previous state for as long as that took, which reads as a frozen
 * UI. This asks Rust for the local half alone (a directory walk, no network)
 * and writes it over the `Local` node; the sweep overwrites everything a moment
 * later. Module-scoped, like `forceRefresh`, because the callers are
 * `mutationFn`s rather than components.
 */
export async function refreshLocalSkills() {
  try {
    useApp.getState().setLocalOnly(await api.scanLocalSkills());
  } catch (e) {
    // Nothing to recover: the sweep that follows carries the same answer, only
    // later. Losing the log line is what would hurt.
    log.warn("local skills rescan failed:", e);
  }
}

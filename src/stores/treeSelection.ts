// Multi-selection state for the Skills tree (marketplaces / plugins / skills).
//
// Ephemeral on purpose: a selection is a gesture, not a preference, so nothing
// is persisted. `prune` drops keys whose node disappeared from the tree after a
// refresh — otherwise a bulk action could target a plugin that no longer exists.
import { create } from "zustand";

export type SelKind = "mp" | "pl" | "sk";

export const mpKey = (marketplace: string) => `mp:${marketplace}`;
export const plKey = (marketplace: string, plugin: string) =>
  `pl:${marketplace}/${plugin}`;
/** Skills are keyed on their folder — the same key the sync watcher uses. */
export const skKey = (folder: string) => `sk:${folder}`;

export function keyKind(key: string): SelKind | null {
  const head = key.slice(0, 2);
  return head === "mp" || head === "pl" || head === "sk" ? head : null;
}

interface TreeSelectionState {
  selected: Set<string>;
  /** Anchor for shift-click range selection. */
  lastKey: string | null;
  /** Visible rows in tree order — the axis shift-click walks along. Owned by
   *  the page that renders the tree, since only it knows the current filters. */
  ordered: string[];
  setOrdered: (keys: string[]) => void;
  toggle: (key: string) => void;
  /** Set an explicit value on many keys at once (subtree checkbox). */
  setMany: (keys: string[], value: boolean) => void;
  /** Select everything between the anchor and `toKey`, in visible order. */
  selectRange: (toKey: string) => void;
  replace: (keys: string[]) => void;
  clear: () => void;
  prune: (valid: Set<string>) => void;
}

export const useTreeSelection = create<TreeSelectionState>((set) => ({
  selected: new Set(),
  lastKey: null,
  ordered: [],

  setOrdered: (keys) =>
    set((s) => {
      // Same rows, same array → keep the identity so nothing re-renders.
      if (
        s.ordered.length === keys.length &&
        s.ordered.every((k, i) => k === keys[i])
      ) {
        return s;
      }
      return { ordered: keys };
    }),

  toggle: (key) =>
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { selected: next, lastKey: key };
    }),

  setMany: (keys, value) =>
    set((s) => {
      const next = new Set(s.selected);
      for (const k of keys) {
        if (value) next.add(k);
        else next.delete(k);
      }
      return { selected: next, lastKey: keys[keys.length - 1] ?? s.lastKey };
    }),

  selectRange: (toKey) =>
    set((s) => {
      const ordered = s.ordered;
      const to = ordered.indexOf(toKey);
      if (to < 0) return s;
      const from = s.lastKey ? ordered.indexOf(s.lastKey) : -1;
      // No usable anchor → behave like a plain click.
      if (from < 0) {
        const next = new Set(s.selected);
        next.add(toKey);
        return { selected: next, lastKey: toKey };
      }
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      // Only rows of the same kind: a range from one plugin to another means
      // "these plugins", not "and every skill that happens to sit between them"
      // — several of which may not even be on screen (collapsed nodes).
      const kind = keyKind(toKey);
      const next = new Set(s.selected);
      for (let i = lo; i <= hi; i++) {
        if (keyKind(ordered[i]) === kind) next.add(ordered[i]);
      }
      return { selected: next, lastKey: toKey };
    }),

  replace: (keys) => set({ selected: new Set(keys), lastKey: keys.at(-1) ?? null }),

  clear: () => set({ selected: new Set(), lastKey: null }),

  prune: (valid) =>
    set((s) => {
      let dropped = false;
      const next = new Set<string>();
      for (const k of s.selected) {
        if (valid.has(k)) next.add(k);
        else dropped = true;
      }
      if (!dropped) return s;
      return {
        selected: next,
        lastKey: s.lastKey && valid.has(s.lastKey) ? s.lastKey : null,
      };
    }),
}));

/** Reactive selector for a single node. */
export function useIsSelected(key: string): boolean {
  return useTreeSelection((s) => s.selected.has(key));
}

/** Tri-state for a parent node, computed over its descendant keys.
 *  Returns a primitive: a selector handing back a fresh object on every call
 *  breaks zustand v5's snapshot caching. */
export function useGroupState(keys: string[]): "none" | "some" | "all" {
  return useTreeSelection((s) => {
    if (keys.length === 0) return "none";
    let hits = 0;
    for (const k of keys) if (s.selected.has(k)) hits++;
    if (hits === 0) return "none";
    return hits === keys.length ? "all" : "some";
  });
}

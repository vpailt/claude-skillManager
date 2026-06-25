import { create } from "zustand";

export type SettingsSection =
  | "general"
  | "apparence"
  | "connexions"
  | "notifications"
  | "logs"
  | "about";

interface SettingsDialogState {
  open: boolean;
  section: SettingsSection;
  /** Anchor id to scroll into view once the dialog has rendered (deep-link). */
  pendingScroll: string | null;
  setOpen: (open: boolean) => void;
  setSection: (section: SettingsSection) => void;
  /** Open the dialog straight to a section, optionally scrolling to an anchor. */
  openTo: (section: SettingsSection, scrollTo?: string) => void;
  clearPendingScroll: () => void;
}

// Lifted out of the (former) Settings page so the Sidebar button, the tray menu,
// the command palette and the dashboard deep-links can all pop the same dialog
// without prop-drilling. Mirrors `stores/helpDialog.ts`.
export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  section: "general",
  pendingScroll: null,
  setOpen: (open) => set({ open }),
  setSection: (section) => set({ section, pendingScroll: null }),
  openTo: (section, scrollTo) =>
    set({ open: true, section, pendingScroll: scrollTo ?? null }),
  clearPendingScroll: () => set({ pendingScroll: null }),
}));

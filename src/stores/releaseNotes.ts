import { create } from "zustand";

interface ReleaseNotesState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

// Same reason as `helpDialog`: the release-notes panel is opened from two
// unrelated places — the Settings "À propos" card and the update banner — so
// its open state lives outside both rather than being prop-drilled.
export const useReleaseNotes = create<ReleaseNotesState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

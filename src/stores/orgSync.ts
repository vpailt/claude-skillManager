import { create } from "zustand";

interface OrgSyncState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

// The org-sync comparison is reached only through the command palette's hidden
// trigger, so its open state cannot be prop-drilled from a parent that renders
// it — the palette closes itself on the way in. Same shape as `releaseNotes`.
export const useOrgSync = create<OrgSyncState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

import { create } from "zustand";

interface HelpDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

// Lifted out of the Sidebar so the tray menu (and any other detached caller)
// can request the Help dialog without prop-drilling.
export const useHelpDialog = create<HelpDialogState>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),
}));

import { create } from "zustand";

interface TrackingViewState {
  active: boolean;
  setActive: (active: boolean) => void;
}

// Set while the "Suivi Marketplace" tab is mounted. Lets the sidebar Refresh
// button also refresh the marketplace PR tracking (`["tracked-prs"]`) when the
// user is on that view — so the tab needs no dedicated refresh button, and the
// (network-heavy) tracking refetch doesn't fire from refreshes on other pages.
export const useTrackingView = create<TrackingViewState>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));

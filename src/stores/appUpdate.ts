import { create } from "zustand";
import type { StagedUpdate, UpdateEvent } from "@/lib/types";

/**
 * Self-update state, shared between the sidebar pill and the Settings page.
 *
 * Two distinct situations, deliberately not merged:
 * - `staged`: the new binary is **already** on disk (the backend swapped it in
 *   place). Nothing left to install — restarting is what picks it up.
 * - `available`: a newer release exists but we could not install it ourselves
 *   (install directory read-only, or the release ships only an installer). The
 *   user has to go through Settings → Mise à jour — this is the only state that
 *   raises the top banner (`components/UpdateBanner.tsx`).
 */
interface AppUpdateState {
  staged: StagedUpdate | null;
  available: UpdateEvent | null;
  /** Version whose top banner the user waved away. Session-only on purpose:
   *  the sidebar pill still carries the information, and a fresh launch is a
   *  fair moment to mention it again. */
  dismissedVersion: string | null;
  setStaged: (s: StagedUpdate | null) => void;
  setAvailable: (u: UpdateEvent | null) => void;
  dismiss: (version: string) => void;
}

export const useAppUpdate = create<AppUpdateState>((set) => ({
  staged: null,
  available: null,
  dismissedVersion: null,
  // Installing settles the "available" state: there is nothing left for the
  // user to do, so the banner goes away and the sidebar pill takes over.
  setStaged: (staged) => set({ staged, available: null }),
  setAvailable: (available) => set({ available }),
  dismiss: (dismissedVersion) => set({ dismissedVersion }),
}));

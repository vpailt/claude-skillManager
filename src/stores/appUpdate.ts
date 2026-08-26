import { create } from "zustand";
import type { StagedUpdate, UpdateEvent, UpdateProgress } from "@/lib/types";

/**
 * Self-update state, shared between the top banner, the sidebar pill and the
 * Settings page.
 *
 * Three distinct situations, deliberately not merged — they are the banner's
 * three faces, in this order of priority:
 * - `installing`: the user pressed "Installer" and the download is running.
 * - `staged`: the new binary is on disk. Nothing left to install — restarting
 *   is what picks it up.
 * - `available`: a newer release exists and nothing has been downloaded yet.
 *   The backend poller only ever produces this one; it never downloads on its
 *   own (see `src-tauri/src/update_poller.rs`).
 */
interface AppUpdateState {
  staged: StagedUpdate | null;
  available: UpdateEvent | null;
  /** True from the click on "Installer" until the attempt settles. This — not
   *  `progress` — is what says an install is running: it is set synchronously
   *  by the caller, so a progress event that arrives late (after the command
   *  resolved) can be dropped instead of leaving the banner stuck on a bar. */
  installing: boolean;
  /** Latest progress tick, or null before the first one arrives. */
  progress: UpdateProgress | null;
  /** Last install failure, shown in the banner until the next attempt. */
  installError: string | null;
  /** Version whose top banner the user waved away. Nothing else shows a
   *  pending release — the sidebar pill only covers `staged` — so this hides
   *  the offer outright until a newer version appears or the app restarts.
   *  The durable record is the Rust process's (`app_update_dismiss`); this copy
   *  only makes the bar disappear on the click, since the store itself dies
   *  with the webview on a tray close. See `dismissUpdate()`. */
  dismissedVersion: string | null;
  setStaged: (s: StagedUpdate | null) => void;
  setAvailable: (u: UpdateEvent | null) => void;
  setInstalling: (running: boolean) => void;
  setProgress: (p: UpdateProgress | null) => void;
  setInstallError: (e: string | null) => void;
  dismiss: (version: string) => void;
}

export const useAppUpdate = create<AppUpdateState>((set) => ({
  staged: null,
  available: null,
  installing: false,
  progress: null,
  installError: null,
  dismissedVersion: null,
  // Installing settles the "available" state: there is nothing left to
  // download, so the banner switches to its "restart when you like" face.
  // `dismissedVersion` is cleared too — the user waved away an *offer*, not the
  // notice that a restart is now pending.
  setStaged: (staged) =>
    set({
      staged,
      available: null,
      installing: false,
      progress: null,
      installError: null,
      dismissedVersion: null,
    }),
  // A failure recorded against one release says nothing about the next one,
  // and the banner renders it next to whatever version is current — so a new
  // release clears it.
  setAvailable: (available) =>
    set((s) =>
      s.available?.version === available?.version
        ? { available }
        : { available, installError: null }
    ),
  setInstalling: (installing) =>
    set(installing ? { installing, progress: null } : { installing }),
  setProgress: (progress) => set({ progress }),
  setInstallError: (installError) => set({ installError }),
  dismiss: (dismissedVersion) => set({ dismissedVersion }),
}));

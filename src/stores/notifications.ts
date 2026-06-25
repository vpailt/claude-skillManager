import { create } from "zustand";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { createLogger } from "@/lib/logger";

const log = createLogger("notifications");

export type NotificationKind = "info" | "success" | "warning" | "error";

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  createdAt: number;
}

interface PushOptions {
  /** Also raise a native OS toast (system tray). Default: false.
   *  Suppressed when `nativeEnabled` is false in the store. */
  native?: boolean;
  /** Force native regardless of the global toggle — only set to true from the
   *  explicit "Test notification" button. */
  force?: boolean;
}

/** Per-kind enablement of native toasts, synced from settings. All default on. */
export type NativeKinds = Record<NotificationKind, boolean>;

const ALL_KINDS_ON: NativeKinds = {
  info: true,
  success: true,
  warning: true,
  error: true,
};

interface State {
  items: Notification[];
  /** Set by App.tsx: when the main window is hidden, prefer native toasts. */
  windowHidden: boolean;
  /** Master switch synced from settings. Defaults to true. */
  nativeEnabled: boolean;
  /** Per-kind native gating synced from settings. AND-ed with `nativeEnabled`. */
  nativeKinds: NativeKinds;
  setWindowHidden: (hidden: boolean) => void;
  setNativeEnabled: (enabled: boolean) => void;
  setNativeKinds: (kinds: NativeKinds) => void;
  push: (
    n: Omit<Notification, "id" | "createdAt">,
    opts?: PushOptions
  ) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

let permissionChecked = false;
let permissionGranted = false;

async function ensurePermission(): Promise<boolean> {
  if (permissionChecked) return permissionGranted;
  permissionChecked = true;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const r = await requestPermission();
      granted = r === "granted";
    }
    permissionGranted = granted;
    return granted;
  } catch (e) {
    log.warn("notification permission check failed", e);
    return false;
  }
}

async function fireNative(title: string, body?: string) {
  try {
    const ok = await ensurePermission();
    if (!ok) return;
    sendNotification({ title, body });
  } catch (e) {
    log.warn("native notification failed", e);
  }
}

export const useNotifications = create<State>((set, get) => ({
  items: [],
  windowHidden: false,
  nativeEnabled: true,
  nativeKinds: { ...ALL_KINDS_ON },
  setWindowHidden: (hidden) => set({ windowHidden: hidden }),
  setNativeEnabled: (enabled) => set({ nativeEnabled: enabled }),
  setNativeKinds: (kinds) => set({ nativeKinds: kinds }),
  push: (n, opts) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((s) => ({
      items: [
        { ...n, id, createdAt: Date.now() },
        ...s.items.slice(0, 19),
      ],
    }));
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((it) => it.id !== id) }));
    }, 8000);

    const state = get();
    const askedNative = opts?.native ?? state.windowHidden;
    const kindAllowed = state.nativeKinds[n.kind] ?? true;
    // `force` (the explicit Test button) bypasses both the master switch and the
    // per-kind gating so it can always verify the Windows permission.
    const wantNative =
      opts?.force || (askedNative && state.nativeEnabled && kindAllowed);
    if (wantNative) {
      void fireNative(n.title, n.body);
    }
  },
  dismiss: (id) =>
    set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
  clear: () => set({ items: [] }),
}));

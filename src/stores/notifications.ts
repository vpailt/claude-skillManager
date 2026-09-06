import { create } from "zustand";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { createLogger } from "@/lib/logger";
import { api } from "@/lib/api";

const log = createLogger("notifications");

export type NotificationKind = "info" | "success" | "warning" | "error";

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  createdAt: number;
  /** Optional in-app action run when the toast is clicked (e.g. open a file).
   *  Kept only in memory — never persisted. */
  onClick?: () => void;
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

/** How many past notifications the bell keeps. Old enough to answer "what did
 *  that toast say?", short enough that the panel stays scannable. */
const HISTORY_MAX = 50;

interface State {
  /** Live toasts. Each one is removed on its own timer after 8 s. */
  items: Notification[];
  /** What the status bar's bell shows. Same notifications, but they stay:
   *  `items` is a display queue that empties itself, so before this existed a
   *  toast the user did not happen to be looking at was gone for good. Entries
   *  leave only when dismissed from the panel. */
  history: Notification[];
  /** Pushed since the panel was last opened — the count on the bell. */
  unread: number;
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
  /** Drop one entry from the bell's list (its × button). */
  dismissHistory: (id: string) => void;
  /** Empty the bell's list. */
  clearHistory: () => void;
  /** The panel was opened: the badge goes back to zero. */
  markRead: () => void;
  /** Read the persisted list back at startup. */
  hydrate: () => Promise<void>;
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
  history: [],
  unread: 0,
  windowHidden: false,
  nativeEnabled: true,
  nativeKinds: { ...ALL_KINDS_ON },
  setWindowHidden: (hidden) => set({ windowHidden: hidden }),
  setNativeEnabled: (enabled) => set({ nativeEnabled: enabled }),
  setNativeKinds: (kinds) => set({ nativeKinds: kinds }),
  push: (n, opts) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const entry: Notification = { ...n, id, createdAt: Date.now() };
    set((s) => ({
      items: [entry, ...s.items.slice(0, 19)],
      history: [entry, ...s.history].slice(0, HISTORY_MAX),
      unread: s.unread + 1,
    }));
    // Only the *toast* expires. The history entry stays until it is dismissed
    // from the panel, which is the whole point of having one.
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((it) => it.id !== id) }));
    }, 8000);
    // Fire-and-forget: the notification is already on screen and in the store,
    // and failing to write it to disk must not break the operation that raised
    // it — which is usually the one the user actually asked for.
    void api
      .notificationsPush({
        id,
        kind: n.kind,
        title: n.title,
        body: n.body ?? null,
        createdAt: entry.createdAt,
      })
      .catch((e) => log.warn("could not persist notification", e));

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
  // Dismissing a toast closes the toast, not the record of it: the × on a toast
  // means "stop showing me this now", and the bell is where it is looked up
  // afterwards. `dismissHistory` is the one that forgets.
  dismiss: (id) =>
    set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
  clear: () => set({ items: [] }),
  // The disk write follows the store, it does not gate it: the panel must react
  // to the click at once, and a failed write leaves an entry that comes back on
  // the next launch — an annoyance, not a loss.
  dismissHistory: (id) => {
    set((s) => ({ history: s.history.filter((it) => it.id !== id) }));
    void api
      .notificationsRemove(id)
      .catch((e) => log.warn("could not forget notification", e));
  },
  clearHistory: () => {
    set({ history: [] });
    void api
      .notificationsClear()
      .catch((e) => log.warn("could not clear notifications", e));
  },
  markRead: () => set({ unread: 0 }),
  // Called once at startup. `unread` stays at zero on purpose: a badge counts
  // what arrived while you were not looking *this session*, and reopening the
  // app to a count of everything since last week would only train the user to
  // ignore it.
  hydrate: async () => {
    try {
      const stored = await api.notificationsList();
      set((s) => {
        // Anything pushed while this was in flight wins — it is newer, and it
        // has already been written to the same file.
        const seen = new Set(s.history.map((it) => it.id));
        const restored = stored
          .filter((it) => !seen.has(it.id))
          .map((it) => ({
            id: it.id,
            kind: it.kind,
            title: it.title,
            body: it.body ?? undefined,
            createdAt: it.createdAt,
          }));
        return {
          history: [...s.history, ...restored].slice(0, HISTORY_MAX),
        };
      });
    } catch (e) {
      log.warn("could not read the notification history", e);
    }
  },
}));

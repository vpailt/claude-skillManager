import { create } from "zustand";
import type { UiPrefs } from "@/lib/types";
import { api } from "@/lib/api";
import { createLogger } from "@/lib/logger";

const log = createLogger("ui-prefs");

const STORAGE_KEY = "skillmanager.ui-prefs";

export const DEFAULT_UI: UiPrefs = {
  prPollingEnabled: true,
  prPollingIntervalSeconds: 60,
  density: "comfortable",
  theme: "auto",
  sidebarCollapsed: false,
  sidebarWidth: 240,
  startMinimized: false,
  closeToTray: true,
  releaseUiOnTray: true,
  nativeNotificationsEnabled: true,
  notifySuccess: true,
  notifyInfo: true,
  notifyWarning: true,
  notifyError: true,
  autoUpdateEnabled: true,
  autoUpdateIntervalHours: 6,
  catalogPollEnabled: true,
  catalogPollIntervalMinutes: 30,
};

interface UiState {
  ui: UiPrefs;
  setUi: (u: UiPrefs) => void;
  patch: (partial: Partial<UiPrefs>) => void;
  patchPersisted: (partial: Partial<UiPrefs>) => void;
}

function applyTheme(theme: UiPrefs["theme"]) {
  const root = document.documentElement;
  const dark =
    theme === "dark" ||
    (theme === "auto" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) root.classList.add("dark");
  else root.classList.remove("dark");
}

function applyDensity(density: UiPrefs["density"]) {
  const root = document.documentElement;
  if (density === "compact") root.classList.add("compact");
  else root.classList.remove("compact");
}

function load(): UiPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_UI;
    return { ...DEFAULT_UI, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_UI;
  }
}

const initial = load();
applyTheme(initial.theme);
applyDensity(initial.density);

if (window.matchMedia) {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const current = useUi.getState().ui;
      if (current.theme === "auto") applyTheme("auto");
    });
}

export const useUi = create<UiState>((set, get) => ({
  ui: initial,
  setUi: (ui) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ui));
    applyTheme(ui.theme);
    applyDensity(ui.density);
    set({ ui });
  },
  patch: (partial) => {
    const next = { ...get().ui, ...partial };
    get().setUi(next);
  },
  // `localStorage` alone is not enough for a preference the user sets from the
  // chrome rather than from the Settings dialog: `App.tsx` re-seeds this store
  // from `config.properties` on every mount, and tray mode destroys the window
  // on every close — so the sidebar's width and collapsed state would be reset
  // by the ordinary way of using the app, not merely by a restart. The write is
  // fire-and-forget: the store (and the UI) has already moved, and
  // `properties::write_atomic` skips a byte-identical rewrite.
  patchPersisted: (partial) => {
    get().patch(partial);
    void api
      .settingsSetUi(get().ui)
      .catch((e) => log.warn("settingsSetUi failed", e));
  },
}));

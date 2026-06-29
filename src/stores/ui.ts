import { create } from "zustand";
import type { UiPrefs } from "@/lib/types";

const STORAGE_KEY = "skillmanager.ui-prefs";

export const DEFAULT_UI: UiPrefs = {
  prPollingEnabled: true,
  prPollingIntervalSeconds: 60,
  density: "comfortable",
  theme: "auto",
  sidebarCollapsed: false,
  startMinimized: false,
  closeToTray: true,
  nativeNotificationsEnabled: true,
  notifySuccess: true,
  notifyInfo: true,
  notifyWarning: true,
  notifyError: true,
};

interface UiState {
  ui: UiPrefs;
  setUi: (u: UiPrefs) => void;
  patch: (partial: Partial<UiPrefs>) => void;
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
}));

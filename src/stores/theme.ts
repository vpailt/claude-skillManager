// Theme is now driven by `stores/ui.ts` (UiPrefs.theme).
// This file is kept only as a thin re-export shim for any lingering import.
export { useUi as useTheme } from "./ui";

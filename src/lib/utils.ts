import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { api } from "./api";
import { createLogger } from "./logger";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const log = createLogger("openExternal");

/**
 * Open a URL or filesystem path externally via ShellExecuteW. Works for both
 * `https://…` (browser) and raw folder paths (Explorer). `tauri-plugin-opener`
 * v2 has scope restrictions that silently drop unscoped URLs, so we route
 * everything through our own Rust command instead.
 */
export async function openExternal(target: string | undefined | null) {
  const t = (target ?? "").trim();
  if (!t) {
    log.warn("empty target");
    return;
  }
  try {
    await api.openInShell(t);
    log.debug("opened", t);
  } catch (err) {
    log.warn("open_in_shell failed, falling back to window.open", err);
    try {
      window.open(t, "_blank", "noopener,noreferrer");
    } catch (err2) {
      log.error("window.open failed", err2);
    }
  }
}

export function shortDate(iso: string | undefined | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

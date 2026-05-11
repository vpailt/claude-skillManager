import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createLogger } from "./logger";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const log = createLogger("openExternal");

/**
 * Open a URL externally. Falls back to window.open if the Tauri opener
 * plugin fails (missing capability, empty URL, etc.).
 */
export async function openExternal(url: string | undefined | null) {
  const target = (url ?? "").trim();
  if (!target) {
    log.warn("empty URL");
    return;
  }
  try {
    await openUrl(target);
    log.debug("opened", target);
  } catch (err) {
    log.warn("tauri opener failed, falling back", err);
    try {
      window.open(target, "_blank", "noopener,noreferrer");
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

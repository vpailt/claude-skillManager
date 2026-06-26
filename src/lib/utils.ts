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

/**
 * Bump a semver-ish string by patch/minor/major — a TS mirror of the Rust
 * `admin::bump_version`, used to pre-fill version fields reactively in the
 * wizards without a backend round-trip. Strips a leading `v`, pads to 3
 * components, and falls back to "0.1.0" when the input isn't numeric.
 */
export function bumpSemver(
  version: string | undefined | null,
  level: "patch" | "minor" | "major"
): string {
  const raw = (version ?? "").trim().replace(/^v/i, "");
  if (!raw) return "0.1.0";
  const nums: number[] = [];
  for (const part of raw.split(".")) {
    const head = part.split("-")[0];
    const n = Number.parseInt(head, 10);
    if (Number.isNaN(n)) return `${raw}.1`;
    nums.push(n);
  }
  while (nums.length < 3) nums.push(0);
  if (level === "major") {
    nums[0] += 1;
    nums[1] = 0;
    nums[2] = 0;
  } else if (level === "minor") {
    nums[1] += 1;
    nums[2] = 0;
  } else {
    nums[2] += 1;
  }
  return `${nums[0]}.${nums[1]}.${nums[2]}`;
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

// Frontend logger. Mirrors the Rust `tracing` levels and forwards to the
// backend's `logging_log` command so the entry lands in
// `<exe_dir>/logs/skillmanager.<date>.log` alongside backend events.
//
// Falls back gracefully if the invoke call fails (eg before the backend has
// finished booting) — we never want logging to break the app.

import type { LogLevel } from "./types";
import { api } from "./api";

const LEVEL_ORDER: Record<LogLevel, number> = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  TRACE: 4,
};

// Default front-end threshold; dynamically updated from Settings.
let threshold: LogLevel = "INFO";

export function setFrontendLogLevel(level: LogLevel) {
  threshold = level;
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[threshold];
}

function send(level: LogLevel, target: string, message: string) {
  // Mirror to the JS console so devtools still shows everything.
  const consoleFn =
    level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : level === "DEBUG" || level === "TRACE"
          ? console.debug
          : console.info;
  consoleFn.call(console, `[${target}]`, message);

  if (!shouldEmit(level)) return;
  // Fire and forget. Swallow errors — we don't want a logging failure to
  // bubble up.
  api.loggingLog(level, target, message).catch(() => {});
}

function fmt(parts: unknown[]): string {
  return parts
    .map((p) => {
      if (p instanceof Error) return p.stack ?? p.message;
      if (typeof p === "string") return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(" ");
}

export function createLogger(target: string) {
  return {
    error: (...parts: unknown[]) => send("ERROR", target, fmt(parts)),
    warn: (...parts: unknown[]) => send("WARN", target, fmt(parts)),
    info: (...parts: unknown[]) => send("INFO", target, fmt(parts)),
    debug: (...parts: unknown[]) => send("DEBUG", target, fmt(parts)),
    trace: (...parts: unknown[]) => send("TRACE", target, fmt(parts)),
  };
}

export const log = createLogger("app");

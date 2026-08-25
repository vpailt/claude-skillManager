// Bridges the backend skill sync watcher to the frontend store.
//
// This hook used to *derive* the watched folder set (installed skills under
// editable marketplaces) and push it to Rust on every change. Two problems with
// that: the set was gated on `m.editable`, which is `can_push` on the forge, so
// it collapsed to empty the moment the VPN dropped — detection stopped exactly
// when local edits pile up unnoticed; and it made the frontend responsible for
// something that has to keep working with no frontend at all.
//
// The refresh sweep in Rust now owns the watched set and settles every status
// (`commands::feed_skill_watch`). What is left here is genuinely a view concern:
// seed the store after a refresh, and follow the live event.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { useSkillSync } from "@/stores/skillSync";
import { createLogger } from "@/lib/logger";
import type { SkillSyncState } from "@/lib/types";

const log = createLogger("skill-watch");

export function useSkillWatch() {
  const marketplaces = useApp((s) => s.marketplaces);
  const setMany = useSkillSync((s) => s.setMany);
  const setOne = useSkillSync((s) => s.setOne);

  // Re-seed whenever a refresh lands: the sweep just recomputed every status.
  useEffect(() => {
    api
      .skillSyncList()
      .then(setMany)
      .catch((e) => log.error("skillSyncList failed:", e));
  }, [marketplaces, setMany]);

  // Live updates from the filesystem watcher (optimistic — the next sweep
  // confirms or corrects them).
  useEffect(() => {
    const un = listen<SkillSyncState>("skill-sync-changed", (e) => {
      setOne(e.payload.folder, e.payload.status);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [setOne]);
}

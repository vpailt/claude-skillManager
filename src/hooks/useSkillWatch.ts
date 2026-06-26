// Bridges the backend skill-change watcher to the frontend dirty store.
//
// - Derives the set of folders worth watching: installed skills under *editable*
//   marketplaces (the ones "Pousser la modification" can target). Re-arms the
//   backend watcher whenever that set changes and seeds the badge map from the
//   returned dirty state (which also reflects edits made while the app was shut).
// - Listens to the `skill-dirty` event for real-time flips while the app runs.
//
// Mounted once at the app root so detection stays live across tab switches.
import { useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { useSkillDirty } from "@/stores/skillDirty";
import { createLogger } from "@/lib/logger";
import type { SkillDirtyState } from "@/lib/types";

const log = createLogger("skill-watch");

export function useSkillWatch() {
  const marketplaces = useApp((s) => s.marketplaces);
  const setMany = useSkillDirty((s) => s.setMany);
  const setOne = useSkillDirty((s) => s.setOne);

  const folders = useMemo(() => {
    const out: string[] = [];
    for (const m of marketplaces) {
      if (!m.editable) continue;
      for (const p of m.plugins) {
        for (const s of p.skills) {
          if (s.folder) out.push(s.folder);
        }
      }
    }
    return Array.from(new Set(out)).sort();
  }, [marketplaces]);

  // Re-arm only when the watched set actually changes (refresh re-creates the
  // marketplaces array every 30 min, but the folder list is usually stable).
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const key = folders.join("\n");
    if (key === lastKey.current) return;
    lastKey.current = key;
    api
      .skillWatchSet(folders)
      .then(setMany)
      .catch((e) => log.error("skillWatchSet failed:", e));
  }, [folders, setMany]);

  // Live updates from the filesystem watcher.
  useEffect(() => {
    const un = listen<SkillDirtyState>("skill-dirty", (e) => {
      setOne(e.payload.folder, e.payload.dirty);
    });
    return () => {
      un.then((fn) => fn());
    };
  }, [setOne]);
}

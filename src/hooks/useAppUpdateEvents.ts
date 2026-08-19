import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useAppUpdate } from "@/stores/appUpdate";
import { useNotifications } from "@/stores/notifications";
import type { UpdateEvent } from "@/lib/types";

const log = createLogger("app-update");

/** Relaunch into the binary now on disk. Exported for the UI's restart buttons. */
export async function restartNow() {
  try {
    await api.appRestart();
  } catch (e) {
    log.error("restart failed", e);
    useNotifications.getState().push({
      kind: "error",
      title: "Redémarrage impossible",
      body: String(e),
    });
  }
}

/**
 * Bridge to the Rust self-updater (`src-tauri/src/update_poller.rs`).
 *
 * The update itself happens without us: the backend downloads the new binary
 * and swaps it onto `skillmanager.exe` in place, whether or not a window is
 * open. This hook only reflects that in the UI — a discreet toast, and the
 * sidebar pill fed by `useAppUpdate` — and asks the backend on mount, so a
 * window opened *after* the swap still shows it.
 */
export function useAppUpdateEvents() {
  const setStaged = useAppUpdate((s) => s.setStaged);
  const setAvailable = useAppUpdate((s) => s.setAvailable);
  const push = useNotifications((s) => s.push);

  useEffect(() => {
    // The swap may have happened while no window was alive.
    api
      .appUpdateStaged()
      .then((s) => {
        if (s) {
          log.info(`update ${s.version} already staged (running ${s.runningVersion})`);
          setStaged(s);
        }
      })
      .catch((e) => log.debug("staged check failed", e));

    const ready = listen<UpdateEvent>("app-update-ready", (e) => {
      const p = e.payload;
      log.info(`update ${p.version} staged in place`);
      setStaged({
        version: p.version,
        runningVersion: p.runningVersion,
        releaseNotes: p.releaseNotes,
        releaseUrl: p.releaseUrl,
      });
      // `native: false`: the backend raises the Windows toast itself when no
      // window was visible, so letting the store decide would double up.
      push(
        {
          kind: "success",
          title: `SkillManager ${p.version} est installé`,
          body: "Cliquez pour redémarrer maintenant — sinon la nouvelle version démarrera au prochain lancement.",
          onClick: restartNow,
        },
        { native: false }
      );
    });

    const available = listen<UpdateEvent>("app-update-available", (e) => {
      const p = e.payload;
      log.info(`update ${p.version} available but not self-installable`);
      setAvailable(p);
      push(
        {
          kind: "info",
          title: `SkillManager ${p.version} est disponible`,
          body: "Ouvrez Paramètres → À propos pour lancer la mise à jour.",
        },
        { native: false }
      );
    });

    return () => {
      ready.then((fn) => fn());
      available.then((fn) => fn());
    };
  }, [setStaged, setAvailable, push]);
}

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useAppUpdate } from "@/stores/appUpdate";
import { useNotifications } from "@/stores/notifications";
import type { UpdateEvent, UpdateProgress } from "@/lib/types";

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
 * Hide the update banner for this version.
 *
 * Recorded on **both** sides: the store so the bar goes away now, and the Rust
 * process so it stays away. The store dies with the webview — tray mode
 * destroys it on every close — and the banner is re-seeded on mount from
 * `app_update_available`, so a store-only dismissal would come back every time
 * the window is reopened.
 */
export async function dismissUpdate(version: string) {
  useAppUpdate.getState().dismiss(version);
  try {
    await api.appUpdateDismiss(version);
  } catch (e) {
    log.debug("dismiss not recorded backend-side", e);
  }
}

/**
 * Download and install the latest release. The single implementation behind
 * every "Installer" button — the banner and the Settings card both call this,
 * and both read the resulting progress from `useAppUpdate`.
 *
 * Nothing downloads before this runs: the backend poller only announces (see
 * `src-tauri/src/update_poller.rs`). We re-check on the way in rather than
 * trusting the event payload, because the announcement may be hours old and
 * `AppUpdateInfo` carries the asset URLs the backend needs.
 */
export async function startUpdate() {
  const store = useAppUpdate.getState();
  if (store.installing) return;
  store.setInstallError(null);
  // Set synchronously, before the first await: the banner has to switch the
  // second the button is pressed (fetching the release metadata takes a
  // moment), and this flag is also what gates late progress events.
  store.setInstalling(true);
  // The installer fallback never comes back: it spawns NSIS and the process
  // exits ~500 ms later. Letting `finally` clear `installing` would drop the
  // banner back to a live "Installer" button for the last moments of the
  // session — so that branch keeps the installing face until the app goes.
  let terminal = false;
  try {
    const info = await api.appCheckUpdate();
    if (!info.hasUpdate) {
      log.info("startUpdate: already up to date");
      useAppUpdate.getState().setAvailable(null);
      useNotifications.getState().push({
        kind: "info",
        title: "Aucune mise à jour",
        body: `Vous utilisez déjà la dernière version (${info.currentVersion}).`,
      });
      return;
    }
    if (info.canSelfUpdate) {
      log.info(`startUpdate: applying ${info.latestVersion} in place`);
      // The backend emits `app-update-ready`; the listener below settles the
      // store and raises the toast, so there is nothing to do with the result.
      await api.appApplyUpdate(info);
      return;
    }
    if (info.installerAssetUrl && info.installerAssetName) {
      log.info(`startUpdate: falling back to the installer for ${info.latestVersion}`);
      terminal = true;
      // Resolves as soon as the installer is spawned; the app exits right
      // after, so this is the last state the user sees.
      await api.appInstallUpdate(info.installerAssetUrl, info.installerAssetName);
      useAppUpdate.getState().setProgress({
        version: info.latestVersion ?? "",
        phase: "installing",
        downloaded: 0,
        total: 0,
      });
      return;
    }
    throw new Error(
      "Cette release ne contient ni binaire autonome installable ici, ni installateur. " +
        "Téléchargez-la manuellement depuis GitHub."
    );
  } catch (e) {
    const message = String(e);
    terminal = false;
    log.error("startUpdate failed", e);
    useAppUpdate.getState().setInstallError(message);
    useNotifications.getState().push({
      kind: "error",
      title: "Mise à jour impossible",
      body: message,
    });
  } finally {
    if (!terminal) {
      useAppUpdate.getState().setInstalling(false);
      useAppUpdate.getState().setProgress(null);
    }
  }
}

/**
 * Bridge to the Rust self-updater (`src-tauri/src/update_poller.rs`).
 *
 * The backend detects, the user decides: the poller announces a new release
 * through `app-update-available` and downloads nothing. Pressing "Installer"
 * runs [`startUpdate`], which streams the download — `app-update-progress`
 * feeds the bar — and ends on `app-update-ready` once the binary is swapped.
 *
 * The staged state is also asked for on mount, so a window opened *after* an
 * install (tray mode destroys and rebuilds it) still shows the restart offer.
 */
export function useAppUpdateEvents() {
  const setStaged = useAppUpdate((s) => s.setStaged);
  const setAvailable = useAppUpdate((s) => s.setAvailable);
  const setProgress = useAppUpdate((s) => s.setProgress);
  const push = useNotifications((s) => s.push);

  useEffect(() => {
    // Tray mode destroys the window, so this one may have been built long after
    // the install — or after the announcement that raised the banner. Ask for
    // both, in order: a staged update settles the question, and only if there
    // is none does a pending release still matter.
    api
      .appUpdateStaged()
      .then(async (s) => {
        if (s) {
          log.info(`update ${s.version} already staged (running ${s.runningVersion})`);
          setStaged(s);
          return;
        }
        const pending = await api.appUpdateAvailable();
        if (pending) {
          log.info(`update ${pending.version} pending since a previous window`);
          // No toast: this is a rehydration, not news.
          setAvailable(pending);
        }
      })
      .catch((e) => log.debug("update state check failed", e));

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
      // The poller re-emits every tick so a window built later still learns
      // about the release; the toast, though, is news only the first time.
      const known = useAppUpdate.getState().available?.version;
      setAvailable(p);
      if (known === p.version) return;
      log.info(`update ${p.version} available (self-installable: ${p.canSelfUpdate})`);
      push(
        {
          kind: "info",
          title: `SkillManager ${p.version} est disponible`,
          body: "Cliquez sur Installer dans le bandeau en haut de la fenêtre.",
        },
        { native: false }
      );
    });

    const progress = listen<UpdateProgress>("app-update-progress", (e) => {
      // Event delivery isn't ordered against the command's own response, so a
      // final tick can land after `startUpdate` has already settled. Dropping
      // it here is what keeps the banner from freezing on a stale bar.
      if (!useAppUpdate.getState().installing) return;
      setProgress(e.payload);
    });

    return () => {
      ready.then((fn) => fn());
      available.then((fn) => fn());
      progress.then((fn) => fn());
    };
  }, [setStaged, setAvailable, setProgress, push]);
}

import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { NotificationStack } from "@/components/NotificationStack";
import { UpdateBanner } from "@/components/UpdateBanner";
import { StatusBar } from "@/components/StatusBar";
import { useRefresh } from "@/hooks/useRefresh";
import { usePrPolling } from "@/hooks/usePrPolling";
import { useTrayEvents } from "@/hooks/useTrayEvents";
import { useTaskbarBadge } from "@/hooks/useTaskbarBadge";
import { useSkillWatch } from "@/hooks/useSkillWatch";
import { useBackendEvents } from "@/hooks/useBackendEvents";
import { useAppUpdateEvents } from "@/hooks/useAppUpdateEvents";
import { useUi } from "@/stores/ui";
import { useNotifications } from "@/stores/notifications";
import { useReleaseNotes } from "@/stores/releaseNotes";
import { useOrgSync } from "@/stores/orgSync";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { createLogger, setFrontendLogLevel } from "@/lib/logger";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { OverviewPage } from "@/pages/Overview";
import { SkillsPage } from "@/pages/Skills";

// Split out of the entry chunk. Admin drags in the diff viewer, the audit page
// its charts and export plumbing, and the Settings dialog the whole Gitea /
// logging surface — none of which is needed to render the two default tabs.
// Each is fetched the first time it is actually opened.
const AdminPage = lazy(() =>
  import("@/pages/Admin").then((m) => ({ default: m.AdminPage }))
);
const UsageAuditPage = lazy(() =>
  import("@/pages/UsageAudit").then((m) => ({ default: m.UsageAuditPage }))
);
const ChangesPage = lazy(() =>
  import("@/pages/Changes").then((m) => ({ default: m.ChangesPage }))
);
const SettingsDialog = lazy(() =>
  import("@/components/SettingsDialog").then((m) => ({
    default: m.SettingsDialog,
  }))
);
const CommandPalette = lazy(() =>
  import("@/components/CommandPalette").then((m) => ({
    default: m.CommandPalette,
  }))
);
// Renders release bodies through SkillMarkdown, i.e. the whole markdown +
// highlight.js stack. Mounted only while open so none of it is fetched until
// someone actually asks for the notes.
const ReleaseNotesDialog = lazy(() =>
  import("@/components/ReleaseNotesDialog").then((m) => ({
    default: m.ReleaseNotesDialog,
  }))
);
// Reached only through the command palette's hidden `sforge-labs` entry, so it
// has no business being in any chunk that loads on startup.
const OrgSyncDialog = lazy(() =>
  import("@/components/OrgSyncDialog").then((m) => ({
    default: m.OrgSyncDialog,
  }))
);

function PageFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      Chargement…
    </div>
  );
}

const appLog = createLogger("app");

export default function App() {
  // Kick off the refresh on mount; nested pages read from the store.
  useRefresh();
  // Background PR status polling (driven by Settings → PR polling toggle).
  usePrPolling();
  // Tray menu → frontend bridge (refresh, open settings).
  useTrayEvents();
  // Taskbar overlay badge: number of "actions à traiter".
  useTaskbarBadge();
  // Reflect the backend's skill sync statuses (the Rust sweep settles them).
  useSkillWatch();
  // Backend noticed something moved (disk, ~/.claude, catalogue) → re-refresh.
  useBackendEvents();
  // Self-update: reflect what the Rust updater did (or couldn't do) in the UI.
  useAppUpdateEvents();

  // Track window visibility so notifications can prefer native toasts when
  // the window is hidden in the tray.
  const setWindowHidden = useNotifications((s) => s.setWindowHidden);
  useEffect(() => {
    const w = getCurrentWindow();
    let unlistenFocus: (() => void) | undefined;
    w.isVisible()
      .then((v) => setWindowHidden(!v))
      .catch(() => {});
    w.onFocusChanged(({ payload: focused }) => {
      if (focused) setWindowHidden(false);
    })
      .then((fn) => {
        unlistenFocus = fn;
      })
      .catch(() => {});
    const onVis = () => {
      if (document.visibilityState === "hidden") setWindowHidden(true);
      else setWindowHidden(false);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      unlistenFocus?.();
    };
  }, [setWindowHidden]);

  // Sync persisted UI prefs into the local zustand store.
  const setUi = useUi((s) => s.setUi);
  const setNativeEnabled = useNotifications((s) => s.setNativeEnabled);
  const setNativeKinds = useNotifications((s) => s.setNativeKinds);
  const settings = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });
  useEffect(() => {
    if (settings.data?.ui) {
      const u = settings.data.ui;
      setUi(u);
      setNativeEnabled(u.nativeNotificationsEnabled);
      setNativeKinds({
        success: u.notifySuccess,
        info: u.notifyInfo,
        warning: u.notifyWarning,
        error: u.notifyError,
      });
    }
  }, [settings.data?.ui, setUi, setNativeEnabled, setNativeKinds]);

  // Pull current log level so the FE logger filters in sync with the backend.
  const logCfg = useQuery({
    queryKey: ["logging-config"],
    queryFn: api.loggingGetConfig,
  });
  useEffect(() => {
    if (logCfg.data) setFrontendLogLevel(logCfg.data.level);
  }, [logCfg.data]);

  // Global error capture: route uncaught errors and rejections to the logger.
  useEffect(() => {
    appLog.info("UI mounted");
    const onError = (e: ErrorEvent) => {
      appLog.error("window.onerror", e.message, e.filename, e.lineno);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      appLog.error("unhandledrejection", e.reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const releaseNotesOpen = useReleaseNotes((s) => s.open);
  const orgSyncOpen = useOrgSync((s) => s.open);

  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // Column, not row: the update banner spans the full width above both the
    // sidebar and the page, and `min-h-0` keeps the row below it scrollable
    // instead of pushing the layout past the viewport when the banner shows.
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex min-w-0 flex-1 overflow-hidden">
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              {/* Anciens menus Plugins / Skills V2 fusionnés dans /skills */}
              <Route path="/plugins" element={<Navigate to="/skills" replace />} />
              <Route
                path="/skills-v2"
                element={<Navigate to="/skills" replace />}
              />
              <Route path="/changes" element={<ChangesPage />} />
              <Route path="/tracking" element={<AdminPage />} />
              {/* Ancien onglet Administration, réduit au suivi des PR */}
              <Route path="/admin" element={<Navigate to="/tracking" replace />} />
              <Route path="/audit" element={<UsageAuditPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
      {/* Permanent status bar: version, forge connections, progress. Outside
          the row above so it spans the sidebar too, and `shrink-0` so the
          scrollable page never eats into it. */}
      <StatusBar />
      {/* No fallback: both mount hidden and render nothing until opened. */}
      <Suspense fallback={null}>
        {paletteOpen && (
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        )}
        {releaseNotesOpen && <ReleaseNotesDialog />}
        {orgSyncOpen && <OrgSyncDialog />}
        <SettingsDialog />
      </Suspense>
      <NotificationStack />
    </div>
  );
}

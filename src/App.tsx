import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { TitleBar } from "@/components/TitleBar";
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
import { useUi, toggleSidebar } from "@/stores/ui";
import { useSettingsDialog } from "@/stores/settingsDialog";
import { useHelpDialog } from "@/stores/helpDialog";
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
// Traçabilité. Both read the log files and nothing else, so neither belongs in
// the entry chunk — you reach them by asking for them.
const ActivityPage = lazy(() =>
  import("@/pages/Activity").then((m) => ({ default: m.ActivityPage }))
);
const LogsPage = lazy(() =>
  import("@/pages/Logs").then((m) => ({ default: m.LogsPage }))
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
    // A panel too: a lazy page arriving a beat later must not flash the bare
    // chrome where the sub-window is about to be.
    <div className="panel flex h-full w-full items-center justify-center text-sm text-muted-foreground">
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

  // Read the persisted notification history back. Tray mode destroys the
  // webview on every close, so this runs on far more than app launches — it is
  // what makes the bell's list survive the ordinary way of using the app.
  const hydrateNotifications = useNotifications((s) => s.hydrate);
  useEffect(() => {
    void hydrateNotifications();
  }, [hydrateNotifications]);

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
    // The shortcuts the title bar's menus advertise. They live here rather than
    // in `TitleBar` because they must work with no menu open, and because a
    // menu that names a shortcut nothing implements is worse than no menu.
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useSettingsDialog.getState().openTo("general");
      } else if (e.key === "F1") {
        e.preventDefault();
        useHelpDialog.getState().setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // The window is one continuous chrome surface — sidebar and status bar are
    // the same sheet, with no border between them — and everything else is a
    // sub-window laid on it, separated by a gutter rather than by a rule.
    // Column, not row: the status bar spans the sidebar too, and `min-h-0`
    // keeps the row above it scrollable instead of pushing the layout past the
    // viewport.
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-chrome text-foreground">
      {/* The window has no decorations of its own — this bar is the title bar:
          menus, search, and the three window buttons. */}
      <TitleBar onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {/* The gutter lives here: padding on this column is what holds the page
            off the sidebar, the window edge and the status bar. The update
            banner is a sub-window of its own, stacked above the page. */}
        <div className="flex min-w-0 flex-1 flex-col gap-gutter p-gutter">
          <UpdateBanner />
          {/* Not a panel itself: a page is one sub-window, but a split page is
              two, side by side in the same gutter (see `ResizableSplit`). The
              panel is therefore drawn by what the route renders, never here —
              otherwise a split would sit framed inside a second frame. */}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route path="/" element={<OverviewPage />} />
                <Route path="/skills" element={<SkillsPage />} />
                {/* Anciens menus Plugins / Skills V2 fusionnés dans /skills */}
                <Route
                  path="/plugins"
                  element={<Navigate to="/skills" replace />}
                />
                <Route
                  path="/skills-v2"
                  element={<Navigate to="/skills" replace />}
                />
                <Route path="/changes" element={<ChangesPage />} />
                <Route path="/tracking" element={<AdminPage />} />
                {/* Ancien onglet Administration, réduit au suivi des PR */}
                <Route
                  path="/admin"
                  element={<Navigate to="/tracking" replace />}
                />
                <Route path="/audit" element={<UsageAuditPage />} />
                <Route path="/activity" element={<ActivityPage />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </main>
        </div>
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

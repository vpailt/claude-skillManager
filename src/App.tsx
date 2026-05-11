import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { NotificationStack } from "@/components/NotificationStack";
import { useRefresh } from "@/hooks/useRefresh";
import { usePrPolling } from "@/hooks/usePrPolling";
import { useTrayEvents } from "@/hooks/useTrayEvents";
import { useUi } from "@/stores/ui";
import { useNotifications } from "@/stores/notifications";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { createLogger, setFrontendLogLevel } from "@/lib/logger";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { OverviewPage } from "@/pages/Overview";
import { PluginsPage } from "@/pages/Plugins";
import { SkillsPage } from "@/pages/Skills";
import { AdminPage } from "@/pages/Admin";
import { SettingsPage } from "@/pages/Settings";

const appLog = createLogger("app");

export default function App() {
  // Kick off the refresh on mount; nested pages read from the store.
  useRefresh();
  // Background PR status polling (driven by Settings → PR polling toggle).
  usePrPolling();
  // Tray menu → frontend bridge (refresh, open settings).
  useTrayEvents();

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
  const settings = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });
  useEffect(() => {
    if (settings.data?.ui) {
      setUi(settings.data.ui);
      setNativeEnabled(settings.data.ui.nativeNotificationsEnabled);
    }
  }, [settings.data?.ui, setUi, setNativeEnabled]);

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
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
      <main className="flex min-w-0 flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/plugins" element={<PluginsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <NotificationStack />
    </div>
  );
}

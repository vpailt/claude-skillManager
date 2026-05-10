import { Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { useRefresh } from "@/hooks/useRefresh";
import { OverviewPage } from "@/pages/Overview";
import { PluginsPage } from "@/pages/Plugins";
import { SkillsPage } from "@/pages/Skills";
import { AdminPage } from "@/pages/Admin";
import { SettingsPage } from "@/pages/Settings";

export default function App() {
  // Kick off the refresh on mount; nested pages read from the store.
  useRefresh();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/plugins" element={<PluginsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

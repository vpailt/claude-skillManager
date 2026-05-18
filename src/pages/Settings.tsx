import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Save,
  Download,
  Upload,
  FileJson,
  Eye,
  Trash2,
  RefreshCw,
  FolderOpen,
  Bell,
  CheckCircle2,
  ArrowUpCircle,
  ExternalLink,
} from "lucide-react";
import {
  save as saveDialog,
  open as openDialog,
} from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/api";
import { openExternal } from "@/lib/utils";
import type {
  AppUpdateInfo,
  LogLevel,
  LoggingConfig,
  Settings as SettingsType,
  UiPrefs,
} from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useNotifications } from "@/stores/notifications";
import { setFrontendLogLevel } from "@/lib/logger";

const DEFAULT_UI: UiPrefs = {
  prPollingEnabled: false,
  prPollingIntervalSeconds: 60,
  density: "comfortable",
  theme: "auto",
  sidebarCollapsed: false,
  startMinimized: false,
  closeToTray: true,
  nativeNotificationsEnabled: true,
};

const LEVELS: LogLevel[] = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

export function SettingsPage() {
  const qc = useQueryClient();
  const push = useNotifications((s) => s.push);
  const settingsQuery = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });
  const pathsQuery = useQuery({
    queryKey: ["settings-paths"],
    queryFn: api.settingsPaths,
  });
  const loggingQuery = useQuery({
    queryKey: ["logging-config"],
    queryFn: api.loggingGetConfig,
  });

  const [token, setToken] = useState("");
  const [ui, setUi] = useState<UiPrefs>(DEFAULT_UI);
  const [pollingIntervalDraft, setPollingIntervalDraft] = useState("60");
  const [logCfg, setLogCfg] = useState<LoggingConfig>({
    enabled: true,
    level: "INFO",
    maxFileSizeMb: 10,
    maxFileCount: 5,
  });
  const [logTail, setLogTail] = useState<string>("");
  const [showLogs, setShowLogs] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setToken(settingsQuery.data.githubToken);
      const merged = { ...DEFAULT_UI, ...(settingsQuery.data.ui ?? {}) };
      setUi(merged);
      setPollingIntervalDraft(String(merged.prPollingIntervalSeconds));
    }
  }, [settingsQuery.data]);

  useEffect(() => {
    if (loggingQuery.data) setLogCfg(loggingQuery.data);
  }, [loggingQuery.data]);

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const setTokenMutation = useMutation({
    mutationFn: api.settingsSetToken,
    onSuccess: (s) => {
      qc.setQueryData<SettingsType>(["app-settings"], s);
      qc.invalidateQueries({ queryKey: ["github-auth"] });
      qc.invalidateQueries({ queryKey: ["github-rate"] });
      push({ kind: "success", title: "GitHub token saved" });
    },
    onError: (e) =>
      push({ kind: "error", title: "Save token failed", body: errMsg(e) }),
  });

  const setUiMutation = useMutation({
    mutationFn: api.settingsSetUi,
    onSuccess: (s) => {
      qc.setQueryData<SettingsType>(["app-settings"], s);
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Save UI preferences failed",
        body: errMsg(e),
      }),
  });

  const setLoggingMutation = useMutation({
    mutationFn: api.loggingSetConfig,
    onSuccess: (cfg) => {
      qc.setQueryData<LoggingConfig>(["logging-config"], cfg);
      setFrontendLogLevel(cfg.level);
      push({
        kind: "success",
        title: `Logging ${cfg.enabled ? "enabled" : "disabled"}`,
        body: `Level: ${cfg.level} (changes apply on next start for the file)`,
      });
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Save logging config failed",
        body: errMsg(e),
      }),
  });

  const purgeMutation = useMutation({
    mutationFn: api.loggingPurge,
    onSuccess: (n) => {
      push({
        kind: "success",
        title: "Logs purged",
        body: `${n} file(s) removed`,
      });
      setLogTail("");
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Purge failed",
        body: e instanceof Error ? e.message : String(e),
      }),
  });

  const tailMutation = useMutation({
    mutationFn: () => api.loggingTail(64 * 1024),
    onSuccess: (text) => setLogTail(text),
    onError: (e) =>
      push({ kind: "error", title: "Read log tail failed", body: errMsg(e) }),
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const json = await api.settingsExport();
      const path = await saveDialog({
        title: "Export SkillManager settings",
        defaultPath: "skillmanager-settings.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await api.writeTextFile(path, json);
      return path;
    },
    onSuccess: (p) => {
      if (p)
        push({
          kind: "success",
          title: "Settings exported",
          body: p as string,
        });
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Export failed",
        body: e instanceof Error ? e.message : String(e),
      }),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const path = await openDialog({
        title: "Import SkillManager settings",
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path || typeof path !== "string") return null;
      const text = await api.readTextFile(path);
      return api.settingsImport(text);
    },
    onSuccess: (s) => {
      if (!s) return;
      qc.setQueryData<SettingsType>(["app-settings"], s);
      qc.invalidateQueries({ queryKey: ["refresh"] });
      push({ kind: "success", title: "Settings imported" });
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Import failed",
        body: e instanceof Error ? e.message : String(e),
      }),
  });

  const auth = useQuery({
    queryKey: ["github-auth"],
    queryFn: api.githubAuthCheck,
  });

  const checkUpdateMutation = useMutation({
    mutationFn: api.appCheckUpdate,
    onSuccess: (info) => {
      setUpdateInfo(info);
      if (info.status === "no_release") {
        push({
          kind: "info",
          title: "No release published yet",
          body: "The repo doesn't have a release on GitHub yet.",
        });
      } else if (info.hasUpdate) {
        push({
          kind: "info",
          title: `Update available: ${info.latestVersion}`,
          body: `You're on ${info.currentVersion}.`,
        });
      } else {
        push({
          kind: "success",
          title: "You're up to date",
          body: `Version ${info.currentVersion}`,
        });
      }
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Check for updates failed",
        body: errMsg(e),
      }),
  });

  const installUpdateMutation = useMutation({
    mutationFn: () => {
      if (!updateInfo?.installerAssetUrl || !updateInfo.installerAssetName) {
        return Promise.reject(
          new Error("No installer asset attached to the latest release.")
        );
      }
      return api.appInstallUpdate(
        updateInfo.installerAssetUrl,
        updateInfo.installerAssetName
      );
    },
    onSuccess: () => {
      push({
        kind: "info",
        title: "Installer launched",
        body: "SkillManager will exit so the installer can complete.",
      });
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Install failed",
        body: errMsg(e),
      }),
  });

  const updateUi = (partial: Partial<UiPrefs>) => {
    const next = { ...ui, ...partial };
    setUi(next);
    setUiMutation.mutate(next);
  };

  const updateLog = (partial: Partial<LoggingConfig>) => {
    const next = { ...logCfg, ...partial };
    setLogCfg(next);
    setLoggingMutation.mutate(next);
  };

  const commitInterval = () => {
    const parsed = parseInt(pollingIntervalDraft, 10);
    if (Number.isNaN(parsed) || parsed < 15) {
      setPollingIntervalDraft(String(ui.prPollingIntervalSeconds));
      return;
    }
    updateUi({ prPollingIntervalSeconds: parsed });
  };

  const paths = pathsQuery.data;

  return (
    <div className="h-full min-h-0 overflow-y-auto p-6">
      <h1 className="mb-1 text-2xl font-semibold">Settings</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Portable layout. Files live next to the executable.
      </p>

      {paths && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Paths</CardTitle>
            <CardDescription>
              Everything below sits in the SkillManager folder so the whole
              install can be zipped and moved.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-32 text-muted-foreground">Install</span>
              <code className="truncate">{paths.exeDir}</code>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-32 text-muted-foreground">Config dir</span>
              <code className="flex-1 truncate">{paths.configDir}</code>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => openExternal(paths.configDir)}
              >
                <FolderOpen className="mr-1 h-3 w-3" /> Open
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-32 text-muted-foreground">Logs dir</span>
              <code className="flex-1 truncate">{paths.logsDir}</code>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => openExternal(paths.logsDir)}
              >
                <FolderOpen className="mr-1 h-3 w-3" /> Open
              </Button>
            </div>
            <div className="pt-2 text-muted-foreground">
              <code>config.properties</code>, <code>logging.properties</code>,{" "}
              <code>marketplaces.json</code>, <code>pr_history.json</code> are
              under the config dir.
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowUpCircle className="h-4 w-4" />
            App update
          </CardTitle>
          <CardDescription>
            Check the SkillManager GitHub repo for a newer release. The
            installer is downloaded to <code>%TEMP%</code> and launched; the
            app then exits so it can replace files.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-32 text-muted-foreground">Current version</span>
            <Badge variant="outline">
              {updateInfo?.currentVersion ?? "…"}
            </Badge>
            {updateInfo?.latestVersion && (
              <>
                <span className="w-32 pl-4 text-muted-foreground">
                  Latest on GitHub
                </span>
                <Badge variant={updateInfo.hasUpdate ? "warning" : "success"}>
                  {updateInfo.latestVersion}
                </Badge>
              </>
            )}
          </div>

          {updateInfo?.status === "no_release" && (
            <div className="text-xs text-muted-foreground">
              No release has been published yet on{" "}
              <code>vpailt/claude-skillManager</code>.
            </div>
          )}

          {updateInfo && updateInfo.status === "ok" && !updateInfo.hasUpdate && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 text-emerald-600" />
              You're running the latest version.
            </div>
          )}

          {updateInfo?.hasUpdate &&
            !updateInfo.installerAssetUrl && (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                A newer version is available but no <code>.exe</code> installer
                is attached to the release. Open the release page to download
                manually.
              </div>
            )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => checkUpdateMutation.mutate()}
              disabled={checkUpdateMutation.isPending}
            >
              <RefreshCw
                className={`mr-1 h-3 w-3 ${checkUpdateMutation.isPending ? "animate-spin" : ""}`}
              />
              Check for updates
            </Button>

            {updateInfo?.hasUpdate && updateInfo.installerAssetUrl && (
              <Button
                size="sm"
                onClick={() => installUpdateMutation.mutate()}
                disabled={installUpdateMutation.isPending}
              >
                <Download
                  className={`mr-1 h-3 w-3 ${installUpdateMutation.isPending ? "animate-pulse" : ""}`}
                />
                {installUpdateMutation.isPending
                  ? "Downloading…"
                  : `Download & install ${updateInfo.latestVersion}`}
              </Button>
            )}

            {updateInfo?.releaseUrl && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openExternal(updateInfo.releaseUrl!)}
              >
                <ExternalLink className="mr-1 h-3 w-3" />
                Open release page
              </Button>
            )}
          </div>

          {updateInfo?.hasUpdate && updateInfo.releaseNotes && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-snug whitespace-pre-wrap">
              {updateInfo.releaseNotes}
            </pre>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>GitHub token</CardTitle>
          <CardDescription>
            Personal access token with <code>repo</code> scope (or fine-grained
            with read+write content). Stored in{" "}
            <code className="text-xs">config/config.properties</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              type="password"
              placeholder="github_pat_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button
              onClick={() => setTokenMutation.mutate(token)}
              disabled={setTokenMutation.isPending}
            >
              <Save className="mr-1 h-3 w-3" />
              Save
            </Button>
          </div>
          {auth.data && (
            <div className="text-sm">
              {auth.data[0] ? (
                <Badge variant="success">Authenticated as @{auth.data[1]}</Badge>
              ) : (
                <Badge variant="warning">{auth.data[1]}</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Theme and density apply immediately.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-28 text-muted-foreground">Theme</span>
            <div className="flex gap-1">
              {(["light", "dark", "auto"] as const).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={ui.theme === t ? "default" : "outline"}
                  className="h-7 px-3 text-xs capitalize"
                  onClick={() => updateUi({ theme: t })}
                >
                  {t}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-28 text-muted-foreground">Density</span>
            <div className="flex gap-1">
              {(["comfortable", "compact"] as const).map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant={ui.density === d ? "default" : "outline"}
                  className="h-7 px-3 text-xs capitalize"
                  onClick={() => updateUi({ density: d })}
                >
                  {d}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>System tray</CardTitle>
          <CardDescription>
            SkillManager lives in the Windows notification area (bottom-right,
            near the clock). Right-click the icon for the menu, left-click to
            show or hide the window.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex cursor-pointer items-center gap-3">
            <Switch
              checked={ui.closeToTray}
              onCheckedChange={(v) => updateUi({ closeToTray: v })}
            />
            <span>
              Close window to tray
              <span className="ml-2 text-xs text-muted-foreground">
                (use the tray menu to actually quit)
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-3">
            <Switch
              checked={ui.startMinimized}
              onCheckedChange={(v) => updateUi({ startMinimized: v })}
            />
            <span>
              Start minimized in tray
              <span className="ml-2 text-xs text-muted-foreground">
                (useful if added to Windows startup)
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Notifications Windows
          </CardTitle>
          <CardDescription>
            Toasts natives qui apparaissent dans le Centre de notifications
            (bas-droite). Utilisé pour les changements de statut de PR quand le
            polling est actif, et pour les événements que l'app jugerait
            important même fenêtre cachée.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex cursor-pointer items-center gap-3">
            <Switch
              checked={ui.nativeNotificationsEnabled}
              onCheckedChange={(v) =>
                updateUi({ nativeNotificationsEnabled: v })
              }
            />
            <span>Activer les notifications natives</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                push(
                  {
                    kind: "info",
                    title: "SkillManager",
                    body: "Notification de test — si tu vois ceci en bas à droite, Windows autorise les toasts.",
                  },
                  { force: true }
                )
              }
            >
              <Bell className="mr-1 h-3 w-3" />
              Tester une notification
            </Button>
            <span className="text-xs text-muted-foreground">
              Force une toast indépendamment du toggle ci-dessus, utile pour
              vérifier la permission Windows.
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            Si rien ne s'affiche : vérifie <em>Paramètres Windows → Système →
            Notifications</em> et autorise SkillManager (et que le mode « Ne
            pas déranger » est désactivé).
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>PR status polling</CardTitle>
          <CardDescription>
            Discreetly re-check the status of open PRs every N seconds. Counts
            against your GitHub rate limit — disable on metered tokens.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex cursor-pointer items-center gap-3">
            <Switch
              checked={ui.prPollingEnabled}
              onCheckedChange={(v) => updateUi({ prPollingEnabled: v })}
            />
            <span>Enable PR status polling</span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-28 text-muted-foreground">Interval</span>
            <Input
              type="number"
              min={15}
              step={5}
              className="w-32"
              value={pollingIntervalDraft}
              onChange={(e) => setPollingIntervalDraft(e.target.value)}
              onBlur={commitInterval}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitInterval();
              }}
              disabled={!ui.prPollingEnabled}
            />
            <span className="text-xs text-muted-foreground">
              seconds (min 15, default 60)
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Logging</CardTitle>
          <CardDescription>
            File logs go to{" "}
            <code>logs/skillmanager.&lt;date&gt;.log</code>. Settings persist in{" "}
            <code>config/logging.properties</code>. Enabling/disabling or
            changing the level takes effect at next app start; the level filter
            in the frontend applies immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex cursor-pointer items-center gap-3">
            <Switch
              checked={logCfg.enabled}
              onCheckedChange={(v) => updateLog({ enabled: v })}
            />
            <span>Enable file logging</span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <span className="w-28 text-muted-foreground">Level</span>
            <div className="flex gap-1">
              {LEVELS.map((l) => (
                <Button
                  key={l}
                  size="sm"
                  variant={logCfg.level === l ? "default" : "outline"}
                  className="h-7 px-3 text-xs"
                  onClick={() => updateLog({ level: l })}
                  disabled={!logCfg.enabled}
                >
                  {l}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="w-28 text-muted-foreground">Max files</span>
            <Input
              type="number"
              min={1}
              max={50}
              className="w-24"
              value={logCfg.maxFileCount}
              onChange={(e) =>
                updateLog({
                  maxFileCount: Math.max(1, parseInt(e.target.value, 10) || 1),
                })
              }
              disabled={!logCfg.enabled}
            />
            <span className="text-xs text-muted-foreground">
              kept on disk (daily rotation)
            </span>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                tailMutation.mutate();
                setShowLogs(true);
              }}
              disabled={tailMutation.isPending}
            >
              <Eye className="mr-1 h-3 w-3" />
              View logs
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => purgeMutation.mutate()}
              disabled={purgeMutation.isPending}
            >
              <Trash2 className="mr-1 h-3 w-3" />
              Purge logs
            </Button>
            {showLogs && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => tailMutation.mutate()}
                disabled={tailMutation.isPending}
              >
                <RefreshCw
                  className={`mr-1 h-3 w-3 ${tailMutation.isPending ? "animate-spin" : ""}`}
                />
                Refresh
              </Button>
            )}
          </div>

          {showLogs && (
            <pre className="mt-3 max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-snug">
              {logTail || "(empty — write some events then click Refresh)"}
            </pre>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Export / Import</CardTitle>
          <CardDescription>
            Share your token + marketplace registrations between machines.
            Stored as plain JSON — keep the file private.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => exportMutation.mutate()}
            disabled={exportMutation.isPending}
          >
            <Download className="mr-1 h-3 w-3" />
            Export settings
          </Button>
          <Button
            variant="outline"
            onClick={() => importMutation.mutate()}
            disabled={importMutation.isPending}
          >
            <Upload className="mr-1 h-3 w-3" />
            Import settings
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              const json = await api.settingsExport();
              await navigator.clipboard.writeText(json);
              push({ kind: "success", title: "Settings copied to clipboard" });
            }}
          >
            <FileJson className="mr-1 h-3 w-3" />
            Copy JSON
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

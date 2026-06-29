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
  AlertTriangle,
  Info,
  Palette,
  Plug,
  ScrollText,
  SlidersHorizontal,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  save as saveDialog,
  open as openDialog,
} from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/api";
import { cn, openExternal } from "@/lib/utils";
import type {
  AppUpdateInfo,
  LogLevel,
  LoggingConfig,
  Settings as SettingsType,
  UiPrefs,
  UninstallInfo,
} from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNotifications } from "@/stores/notifications";
import { setFrontendLogLevel } from "@/lib/logger";
import { useAppVersion } from "@/hooks/useAppVersion";
import { GiteaInstancesCard } from "@/components/GiteaInstancesCard";
import {
  useSettingsDialog,
  type SettingsSection,
} from "@/stores/settingsDialog";

const DEFAULT_UI: UiPrefs = {
  prPollingEnabled: true,
  prPollingIntervalSeconds: 60,
  density: "comfortable",
  theme: "auto",
  sidebarCollapsed: false,
  startMinimized: false,
  closeToTray: true,
  nativeNotificationsEnabled: true,
  notifySuccess: true,
  notifyInfo: true,
  notifyWarning: true,
  notifyError: true,
};

const LEVELS: LogLevel[] = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: typeof Palette;
}

// Left-hand navigation, grouped under section headers (Paramètres / Système).
const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: "Paramètres",
    items: [
      { id: "general", label: "Général", icon: SlidersHorizontal },
      { id: "apparence", label: "Apparence", icon: Palette },
      { id: "connexions", label: "Connexions", icon: Plug },
      { id: "notifications", label: "Notifications", icon: Bell },
    ],
  },
  {
    group: "Système",
    items: [
      { id: "logs", label: "Logs", icon: ScrollText },
      { id: "about", label: "À propos", icon: Info },
    ],
  },
];

const SECTION_TITLE: Record<SettingsSection, string> = {
  general: "Général",
  apparence: "Apparence",
  connexions: "Connexions",
  notifications: "Notifications",
  logs: "Logs",
  about: "À propos",
};

// The notification kinds the user can toggle individually for native toasts.
const NOTIFY_KINDS: {
  key: "notifySuccess" | "notifyInfo" | "notifyWarning" | "notifyError";
  label: string;
  hint: string;
}[] = [
  { key: "notifySuccess", label: "Succès", hint: "PR mergée, opération réussie…" },
  { key: "notifyInfo", label: "Informations", hint: "PR fermée, messages d'état…" },
  { key: "notifyWarning", label: "Avertissements", hint: "situations à surveiller" },
  { key: "notifyError", label: "Erreurs", hint: "échecs d'opération" },
];

export function SettingsDialog() {
  const open = useSettingsDialog((s) => s.open);
  const setOpen = useSettingsDialog((s) => s.setOpen);
  const section = useSettingsDialog((s) => s.section);
  const setSection = useSettingsDialog((s) => s.setSection);
  const pendingScroll = useSettingsDialog((s) => s.pendingScroll);
  const clearPendingScroll = useSettingsDialog((s) => s.clearPendingScroll);

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
  const appVersion = useAppVersion();
  const [uninstallDialogOpen, setUninstallDialogOpen] = useState(false);
  const [uninstallInfo, setUninstallInfo] = useState<UninstallInfo | null>(null);

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

  // Deep-link from the dashboard ("Paramètres → Gitea"): once the dialog has
  // opened on the right section, scroll the anchor into view.
  useEffect(() => {
    if (!open || !pendingScroll) return;
    const t = window.setTimeout(() => {
      document
        .getElementById(pendingScroll)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      clearPendingScroll();
    }, 120);
    return () => window.clearTimeout(t);
  }, [open, pendingScroll, section, clearPendingScroll]);

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const setTokenMutation = useMutation({
    mutationFn: api.settingsSetToken,
    onSuccess: (s) => {
      qc.setQueryData<SettingsType>(["app-settings"], s);
      qc.invalidateQueries({ queryKey: ["github-auth"] });
      qc.invalidateQueries({ queryKey: ["github-rate"] });
      push({ kind: "success", title: "Token GitHub enregistré" });
    },
    onError: (e) =>
      push({ kind: "error", title: "Échec de l'enregistrement du token", body: errMsg(e) }),
  });

  const setUiMutation = useMutation({
    mutationFn: api.settingsSetUi,
    onSuccess: (s) => {
      qc.setQueryData<SettingsType>(["app-settings"], s);
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Échec de l'enregistrement des préférences d'interface",
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
        title: `Logs ${cfg.enabled ? "activés" : "désactivés"}`,
        body: `Niveau : ${cfg.level} (les changements s'appliquent au prochain démarrage pour le fichier)`,
      });
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Échec de l'enregistrement de la config des logs",
        body: errMsg(e),
      }),
  });

  const purgeMutation = useMutation({
    mutationFn: api.loggingPurge,
    onSuccess: (n) => {
      push({
        kind: "success",
        title: "Logs purgés",
        body: `${n} fichier(s) supprimé(s)`,
      });
      setLogTail("");
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Échec de la purge",
        body: e instanceof Error ? e.message : String(e),
      }),
  });

  const tailMutation = useMutation({
    mutationFn: () => api.loggingTail(64 * 1024),
    onSuccess: (text) => setLogTail(text),
    onError: (e) =>
      push({ kind: "error", title: "Échec de la lecture des logs", body: errMsg(e) }),
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const json = await api.settingsExport();
      const path = await saveDialog({
        title: "Exporter les paramètres SkillManager",
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
          title: "Paramètres exportés",
          body: p as string,
        });
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Échec de l'export",
        body: e instanceof Error ? e.message : String(e),
      }),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const path = await openDialog({
        title: "Importer les paramètres SkillManager",
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
      push({ kind: "success", title: "Paramètres importés" });
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Échec de l'import",
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
          title: "Aucune release publiée pour le moment",
          body: "Le repo n'a pas encore de release sur GitHub.",
        });
      } else if (info.hasUpdate) {
        push({
          kind: "info",
          title: `Mise à jour disponible : ${info.latestVersion}`,
          body: `Vous êtes en ${info.currentVersion}.`,
        });
      } else {
        push({
          kind: "success",
          title: "Vous êtes à jour",
          body: `Version ${info.currentVersion}`,
        });
      }
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Échec de la vérification des mises à jour",
        body: errMsg(e),
      }),
  });

  const openUninstallDialog = async () => {
    try {
      const info = await api.appDetectUninstaller();
      setUninstallInfo(info);
      setUninstallDialogOpen(true);
    } catch (e) {
      push({
        kind: "error",
        title: "Échec de la détection de la désinstallation",
        body: errMsg(e),
      });
    }
  };

  const uninstallMutation = useMutation({
    mutationFn: api.appUninstall,
    onSuccess: () => {
      setUninstallDialogOpen(false);
      push({
        kind: "info",
        title: "Désinstallateur lancé",
        body: "SkillManager va se fermer pour que Windows puisse terminer la désinstallation.",
      });
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Échec de la désinstallation",
        body: errMsg(e),
      }),
  });

  const installUpdateMutation = useMutation({
    mutationFn: () => {
      if (!updateInfo?.installerAssetUrl || !updateInfo.installerAssetName) {
        return Promise.reject(
          new Error("Aucun installateur attaché à la dernière release.")
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
        title: "Installateur lancé",
        body: "SkillManager va se fermer pour que l'installateur puisse terminer.",
      });
    },
    onError: (e) =>
      push({
        kind: "error",
        title: "Échec de l'installation",
        body: errMsg(e),
      }),
  });

  const updateUi = (partial: Partial<UiPrefs>) => {
    const next = { ...ui, ...partial };
    setUi(next);
    // Optimistically sync the live notification gating so a toast firing between
    // now and when the backend round-trip resolves already uses the new prefs
    // (App.tsx re-syncs from the persisted settings once the mutation lands).
    if ("nativeNotificationsEnabled" in partial) {
      useNotifications.getState().setNativeEnabled(next.nativeNotificationsEnabled);
    }
    if (
      "notifySuccess" in partial ||
      "notifyInfo" in partial ||
      "notifyWarning" in partial ||
      "notifyError" in partial
    ) {
      useNotifications.getState().setNativeKinds({
        success: next.notifySuccess,
        info: next.notifyInfo,
        warning: next.notifyWarning,
        error: next.notifyError,
      });
    }
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

  const renderSection = () => {
    switch (section) {
      case "general":
        return (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Application</CardTitle>
                <CardDescription>
                  Informations générales sur SkillManager.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="w-32 text-muted-foreground">
                    Version actuelle
                  </span>
                  <Badge variant="outline">{appVersion ?? "…"}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Vérifiez les mises à jour depuis{" "}
                  <button
                    type="button"
                    onClick={() => setSection("about")}
                    className="font-medium text-primary hover:underline"
                  >
                    À propos → Mise à jour de l'app
                  </button>
                  .
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Barre d'état système</CardTitle>
                <CardDescription>
                  SkillManager se loge dans la zone de notification Windows (en bas
                  à droite, près de l'horloge). Clic droit sur l'icône pour le
                  menu, clic gauche pour afficher ou masquer la fenêtre.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <label className="flex cursor-pointer items-center gap-3">
                  <Switch
                    checked={ui.closeToTray}
                    onCheckedChange={(v) => updateUi({ closeToTray: v })}
                  />
                  <span>
                    Réduire la fenêtre dans la barre d'état
                    <span className="ml-2 text-xs text-muted-foreground">
                      (utilise le menu de la barre d'état pour quitter réellement)
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-3">
                  <Switch
                    checked={ui.startMinimized}
                    onCheckedChange={(v) => updateUi({ startMinimized: v })}
                  />
                  <span>
                    Démarrer minimisé dans la barre d'état
                    <span className="ml-2 text-xs text-muted-foreground">
                      (utile si ajouté au démarrage de Windows)
                    </span>
                  </span>
                </label>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Polling du statut des PR</CardTitle>
                <CardDescription>
                  Re-vérifie discrètement le statut des PR que vous avez soumises
                  toutes les N secondes, et rafraîchit le « Suivi des marketplaces »
                  au plus une fois par minute (uniquement quand la vue est
                  ouverte). Compte dans votre limite de taux GitHub/Gitea —
                  désactivez-le sur les tokens à quota limité.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <label className="flex cursor-pointer items-center gap-3">
                  <Switch
                    checked={ui.prPollingEnabled}
                    onCheckedChange={(v) => updateUi({ prPollingEnabled: v })}
                  />
                  <span>Activer le polling du statut des PR</span>
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="w-28 text-muted-foreground">Intervalle</span>
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
                    secondes (min 15, par défaut 60)
                  </span>
                </div>
              </CardContent>
            </Card>

          </>
        );

      case "apparence":
        return (
          <Card>
            <CardHeader>
              <CardTitle>Apparence</CardTitle>
              <CardDescription>
                Le thème et la densité s'appliquent immédiatement.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-28 text-muted-foreground">Thème</span>
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
                <span className="w-28 text-muted-foreground">Densité</span>
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
        );

      case "connexions":
        return (
          <>
            <Card>
              <CardHeader>
                <CardTitle>GitHub</CardTitle>
                <CardDescription>
                  Token d'accès personnel (PAT) avec le scope <code>repo</code>,
                  ou fine-grained avec <code>Contents: read+write</code> +{" "}
                  <code>Pull requests: write</code>. Stocké dans le coffre
                  d'identifiants Windows (DPAPI), jamais sur disque. Videz le
                  champ puis enregistrez pour le supprimer.
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
                    Enregistrer
                  </Button>
                </div>
                {auth.data && (
                  <div className="text-sm">
                    {auth.data[0] ? (
                      <Badge variant="success">
                        Authentifié en tant que @{auth.data[1]}
                      </Badge>
                    ) : (
                      <Badge variant="warning">{auth.data[1]}</Badge>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <GiteaInstancesCard />
          </>
        );

      case "notifications":
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bell className="h-4 w-4" />
                Notifications Windows
              </CardTitle>
              <CardDescription>
                Toasts natives qui apparaissent dans le Centre de notifications
                (bas-droite). Utilisées pour les changements de statut de PR quand
                le polling est actif, et pour les événements que l'app jugerait
                importants même fenêtre cachée.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <label className="flex cursor-pointer items-center gap-3">
                <Switch
                  checked={ui.nativeNotificationsEnabled}
                  onCheckedChange={(v) =>
                    updateUi({ nativeNotificationsEnabled: v })
                  }
                />
                <span>Activer les notifications natives</span>
              </label>

              <div className="space-y-2 border-t pt-3">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                  Types de notifications
                </div>
                <p className="text-xs text-muted-foreground">
                  Choisissez quelles catégories peuvent déclencher une toast Windows.
                  Toutes restent visibles dans l'app, quoi qu'il arrive.
                </p>
                {NOTIFY_KINDS.map(({ key, label, hint }) => (
                  <label
                    key={key}
                    className={cn(
                      "flex cursor-pointer items-center gap-3",
                      !ui.nativeNotificationsEnabled && "opacity-50"
                    )}
                  >
                    <Switch
                      checked={ui[key]}
                      disabled={!ui.nativeNotificationsEnabled}
                      onCheckedChange={(v) =>
                        updateUi({ [key]: v } as Partial<UiPrefs>)
                      }
                    />
                    <span>
                      {label}
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({hint})
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    push(
                      {
                        kind: "info",
                        title: "SkillManager",
                        body: "Notification de test — si vous voyez ceci en bas à droite, Windows autorise les toasts.",
                      },
                      { force: true }
                    )
                  }
                >
                  <Bell className="mr-1 h-3 w-3" />
                  Tester une notification
                </Button>
                <span className="text-xs text-muted-foreground">
                  Force une toast indépendamment des réglages ci-dessus, utile pour
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
        );

      case "about":
        return (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ArrowUpCircle className="h-4 w-4" />
                  Mise à jour de l'app
                </CardTitle>
                <CardDescription>
                  Vérifie si une release plus récente est disponible sur le repo
                  GitHub de SkillManager. Si l'app a été installée via
                  l'installateur, le nouvel installateur est téléchargé dans{" "}
                  <code>%TEMP%</code> puis lancé ; l'app se ferme ensuite pour
                  pouvoir remplacer les fichiers.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Fonctionne uniquement si SkillManager a été installé via
                  l'<strong>installateur</strong> (<code>.exe</code> NSIS). En
                  version <strong>portable</strong> (dossier zippé), télécharge la
                  nouvelle version manuellement depuis la page de la release.
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-32 text-muted-foreground">Version actuelle</span>
                <Badge variant="outline">
                  {updateInfo?.currentVersion ?? appVersion ?? "…"}
                </Badge>
                {updateInfo?.latestVersion && (
                  <>
                    <span className="w-32 pl-4 text-muted-foreground">
                      Dernière sur GitHub
                    </span>
                    <Badge variant={updateInfo.hasUpdate ? "warning" : "success"}>
                      {updateInfo.latestVersion}
                    </Badge>
                  </>
                )}
              </div>

              {updateInfo?.status === "no_release" && (
                <div className="text-xs text-muted-foreground">
                  Aucune release n'a encore été publiée sur{" "}
                  <code>vpailt/claude-skillManager</code>.
                </div>
              )}

              {updateInfo &&
                updateInfo.status === "ok" &&
                !updateInfo.hasUpdate && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                    Vous utilisez la dernière version.
                  </div>
                )}

              {updateInfo?.hasUpdate && !updateInfo.installerAssetUrl && (
                <div className="text-xs text-amber-600 dark:text-amber-400">
                  Une version plus récente est disponible mais aucun installateur{" "}
                  <code>.exe</code> n'est attaché à la release. Ouvrez la page de la
                  release pour télécharger manuellement.
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
                  Vérifier les mises à jour
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
                      ? "Téléchargement…"
                      : `Télécharger et installer ${updateInfo.latestVersion}`}
                  </Button>
                )}

                {updateInfo?.releaseUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openExternal(updateInfo.releaseUrl!)}
                  >
                    <ExternalLink className="mr-1 h-3 w-3" />
                    Ouvrir la page de la release
                  </Button>
                )}
              </div>

              {updateInfo?.hasUpdate && updateInfo.releaseNotes && (
                <pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-snug whitespace-pre-wrap">
                  {updateInfo.releaseNotes}
                </pre>
              )}
              </CardContent>
            </Card>

            {paths && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Chemins</CardTitle>
                  <CardDescription>
                    Tout ce qui suit se trouve dans le dossier SkillManager pour
                    que l'installation complète puisse être zippée et déplacée.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-32 text-muted-foreground">Installation</span>
                    <code className="truncate">{paths.exeDir}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-32 text-muted-foreground">Dossier config</span>
                    <code className="flex-1 truncate">{paths.configDir}</code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => openExternal(paths.configDir)}
                    >
                      <FolderOpen className="mr-1 h-3 w-3" /> Ouvrir
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-32 text-muted-foreground">Dossier logs</span>
                    <code className="flex-1 truncate">{paths.logsDir}</code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => openExternal(paths.logsDir)}
                    >
                      <FolderOpen className="mr-1 h-3 w-3" /> Ouvrir
                    </Button>
                  </div>
                  <div className="pt-2 text-muted-foreground">
                    <code>config.properties</code>, <code>logging.properties</code>,{" "}
                    <code>marketplaces.json</code>, <code>pr_history.json</code> sont
                    dans le dossier config.
                  </div>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Export / Import</CardTitle>
                <CardDescription>
                  Partagez votre token + les enregistrements de marketplaces entre
                  plusieurs machines. Stocké en JSON brut — gardez le fichier privé.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => exportMutation.mutate()}
                  disabled={exportMutation.isPending}
                >
                  <Download className="mr-1 h-3 w-3" />
                  Exporter les paramètres
                </Button>
                <Button
                  variant="outline"
                  onClick={() => importMutation.mutate()}
                  disabled={importMutation.isPending}
                >
                  <Upload className="mr-1 h-3 w-3" />
                  Importer les paramètres
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    const json = await api.settingsExport();
                    await navigator.clipboard.writeText(json);
                    push({
                      kind: "success",
                      title: "Paramètres copiés dans le presse-papiers",
                    });
                  }}
                >
                  <FileJson className="mr-1 h-3 w-3" />
                  Copier le JSON
                </Button>
              </CardContent>
            </Card>

            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  Zone de danger
                </CardTitle>
                <CardDescription>
                  Désinstalle SkillManager de cette machine. Exécute le
                  désinstallateur Windows enregistré lors de l'installation ; vos
                  données locales <code>~/.claude/</code> (plugins, skills,
                  marketplaces) ne sont
                  <strong> pas </strong>touchées — seule l'app SkillManager l'est.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  variant="destructive"
                  onClick={openUninstallDialog}
                  disabled={uninstallMutation.isPending}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Désinstaller SkillManager
                </Button>
              </CardContent>
            </Card>
          </>
        );

      case "logs":
        return (
          <Card>
            <CardHeader>
              <CardTitle>Logs</CardTitle>
              <CardDescription>
                Les logs fichier sont écrits dans{" "}
                <code>logs/skillmanager.&lt;date&gt;.log</code>. Les paramètres
                sont persistés dans <code>config/logging.properties</code>.
                L'activation/désactivation ou le changement de niveau prend effet
                au prochain démarrage de l'app ; le filtre de niveau côté frontend
                s'applique immédiatement.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <label className="flex cursor-pointer items-center gap-3">
                <Switch
                  checked={logCfg.enabled}
                  onCheckedChange={(v) => updateLog({ enabled: v })}
                />
                <span>Activer les logs fichier</span>
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <span className="w-28 text-muted-foreground">Niveau</span>
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
                <span className="w-28 text-muted-foreground">Fichiers max</span>
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
                  conservés sur le disque (rotation quotidienne)
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
                  Voir les logs
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => purgeMutation.mutate()}
                  disabled={purgeMutation.isPending}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Purger les logs
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
                    Rafraîchir
                  </Button>
                )}
              </div>

              {showLogs && (
                <pre className="mt-3 max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-snug">
                  {logTail ||
                    "(vide — génère quelques événements puis clique sur Rafraîchir)"}
                </pre>
              )}
            </CardContent>
          </Card>
        );
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[80vh] max-h-[680px] w-full max-w-4xl flex-col gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">Paramètres</DialogTitle>
          <DialogDescription className="sr-only">
            Réglages de SkillManager, organisés par catégorie.
          </DialogDescription>
          <div className="flex min-h-0 flex-1">
            {/* Left navigation */}
            <div className="flex w-56 shrink-0 flex-col border-r bg-card/40">
              <div className="flex items-center gap-2 px-4 py-4">
                <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                  <SettingsIcon className="h-4 w-4" />
                </div>
                <span className="text-sm font-semibold">Paramètres</span>
              </div>
              <ScrollArea className="flex-1">
                <div className="space-y-4 px-2 pb-4">
                  {NAV_GROUPS.map((group) => (
                    <div key={group.group}>
                      <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                        {group.group}
                      </div>
                      <div className="space-y-0.5">
                        {group.items.map(({ id, label, icon: Icon }) => {
                          const active = section === id;
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setSection(id)}
                              className={cn(
                                "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                                active
                                  ? "bg-primary/10 text-primary"
                                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                              )}
                            >
                              <Icon className="h-4 w-4 shrink-0" />
                              <span className="truncate font-medium">{label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>

            {/* Right content panel */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2 border-b px-6 py-4 pr-12">
                <h2 className="text-lg font-semibold leading-none tracking-tight">
                  {SECTION_TITLE[section]}
                </h2>
              </div>
              <ScrollArea className="flex-1">
                <div className="space-y-6 p-6">{renderSection()}</div>
              </ScrollArea>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Uninstall confirmation — nested dialog opened from the Danger section */}
      <Dialog
        open={uninstallDialogOpen}
        onOpenChange={(o) => {
          if (!uninstallMutation.isPending) setUninstallDialogOpen(o);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Désinstaller SkillManager ?
            </DialogTitle>
            <DialogDescription>
              Le désinstallateur Windows va démarrer et supprimer l'application
              SkillManager. L'app se fermera dès que vous confirmez. Vos données
              Claude Code sous <code>~/.claude/</code> restent intactes.
            </DialogDescription>
          </DialogHeader>

          {uninstallInfo && (
            <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-xs">
              <div className="flex gap-2">
                <span className="w-24 text-muted-foreground">Détecté</span>
                <Badge variant={uninstallInfo.kind === "none" ? "warning" : "outline"}>
                  {uninstallInfo.kind === "nsis"
                    ? "uninstall.exe trouvé"
                    : uninstallInfo.kind === "registry"
                      ? "entrée de registre"
                      : "aucun désinstallateur (installation portable)"}
                </Badge>
              </div>
              {uninstallInfo.installLocation && (
                <div className="flex gap-2">
                  <span className="w-24 text-muted-foreground">Emplacement</span>
                  <code className="truncate">{uninstallInfo.installLocation}</code>
                </div>
              )}
              {uninstallInfo.displayVersion && (
                <div className="flex gap-2">
                  <span className="w-24 text-muted-foreground">Version</span>
                  <code>{uninstallInfo.displayVersion}</code>
                </div>
              )}
              {uninstallInfo.kind === "none" && (
                <div className="pt-1 text-amber-600 dark:text-amber-400">
                  Aucun désinstallateur enregistré. Cela ressemble à une
                  installation portable — ferme SkillManager et supprime le
                  dossier manuellement.
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUninstallDialogOpen(false)}
              disabled={uninstallMutation.isPending}
            >
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={() => uninstallMutation.mutate()}
              disabled={
                uninstallMutation.isPending || uninstallInfo?.kind === "none"
              }
            >
              <Trash2 className="mr-1 h-3 w-3" />
              {uninstallMutation.isPending ? "Lancement…" : "Désinstaller maintenant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Typed wrappers around `invoke()` so we never write magic command names twice.
import { invoke } from "@tauri-apps/api/core";
import type {
  AdminDraft,
  AppUpdateInfo,
  ArchivedSkill,
  BumpSuggestion,
  DuplicateSkill,
  GiteaStatus,
  LocalSkill,
  LogLevel,
  LoggingConfig,
  Marketplace,
  MarketplaceConfig,
  PendingPR,
  Plugin,
  PRRecord,
  Provider,
  RefreshResult,
  RemoteSkillInfo,
  Settings,
  SettingsPaths,
  SkillDirtyState,
  TrackedPr,
  UiPrefs,
  UninstallInfo,
  UploadResult,
  UploadSkillArgs,
} from "./types";

export const api = {
  // --- settings ---
  loadAppSettings: () => invoke<Settings>("load_app_settings"),
  saveAppSettings: (settings: Settings) =>
    invoke<void>("save_app_settings", { settings }),
  settingsUpsertMarketplace: (cfg: MarketplaceConfig) =>
    invoke<Settings>("settings_upsert_marketplace", { cfg }),
  settingsRemoveMarketplace: (name: string) =>
    invoke<Settings>("settings_remove_marketplace", { name }),
  deleteMarketplaceCompletely: (name: string) =>
    invoke<Settings>("delete_marketplace_completely", { name }),
  settingsSetToken: (token: string) =>
    invoke<Settings>("settings_set_token", { token }),
  settingsSetUi: (ui: UiPrefs) =>
    invoke<Settings>("settings_set_ui", { ui }),
  settingsExport: () => invoke<string>("settings_export"),
  settingsImport: (payload: string) =>
    invoke<Settings>("settings_import", { payload }),
  settingsPaths: () => invoke<SettingsPaths>("settings_paths"),

  // --- logging ---
  loggingGetConfig: () => invoke<LoggingConfig>("logging_get_config"),
  loggingSetConfig: (cfg: LoggingConfig) =>
    invoke<LoggingConfig>("logging_set_config", { cfg }),
  loggingPurge: () => invoke<number>("logging_purge"),
  loggingTail: (maxBytes?: number) =>
    invoke<string>("logging_tail", { maxBytes: maxBytes ?? null }),
  loggingLog: (level: LogLevel, target: string, message: string) =>
    invoke<void>("logging_log", { level, target, message }),

  // --- refresh ---
  refreshAll: () => invoke<RefreshResult>("refresh_all"),

  // --- plugins ---
  installPlugin: (plugin: Plugin) =>
    invoke<string>("install_plugin_cmd", { plugin }),
  uninstallPlugin: (plugin: Plugin) =>
    invoke<void>("uninstall_plugin_cmd", { plugin }),
  setPluginEnabled: (plugin: string, marketplace: string, value: boolean) =>
    invoke<void>("set_plugin_enabled", { plugin, marketplace, value }),

  // --- marketplaces ---
  installMarketplace: (
    name: string,
    repo: string,
    ref: string,
    autoUpdate: boolean | null,
    provider?: Provider,
    baseUrl?: string
  ) =>
    invoke<string>("install_marketplace_cmd", {
      name,
      repo,
      ref,
      autoUpdate,
      provider: provider ?? "github",
      baseUrl: baseUrl ?? "",
    }),
  uninstallMarketplace: (name: string) =>
    invoke<void>("uninstall_marketplace_cmd", { name }),
  // Uninstall a marketplace and all its installed plugins, but keep it
  // registered (so it can be re-installed). Distinct from
  // deleteMarketplaceCompletely, which also forgets it from settings.
  uninstallMarketplaceCascade: (name: string) =>
    invoke<void>("uninstall_marketplace_cascade", { name }),
  setMarketplaceAutoUpdate: (name: string, value: boolean) =>
    invoke<boolean>("set_marketplace_auto_update", { name, value }),
  checkMarketplaceUpdates: (only?: string) =>
    invoke<{ name: string; updated: boolean; message: string }[]>(
      "check_marketplace_updates",
      { only: only ?? null }
    ),
  parseMarketplaceUrl: (url: string) =>
    invoke<string | null>("parse_marketplace_url", { url }),

  // --- skills / files ---
  listSkillFiles: (folder: string) =>
    invoke<string[]>("list_skill_files", { folder }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, content: string) =>
    invoke<void>("write_text_file", { path, content }),
  fileMtime: (path: string) => invoke<string | null>("file_mtime", { path }),
  openInShell: (target: string) =>
    invoke<void>("open_in_shell", { target }),
  openInVsCode: (path: string) =>
    invoke<void>("open_in_vscode", { path }),
  parseSkillMd: (text: string) =>
    invoke<{ fields: Record<string, string>; body: string }>("parse_skill_md", {
      text,
    }),

  // --- github ---
  githubAuthCheck: () => invoke<[boolean, string]>("github_auth_check"),
  githubRateLimit: () => invoke<[number, number]>("github_rate_limit"),
  githubCanPush: (repo: string) =>
    invoke<boolean>("github_can_push", { repo }),
  githubTokenScopes: () => invoke<string[]>("github_token_scopes"),

  // --- gitea ---
  giteaAuthCheck: (baseUrl: string) =>
    invoke<[boolean, string]>("gitea_auth_check", { baseUrl }),
  giteaStatusAll: () => invoke<GiteaStatus[]>("gitea_status_all"),
  settingsUpsertGiteaInstance: (baseUrl: string, insecureTls: boolean) =>
    invoke<Settings>("settings_upsert_gitea_instance", { baseUrl, insecureTls }),
  settingsRemoveGiteaInstance: (baseUrl: string) =>
    invoke<Settings>("settings_remove_gitea_instance", { baseUrl }),
  settingsSetGiteaToken: (baseUrl: string, token: string) =>
    invoke<Settings>("settings_set_gitea_token", { baseUrl, token }),
  giteaGetToken: (baseUrl: string) =>
    invoke<string>("gitea_get_token", { baseUrl }),

  // --- admin ---
  adminSubmitChanges: (args: {
    repo: string;
    baseBranch: string;
    changes: { path: string; content: number[] }[];
    deletions?: string[];
    prTitle: string;
    prBody?: string;
    branchPrefix: string;
  }) =>
    invoke<{ branch: string; prUrl: string; prNumber: number }>(
      "admin_submit_changes",
      { args }
    ),
  adminCollectSkillFolder: (folder: string, targetSubpath: string) =>
    invoke<{ path: string; content: number[] }[]>("admin_collect_skill_folder", {
      folder,
      targetSubpath,
    }),
  adminFetchRegistry: (repo: string, ref: string) =>
    invoke<{ data: Record<string, unknown>; path: string }>(
      "admin_fetch_registry",
      { repo, ref }
    ),
  adminValidateRegistry: (registry: Record<string, unknown>) =>
    invoke<string[]>("admin_validate_registry", { registry }),
  adminDiff: (oldText: string, newText: string, path: string) =>
    invoke<string>("admin_diff", { old: oldText, new: newText, path }),
  adminBumpVersion: (version: string, level: "patch" | "minor" | "major") =>
    invoke<string>("admin_bump_version", { version, level }),
  adminBuildSkillMd: (name: string, description: string, body: string) =>
    invoke<number[]>("admin_build_skill_md", { name, description, body }),

  // --- PR history ---
  prHistoryList: () => invoke<PRRecord[]>("pr_history_list"),
  prHistoryRemove: (repo: string, number: number) =>
    invoke<void>("pr_history_remove", { repo, number }),
  prHistoryClear: () => invoke<void>("pr_history_clear"),
  prHistoryRefreshStatus: (repo: string, number: number) =>
    invoke<string>("pr_history_refresh_status", { repo, number }),

  // --- pending PRs ---
  pendingPrsList: () => invoke<PendingPR[]>("pending_prs_list"),
  pendingPrsUpsert: (item: PendingPR) =>
    invoke<void>("pending_prs_upsert", { item }),
  pendingPrsRemove: (marketplace: string, plugin: string, action: string) =>
    invoke<void>("pending_prs_remove", { marketplace, plugin, action }),

  // --- marketplace PR tracking ("Suivi Marketplace") ---
  trackedMarketplacePrs: (only?: string) =>
    invoke<TrackedPr[]>("track_marketplace_prs", { only: only ?? null }),

  // --- taskbar overlay badge ("actions à traiter") ---
  setTaskbarBadge: (count: number) =>
    invoke<void>("set_taskbar_badge", { count }),

  // --- admin drafts (wizards) ---
  adminPrepareAddPlugin: (
    marketplace: string,
    sourceUrl: string,
    bumpLevel?: string,
    versionDescription?: string
  ) =>
    invoke<AdminDraft>("admin_prepare_add_plugin", {
      marketplace,
      sourceUrl,
      bumpLevel: bumpLevel ?? null,
      versionDescription: versionDescription ?? null,
    }),
  adminPrepareBumpPlugin: (
    marketplace: string,
    pluginName: string,
    newVersion: string,
    versionDescription?: string
  ) =>
    invoke<AdminDraft>("admin_prepare_bump_plugin", {
      marketplace,
      pluginName,
      newVersion,
      versionDescription: versionDescription ?? null,
    }),
  adminPrepareRemovePlugin: (marketplace: string, pluginName: string) =>
    invoke<AdminDraft>("admin_prepare_remove_plugin", {
      marketplace,
      pluginName,
    }),
  adminPrepareUploadSkill: (args: UploadSkillArgs) =>
    invoke<AdminDraft>("admin_prepare_upload_skill", { args }),
  adminPrepareDeleteSkill: (
    marketplace: string,
    pluginName: string,
    skillName: string
  ) =>
    invoke<AdminDraft>("admin_prepare_delete_skill", {
      marketplace,
      pluginName,
      skillName,
    }),
  adminSubmitDraft: (draft: AdminDraft) =>
    invoke<UploadResult>("admin_submit_draft", { draft }),
  adminCreateTag: (repo: string, tag: string, marketplace?: string) =>
    invoke<string>("admin_create_tag", { repo, tag, marketplace: marketplace ?? null }),
  adminListUserSkills: () => invoke<LocalSkill[]>("admin_list_user_skills"),
  adminListRemoteSkills: (marketplace: string, pluginName: string) =>
    invoke<RemoteSkillInfo[]>("admin_list_remote_skills", {
      marketplace,
      pluginName,
    }),
  adminSuggestBumps: (version: string) =>
    invoke<BumpSuggestion>("admin_suggest_bumps", { version }),

  // --- app self-update ---
  appCheckUpdate: () => invoke<AppUpdateInfo>("app_check_update"),
  appInstallUpdate: (assetUrl: string, assetName: string) =>
    invoke<void>("app_install_update", { assetUrl, assetName }),

  // --- app uninstall ---
  appDetectUninstaller: () => invoke<UninstallInfo>("app_detect_uninstaller"),
  appUninstall: () => invoke<void>("app_uninstall"),

  // --- skill change detection (filesystem watcher) ---
  skillWatchSet: (folders: string[]) =>
    invoke<SkillDirtyState[]>("skill_watch_set", { folders }),
  skillMarkSynced: (folder: string) =>
    invoke<void>("skill_mark_synced", { folder }),
  skillDirtyList: () => invoke<SkillDirtyState[]>("skill_dirty_list"),

  // --- duplicate skills ---
  listDuplicateSkills: () =>
    invoke<DuplicateSkill[]>("list_duplicate_skills"),
  archiveUserSkill: (folder: string) =>
    invoke<string>("archive_user_skill", { folder }),
  listArchivedSkills: () =>
    invoke<ArchivedSkill[]>("list_archived_skills"),
  restoreArchivedSkill: (folder: string) =>
    invoke<string>("restore_archived_skill", { folder }),
};

// Marketplace name used by the backend to surface standalone user skills.
export const LOCAL_MARKETPLACE_NAME = "(local skills)";

// Re-export types for ergonomic imports.
export type {
  Marketplace,
  MarketplaceConfig,
  PendingPR,
  Plugin,
  PRRecord,
  RefreshResult,
  Settings,
};

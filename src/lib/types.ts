// Mirror of src-tauri/src/models.rs — kept in sync by hand.
// Keep field names matching `serde(rename_all = "camelCase")`.

export type InstallState =
  | "not_installed"
  | "installed"
  | "outdated"
  | "local_only"
  | "unknown";

export interface Skill {
  name: string;
  description: string;
  folder?: string | null;
  skillMdPath?: string | null;
  relativePath: string;
  pluginName?: string | null;
  marketplaceName?: string | null;
  remotePresent: boolean;
}

export interface PluginSource {
  kind: string;
  repo: string;
  url: string;
  ref: string;
  path: string;
}

export interface Plugin {
  name: string;
  marketplaceName: string;
  installedVersion?: string | null;
  latestVersion?: string | null;
  installPath?: string | null;
  gitCommitSha?: string | null;
  description: string;
  skills: Skill[];
  remotePresent: boolean;
  installState: InstallState;
  manifest?: Record<string, unknown> | null;
  source?: PluginSource | null;
  enabled?: boolean | null;
  lastUpdated: string;
}

export interface Marketplace {
  name: string;
  sourceKind: string;
  sourceRepo: string;
  sourcePath: string;
  installLocation: string;
  plugins: Plugin[];
  owned: boolean;
  editable: boolean;
  remoteBrowseable: boolean;
  installed: boolean;
  lastUpdated: string;
}

export interface MarketplaceConfig {
  name: string;
  githubRepo: string;
  defaultBranch: string;
  owned: boolean;
  sourcePath: string;
  autoUpdate: boolean;
}

export type UiDensity = "compact" | "comfortable";
export type ThemePref = "light" | "dark" | "auto";
export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

export interface UiPrefs {
  prPollingEnabled: boolean;
  prPollingIntervalSeconds: number;
  density: UiDensity;
  theme: ThemePref;
  sidebarCollapsed: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  nativeNotificationsEnabled: boolean;
}

export interface LoggingConfig {
  enabled: boolean;
  level: LogLevel;
  maxFileSizeMb: number;
  maxFileCount: number;
}

export interface SettingsPaths {
  exeDir: string;
  configDir: string;
  logsDir: string;
  configFile: string;
  marketplacesFile: string;
  loggingFile: string;
}

export interface Settings {
  githubToken: string;
  marketplaces: MarketplaceConfig[];
  ui: UiPrefs;
}

export interface RefreshResult {
  marketplaces: Marketplace[];
  localOnly: Marketplace;
}

export interface PRRecord {
  repo: string;
  number: number;
  title: string;
  branch: string;
  url: string;
  createdAt: string;
  status: string;
  kind: string;
}

export interface PendingPR {
  marketplaceName: string;
  pluginName: string;
  action: "add" | "bump" | "remove" | string;
  prUrl: string;
  prNumber: number;
  branch: string;
  targetRepo: string;
  newVersion: string;
  pluginSourceRepo: string;
  createdAt: string;
}

// ----- Admin wizards -----

export interface DiffEntry {
  path: string;
  /** "add" | "modify" | "delete" */
  action: string;
  oldContent: string | null;
  newContent: string | null;
  unified: string;
}

export interface ConflictEntry {
  prNumber: number;
  title: string;
  url: string;
  paths: string[];
}

export interface NeedsTag {
  repo: string;
  tag: string;
}

export interface PendingMeta {
  marketplaceName: string;
  pluginName: string;
  action: string;
  newVersion: string;
  pluginSourceRepo: string;
}

export interface FileChange {
  path: string;
  /** Vec<u8> on the wire — comes back as number[]. */
  content: number[];
}

export interface AdminDraft {
  targetRepo: string;
  baseBranch: string;
  branchName: string;
  prTitle: string;
  prBody: string;
  branchPrefix: string;
  changes: FileChange[];
  deletions: string[];
  entries: DiffEntry[];
  problems: string[];
  conflicts: ConflictEntry[];
  needsTag: NeedsTag | null;
  companion: AdminDraft | null;
  pendingMeta: PendingMeta | null;
}

export interface UploadResult {
  branch: string;
  prUrl: string;
  prNumber: number;
}

export interface UploadSkillArgs {
  marketplace: string;
  pluginName: string;
  localFolder: string;
  targetName?: string;
  newVersion?: string;
  alsoBumpMarketplace?: boolean;
}

export interface LocalSkill {
  name: string;
  folder: string;
  description: string;
  version: string;
}

export interface RemoteSkillInfo {
  name: string;
  version: string;
  localMatch: LocalSkill | null;
}

export interface BumpSuggestion {
  patch: string;
  minor: string;
  major: string;
}

export interface DuplicateCopy {
  folder: string;
  skillMdPath: string;
  version: string;
  description: string;
  lastModified: string;
  /** "(local)" or "<plugin>@<marketplace>" */
  source: string;
  pluginName: string | null;
  marketplaceName: string | null;
}

export interface DuplicateSkill {
  name: string;
  local: DuplicateCopy;
  pluginCopies: DuplicateCopy[];
}

export interface ArchivedSkill {
  name: string;
  originalName: string;
  folder: string;
  skillMdPath: string | null;
  description: string;
  archivedAt: string;
  version: string;
}

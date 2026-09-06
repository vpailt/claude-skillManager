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
  /** The path the sync watcher keys this skill's status on. Same as `folder`
   *  when installed; also set for a skill the remote has but the disk does not,
   *  so a locally deleted skill can still carry a status. Key badges on
   *  `watchFolder ?? folder`, never on `folder` alone. */
  watchFolder?: string | null;
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
  /** Whether the plugin repo's skill listing was actually read this refresh.
   *  `false` means we could not look, so every `remotePresent: false` below is
   *  meaningless — don't read absence as "this skill is a local addition". */
  skillsRemoteKnown: boolean;
  /** The tracked ref moved since this version was installed, with no version
   *  bump. Distinct from `installState: "outdated"`, which means a new version
   *  was published. */
  remoteContentChanged: boolean;
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

export type Provider = "github" | "gitea";

/** Mirror of `commands::ForgeGuess`: which forge a pasted URL points at. */
export interface ForgeGuess {
  provider: Provider;
  /** Instance root for Gitea, empty for GitHub. */
  baseUrl: string;
  /** `owner/repo`, empty when the URL carries none. */
  repo: string;
  host: string;
  /** False when the host is neither github.com nor a registered Gitea instance. */
  known: boolean;
}

export interface MarketplaceConfig {
  name: string;
  /** `owner/repo` on the marketplace's host (field name kept for back-compat). */
  githubRepo: string;
  defaultBranch: string;
  owned: boolean;
  sourcePath: string;
  autoUpdate: boolean;
  /** Track open PRs on this marketplace's repo + its plugins' repos. */
  trackPrs?: boolean;
  /** Forge hosting this marketplace. Absent → "github". */
  provider?: Provider;
  /** Gitea instance root (e.g. https://git.almaviacx.local). Empty for GitHub. */
  baseUrl?: string;
}

export interface GiteaInstance {
  /** Instance root, e.g. https://git.almaviacx.local */
  baseUrl: string;
  /** Skip TLS verification — internal/self-signed CAs only. */
  insecureTls: boolean;
  /** Computed: whether a token is stored for this host. */
  hasToken: boolean;
}

export interface GiteaStatus {
  /** Instance root, e.g. https://git.almaviacx.local */
  baseUrl: string;
  /** Bare host, e.g. git.almaviacx.local */
  host: string;
  hasToken: boolean;
  insecureTls: boolean;
  ok: boolean;
  /** Login when authenticated, else a short status/error message. */
  user: string;
}

/** Mirror of `org_sync::status` on the Rust side. */
export type OrgSyncStatus =
  | "upToDate"
  | "behind"
  | "new"
  | "diverged"
  | "empty"
  | "error";

export interface RepoComparison {
  /** Name on Gitea, e.g. acx-cl-salesforce */
  source: string;
  /** Name on GitHub, e.g. cl-salesforce */
  target: string;
  branch: string;
  status: OrgSyncStatus;
  /** Commits waiting to be replayed. */
  pending: number;
  /** Human-readable explanation; carries the reason for diverged/error. */
  detail: string;
  headSha: string;
  anchorSha: string;
}

export interface SyncReport {
  giteaUrl: string;
  giteaOrg: string;
  githubOrg: string;
  repos: RepoComparison[];
  /** Present on GitHub with no Gitea counterpart. Reported, never deleted. */
  orphans: string[];
}

export interface RepoOutcome {
  source: string;
  target: string;
  status: "synced" | "created" | "skipped" | "cancelled" | "error";
  replayed: number;
  detail: string;
}

export interface SyncProgress {
  repo: string;
  phase: "compare" | "create" | "replay" | "ref" | "done";
  /** Commits replayed so far, out of `total`. */
  done: number;
  total: number;
  /** Files handled within the current commit, out of `stepTotal`.
   *  An incremental sync usually replays a single commit, so this is the
   *  counter that actually moves. */
  step: number;
  stepTotal: number;
  detail: string;
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
  /**
   * Width of the expanded sidebar, in pixels. Untouched by a collapse, so
   * re-opening the bar returns it to the width the user dragged it to rather
   * than to the default.
   */
  sidebarWidth: number;
  startMinimized: boolean;
  closeToTray: boolean;
  /**
   * When hiding to tray, destroy the window instead of hiding it, freeing the
   * WebView2 processes it owns. Re-showing rebuilds the UI (a second or two).
   */
  releaseUiOnTray: boolean;
  /** Master switch for Windows native toasts; AND-ed with the per-kind flags. */
  nativeNotificationsEnabled: boolean;
  /** Per-kind gating of native toasts. Each defaults to true. */
  notifySuccess: boolean;
  notifyInfo: boolean;
  notifyWarning: boolean;
  notifyError: boolean;
  /** Check GitHub in the background and swap the new binary in place. */
  autoUpdateEnabled: boolean;
  /** Hours between background update checks (floored at 1 by the backend). */
  autoUpdateIntervalHours: number;
  /** Sweep marketplaces and plugin repos from the Rust poller. Without it
   *  nothing detects an upstream change once the window is closed — in tray
   *  mode the webview is destroyed, so this query stops existing. */
  catalogPollEnabled: boolean;
  /** Minutes between catalogue sweeps (floored at 5 by the backend). */
  catalogPollIntervalMinutes: number;
}

/** Payload of the backend `pr-status-changed` event (see `pr_poller.rs`). */
export interface PrStatusChange {
  repo: string;
  number: number;
  title: string;
  /** `"merged"` or `"closed"` — transitions away from open only. */
  status: string;
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
  giteaInstances: GiteaInstance[];
  ui: UiPrefs;
}

export interface RefreshResult {
  marketplaces: Marketplace[];
  localOnly: Marketplace;
}

/** Why a sweep is being asked for — mirrors `commands::RefreshMode`.
 *
 *  - `auto`  a background trigger; the backend may answer from its reuse window.
 *  - `local` this app just changed the install state on disk. Never reused, and
 *            deliberately cheap: it skips the manifest probes for plugins nobody
 *            installed, which are the bulk of a sweep's wall clock.
 *  - `user`  the user pressed Rafraîchir: no reuse, every host's failure tally
 *            cleared, full probing. */
export type RefreshMode = "auto" | "local" | "user";

export interface PRRecord {
  repo: string;
  number: number;
  title: string;
  branch: string;
  url: string;
  createdAt: string;
  status: string;
  kind: string;
  /** Forge hosting this PR. Absent (old records) → "github". */
  provider?: Provider;
  /** Gitea instance root for Gitea PRs; empty for GitHub. */
  baseUrl?: string;
}

export interface PendingPR {
  marketplaceName: string;
  pluginName: string;
  action:
    | "add"
    | "bump"
    | "remove"
    | "add-skill"
    | "update-skill"
    | "delete-skill"
    | string;
  prUrl: string;
  prNumber: number;
  branch: string;
  targetRepo: string;
  newVersion: string;
  pluginSourceRepo: string;
  skillName: string;
  /** Skill's own SKILL.md version for skill PRs; distinct from newVersion
   *  (the plugin's bumped manifest version). */
  skillVersion: string;
  /** Tags/releases waiting for this PR to merge before they can be created
   *  (their version only exists on the PR branch until then). */
  deferredTags?: TagSpec[];
  createdAt: string;
}

/** One open PR surfaced by the marketplace tracker ("Suivi Marketplace").
 *  These are all open PRs on a tracked marketplace's repo and its plugins'
 *  repos, regardless of author — distinct from {@link PRRecord}. */
export interface TrackedPr {
  marketplaceName: string;
  /** "marketplace" | "plugin" */
  scope: "marketplace" | "plugin" | string;
  /** Plugin name for plugin-scoped PRs; empty for marketplace-scoped. */
  pluginName: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  /** True when the PR was opened by the current forge user ("Mes demandes"). */
  mine: boolean;
  /** Whether the current user may approve this PR ("Demandes à valider").
   *  Hybrid: branch-protection approvals whitelist when set, else push rights. */
  canApprove: boolean;
  /** PR target branch (`base.ref`). */
  baseBranch: string;
  createdAt: string;
  provider?: Provider;
  baseUrl?: string;
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

export interface TagSpec {
  repo: string;
  tag: string;
  /** Free-text release notes; empty → a default body is used. */
  description: string;
  /** Cut from the PR branch (carries the bump) vs. the repo's default HEAD. */
  fromPrBranch: boolean;
}

export interface PendingMeta {
  marketplaceName: string;
  pluginName: string;
  action: string;
  newVersion: string;
  pluginSourceRepo: string;
  skillName: string;
  skillVersion: string;
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
  tags: TagSpec[];
  companion: AdminDraft | null;
  pendingMeta: PendingMeta | null;
  /** One pending record per skill for a multi-skill upload (they share the PR). */
  pendingMetas?: PendingMeta[];
}

export interface UploadResult {
  branch: string;
  prUrl: string;
  prNumber: number;
}

export type BumpLevel = "patch" | "minor" | "major";

export interface UploadSkillArgs {
  marketplace: string;
  pluginName: string;
  localFolder: string;
  targetName?: string;
  /** Skill version stamped on SKILL.md. The wizard pre-fills the incremented
   *  value; empty → backend derives it from `bumpLevel`. */
  newVersion?: string;
  /** Shared bump level driving BOTH the plugin version and the skill version
   *  pre-fill: "patch" (default), "minor", "major". */
  bumpLevel?: BumpLevel;
  /** Free-text release notes for the tag/release and PR body. */
  versionDescription?: string;
}

/** One skill in a bulk upload (all items target the same plugin). */
export interface BulkSkillItem {
  localFolder: string;
  /** Defaults to the local folder name when empty. */
  targetName?: string;
  /** Skill version stamped on SKILL.md; empty → derived from bumpLevel. */
  newVersion?: string;
}

/** Upload several skills to ONE plugin in a single PR. */
export interface BulkUploadArgs {
  marketplace: string;
  pluginName: string;
  items: BulkSkillItem[];
  /** Skill folder names to delete from the repo, in the SAME PR as the uploads
   *  (a separate delete PR would bump the same manifest and conflict). */
  removals?: string[];
  bumpLevel?: BumpLevel;
  versionDescription?: string;
}

/** Args for `add_skill_to_plugin` — scaffold a blank skill or copy one in. */
export interface AddSkillArgs {
  plugin: Plugin;
  mode: "blank" | "copy";
  name: string;
  description?: string;
  body?: string;
  /** Source folder to copy, for mode === "copy". */
  sourceFolder?: string;
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

/** Where a local skill folder stands relative to its plugin's remote repo.
 *  Mirror of `models.rs::SkillSync`.
 *
 *  - `synced`   contents identical to the remote (git blob SHAs match)
 *  - `modified` the remote has it and the local copy differs *because you
 *               changed it* — the folder no longer hashes to the last
 *               confirmed sync
 *  - `outdated` the local copy differs because *upstream moved on*: the folder
 *               is untouched, a newer plugin version exists. Not pushable —
 *               pushing would send the older content back over the release
 *  - `new`      the remote does not have it — a local addition to push
 *  - `deleted`  the remote has it, the local folder is gone
 *  - `unknown`  the remote could not be read and no reference settles it */
export type SkillSyncStatus =
  | "synced"
  | "modified"
  | "outdated"
  | "new"
  | "deleted"
  | "unknown";

/** One skill folder's sync state, from the backend watcher
 *  (`skill_sync_list` / the `skill-sync-changed` event). */
export interface SkillSyncState {
  folder: string;
  status: SkillSyncStatus;
}

/** Counts carried by the `catalog-changed` event from the Rust catalogue
 *  poller. Mirror of `catalog_poller.rs::CatalogCounts`. */
export interface CatalogCounts {
  outdated: number;
  contentChanged: number;
  skillsToPush: number;
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

export interface AppUpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  /** Standalone binary (.exe or .zip) — the asset the in-place update uses. */
  portableAssetName: string | null;
  portableAssetUrl: string | null;
  portableAssetSize: number;
  /** NSIS/MSI installer — fallback only. */
  installerAssetName: string | null;
  installerAssetUrl: string | null;
  installerAssetSize: number;
  /** Portable asset present *and* install directory writable. */
  canSelfUpdate: boolean;
  releaseNotes: string;
  /** "no_release" or "ok" */
  status: string;
}

/** An update already written onto skillmanager.exe; live at the next launch. */
/** Mirror of `logger::LogFileInfo` — one log file, as the Logs page lists them.
 *  `name` is a file name and never a path: it is what `loggingReadFile` takes
 *  back, and keeping paths out of the round trip is what makes traversal
 *  impossible. */
export interface LogFileInfo {
  name: string;
  size: number;
  /** Epoch milliseconds. */
  modified: number;
}

/** Mirror of `notification_history::StoredNotification`. One notification as it
 *  is kept on disk — the bell's list. `onClick` has no counterpart here: it is
 *  a closure, so a restored entry is text and nothing else. */
export interface StoredNotification {
  id: string;
  kind: "info" | "success" | "warning" | "error";
  title: string;
  body?: string | null;
  /** Epoch milliseconds, same clock as `Date.now()`. */
  createdAt: number;
}

export interface StagedUpdate {
  version: string;
  runningVersion: string;
  releaseNotes: string;
  releaseUrl: string | null;
}

/** Payload of the `app-update-ready` / `app-update-available` backend events. */
export interface UpdateEvent {
  version: string;
  runningVersion: string;
  releaseNotes: string;
  releaseUrl: string | null;
  /** True for `app-update-ready`: the binary is already swapped in. */
  staged: boolean;
  /** In-place swap possible; false means the installer fallback takes over. */
  canSelfUpdate: boolean;
}

/** Where a user-triggered update currently is. Mirrors `UpdatePhase` in Rust. */
export type UpdatePhase = "downloading" | "verifying" | "installing";

/** Payload of `app-update-progress`. `total` is 0 while the size is unknown. */
export interface UpdateProgress {
  version: string;
  phase: UpdatePhase;
  downloaded: number;
  total: number;
}

/** One published release, as listed in the "Notes de mise à jour" panel. */
export interface ReleaseNote {
  /** Tag, e.g. `v3.2.0`. */
  version: string;
  name: string;
  /** ISO-8601 as GitHub returns it. */
  publishedAt: string;
  /** Release body, markdown. */
  body: string;
  url: string | null;
  prerelease: boolean;
}

export interface UninstallInfo {
  /** "nsis" (uninstall.exe found), "registry" (matched by InstallLocation), or "none" (portable install) */
  kind: "nsis" | "registry" | "none" | string;
  uninstallerPath: string | null;
  installLocation: string | null;
  displayName: string | null;
  displayVersion: string | null;
}

// --- Usage audit ---

export interface PluginUsage {
  plugin: string;
  /** Marketplace it's installed from, or "" if the used plugin isn't installed. */
  marketplace: string;
  installed: boolean;
  total: number;
  skillCount: number;
  agentCount: number;
  commandCount: number;
}

/** One usage day and how many invocations happened on it. */
export interface DayCount {
  /** "YYYY-MM-DD" (local day). */
  date: string;
  count: number;
}

/** A skill's usage within one project: how many times, on which days. */
export interface ProjectUsage {
  /** Project display name (last segment of its root path). */
  project: string;
  /** Project root path, for opening in VS Code. "" if never captured. */
  path: string;
  count: number;
  /** Per-day counts, ascending by date. No times. */
  dates: DayCount[];
}

export interface SkillUsage {
  /** Full invocation id ("<plugin>:<skill>" or a bare local skill name). */
  skill: string;
  /** Namespace prefix, or "" for an unprefixed local skill. */
  plugin: string;
  count: number;
  /** Per-project breakdown (count + usage days), ranked by count desc. */
  projects: ProjectUsage[];
}

/** One skill line inside a project aggregate. */
export interface ProjectSkillLine {
  skill: string;
  count: number;
  dates: DayCount[];
}

/** A project's skill usage — the inverse view of SkillUsage. */
export interface ProjectAggregate {
  project: string;
  path: string;
  total: number;
  skills: ProjectSkillLine[];
}

export interface UsageReport {
  /** Echoed ISO filter bounds ("" = unbounded). */
  from: string;
  to: string;
  generatedAt: string;
  totalEvents: number;
  /** All plugins used in the window, ranked by total desc (UI shows top 3). */
  topPlugins: PluginUsage[];
  /** Installed plugins with zero usage in the window. */
  unusedPlugins: string[];
  /** Every skill invoked in the window, ranked by count desc. */
  skills: SkillUsage[];
  /** Skill usage grouped by project, ranked by total desc. */
  projects: ProjectAggregate[];
}

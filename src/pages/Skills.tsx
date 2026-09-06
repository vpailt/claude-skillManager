// Skills — vue unifiée (fusion des anciens menus Plugins et Skills).
//
// Vue arborescente Marketplace → Plugin → Skills :
//  - au niveau plugin : installer/désinstaller, activer/désactiver et le
//    panneau récapitulatif du plugin ;
//  - en dépliant un plugin : la liste de ses skills avec l'arborescence de
//    fichiers et le détail SKILL.md ;
//  - panneaux doublons & archivés ;
//  - filtre des skills par état d'installation (installé / non installé).
import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FileText,
  Filter,
  Folder,
  Globe,
  Info,
  Loader2,
  MoreHorizontal,
  Package,
  PackageMinus,
  Plus,
  Power,
  PowerOff,
  Sparkles,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { forceRefresh } from "@/hooks/useRefresh";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScrollFade } from "@/components/ScrollFade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/stores/app";
import { withTask } from "@/stores/progress";
import { useNotifications } from "@/stores/notifications";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { PAGE_HEADER } from "@/lib/headerStyles";
import { ResizableSplit } from "@/components/ResizableSplit";
import { SkillMarkdown } from "@/components/SkillMarkdown";
import {
  ArchivedSkillDetail,
  DuplicateSkillDetail,
  DuplicateSkillsPanel,
} from "@/components/DuplicateSkillsPanel";
import { ArchivedSkillsPanel } from "@/components/ArchivedSkillsPanel";
import { AddMarketplaceDialog } from "@/components/AddMarketplaceDialog";
import { AddSkillDialog } from "@/components/AdminWizards";
import { BulkActionBar } from "@/components/BulkActionBar";
import { Checkbox } from "@/components/ui/checkbox";
import { useInstallMarketplace } from "@/hooks/useInstallMarketplace";
import {
  mpKey,
  plKey,
  skKey,
  useGroupState,
  useIsSelected,
  useTreeSelection,
} from "@/stores/treeSelection";
import {
  isActionable,
  SYNC_BADGE,
  useSkillStatus,
  useSkillSync,
} from "@/stores/skillSync";
import type {
  ArchivedSkill,
  DuplicateSkill,
  InstallState,
  Marketplace,
  MarketplaceConfig,
  Plugin,
  Skill,
  SkillSyncStatus,
} from "@/lib/types";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- Shared labels (mirrors the Plugins tab) ----------

const STATE_LABEL: Record<InstallState, string> = {
  not_installed: "non installé",
  installed: "installé",
  outdated: "mise à jour disponible",
  local_only: "local uniquement",
  unknown: "inconnu",
};

function stateVariant(s: InstallState) {
  if (s === "installed") return "success" as const;
  if (s === "outdated") return "warning" as const;
  if (s === "local_only") return "secondary" as const;
  return "outline" as const;
}

// Combined install + enabled status, in plain language for non-technical users.
// "Installé" et "activé" sont deux choses distinctes : Claude Code ne charge un
// pack que s'il est activé. On fusionne les deux en un seul statut lisible.
function readiness(
  p: Plugin
): { label: string; variant: "success" | "warning" } | null {
  const installed =
    p.installState === "installed" ||
    p.installState === "outdated" ||
    p.installState === "local_only";
  if (!installed) return null;
  if (p.enabled) return { label: "Prêt à l'emploi", variant: "success" };
  return { label: "Installé mais désactivé", variant: "warning" };
}

// ---------- Skill entry + selection model ----------

interface SkillEntry extends Skill {
  pluginNameSafe: string;
  marketplaceNameSafe: string;
  pluginEnabled: boolean | null;
}

function toEntry(skill: Skill, plugin: Plugin, marketplace: string): SkillEntry {
  return {
    ...skill,
    pluginNameSafe: plugin.name,
    marketplaceNameSafe: marketplace,
    pluginEnabled: plugin.enabled ?? null,
  };
}

function entryKey(s: SkillEntry) {
  return `${s.marketplaceNameSafe}/${s.pluginNameSafe}/${s.name}`;
}

type Selection =
  | { kind: "marketplace"; marketplace: string }
  | { kind: "plugin"; marketplace: string; plugin: string }
  | { kind: "skill"; entry: SkillEntry }
  | { kind: "file"; entry: SkillEntry; relativePath: string }
  | { kind: "duplicate"; value: DuplicateSkill }
  | { kind: "archived"; value: ArchivedSkill }
  | null;

type StateFilter = "all" | "installed" | "not_installed";

const STATE_FILTER_LABELS: Record<StateFilter, string> = {
  all: "Tous",
  installed: "Installés",
  not_installed: "Non installés",
};

function skillInstalled(s: Skill) {
  return !!s.folder;
}

function isLocal(s: SkillEntry, localName: string) {
  return s.marketplaceNameSafe === localName;
}

// ---------- Multi-selection ----------

/** Row checkbox. Stays out of the way until the user hovers a row or has
 *  started a selection, so the tree reads the same as before when unused.
 *  Shift-click extends from the last ticked row, like a file explorer. */
function RowCheckbox({
  keys,
  state,
  label,
  className,
}: {
  /** Every key this row owns. A leaf owns one; a marketplace owns itself plus
   *  each of its visible plugins. */
  keys: string[];
  state: "none" | "some" | "all";
  label: string;
  className?: string;
}) {
  const toggle = useTreeSelection((s) => s.toggle);
  const setMany = useTreeSelection((s) => s.setMany);
  const selectRange = useTreeSelection((s) => s.selectRange);
  const anySelected = useTreeSelection((s) => s.selected.size > 0);

  return (
    <Checkbox
      checked={state === "all"}
      indeterminate={state === "some"}
      aria-label={label}
      title={label}
      className={cn(
        "transition-opacity",
        anySelected
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 focus:opacity-100",
        className
      )}
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey && keys.length === 1) {
          e.preventDefault();
          selectRange(keys[0]);
        }
      }}
      onChange={() => {
        if (keys.length === 1) toggle(keys[0]);
        else setMany(keys, state !== "all");
      }}
    />
  );
}

// ---------- File-tree helpers (mirrors the Skills tab) ----------

function joinPath(folder: string, rel: string): string {
  if (!folder) return rel;
  const trimmed = folder.replace(/[\\/]+$/, "");
  return `${trimmed}/${rel}`;
}

interface TreeNode {
  name: string;
  isDir: boolean;
  children: Record<string, TreeNode>;
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", isDir: true, children: {} };
  for (const raw of paths) {
    const parts = raw.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      if (!node.children[part]) {
        node.children[part] = { name: part, isDir: !last, children: {} };
      }
      node = node.children[part];
      if (!last) node.isDir = true;
    }
  }
  return root;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return Object.values(node.children).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

interface FileNodeRowProps {
  node: TreeNode;
  path: string;
  depth: number;
  expandedDirs: Set<string>;
  onToggle: (path: string) => void;
  onSelectFile: (path: string) => void;
  selectedPath: string | null;
}

function FileNodeRow({
  node,
  path,
  depth,
  expandedDirs,
  onToggle,
  onSelectFile,
  selectedPath,
}: FileNodeRowProps) {
  const isOpen = expandedDirs.has(path);
  const Icon = node.isDir ? Folder : FileText;
  const isSkillMd = !node.isDir && node.name.toUpperCase() === "SKILL.MD";
  const isSelected = !node.isDir && selectedPath === path;
  return (
    <>
      <button
        onClick={() => (node.isDir ? onToggle(path) : onSelectFile(path))}
        className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/40 ${
          isSelected ? "bg-accent text-foreground" : "text-muted-foreground"
        }`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {node.isDir ? (
          isOpen ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )
        ) : (
          <span className="inline-block h-3 w-3 shrink-0" />
        )}
        <Icon
          className={`h-3 w-3 shrink-0 ${isSkillMd ? "text-violet-400" : ""} ${
            node.isDir ? "text-amber-400/80" : ""
          }`}
        />
        <span
          className={`truncate ${
            isSkillMd || isSelected ? "font-medium text-foreground" : ""
          }`}
        >
          {node.name}
        </span>
      </button>
      {node.isDir && isOpen && (
        <>
          {sortedChildren(node).map((c) => (
            <FileNodeRow
              key={`${path}/${c.name}`}
              node={c}
              path={`${path}/${c.name}`}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
            />
          ))}
        </>
      )}
    </>
  );
}

// ---------- Skill row (expandable file tree) ----------

interface SkillTreeRowProps {
  entry: SkillEntry;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onSelectFile: (relativePath: string) => void;
  selectedFilePath: string | null;
  localName: string;
}

function SkillTreeRow({
  entry,
  selected,
  expanded,
  onSelect,
  onToggle,
  onSelectFile,
  selectedFilePath,
  localName,
}: SkillTreeRowProps) {
  const filesQuery = useQuery({
    enabled: !!entry.folder && expanded,
    queryKey: ["skill-files", entry.folder],
    queryFn: () => api.listSkillFiles(entry.folder as string),
    staleTime: 30_000,
  });

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const toggleDir = (p: string) =>
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const tree = useMemo(() => buildTree(filesQuery.data ?? []), [filesQuery.data]);

  const hasFolder = !!entry.folder;
  const localBadge = isLocal(entry, localName);
  // `watchFolder`, not `folder`: a skill deleted locally has no folder, and it
  // is exactly the one whose status the user most needs to see.
  const syncStatus = useSkillStatus(entry.watchFolder ?? entry.folder);
  const syncBadge = SYNC_BADGE[syncStatus];
  // Same key as the sync watcher, so a locally deleted skill stays selectable.
  const selFolder = entry.watchFolder ?? entry.folder ?? null;
  const ticked = useIsSelected(selFolder ? skKey(selFolder) : "");

  return (
    <div className="group">
      <div
        className={`flex items-center gap-1 rounded-md px-1 py-1 ${
          selected ? "bg-accent text-foreground" : "hover:bg-accent/50"
        }`}
      >
        {selFolder ? (
          <RowCheckbox
            keys={[skKey(selFolder)]}
            state={ticked ? "all" : "none"}
            label={`Sélectionner ${entry.name}`}
          />
        ) : (
          <span className="inline-block h-3.5 w-3.5 shrink-0" />
        )}
        <button
          onClick={onToggle}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
          disabled={!hasFolder}
          aria-label={expanded ? "Réduire" : "Développer"}
        >
          {hasFolder ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )
          ) : (
            <span className="inline-block h-3.5 w-3.5" />
          )}
        </button>
        <button
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
        >
          <BookOpen className="h-3.5 w-3.5 shrink-0 text-violet-400/80" />
          <span
            className={`min-w-0 flex-1 truncate ${selected ? "font-semibold" : ""}`}
          >
            {entry.name}
          </span>
          {syncBadge && (
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${syncBadge.dot}`}
              title={syncBadge.title}
              aria-label={syncBadge.title}
            />
          )}
          {/* The skill's own version, read from its SKILL.md frontmatter —
              same slot and same weight as a plugin's, since it answers the
              same question one level down. A plugin release usually touches
              one skill out of twenty, so the two numbers rarely agree. */}
          {entry.version && (
            <span
              className="shrink-0 text-xs text-muted-foreground"
              title={`Version de la compétence : ${entry.version}`}
            >
              {entry.version}
            </span>
          )}
          {!entry.folder && entry.remotePresent && syncStatus !== "deleted" && (
            <Badge variant="outline" className="shrink-0 text-xs">
              non installé
            </Badge>
          )}
          {localBadge && (
            <Badge variant="secondary" className="shrink-0 text-xs">
              local
            </Badge>
          )}
        </button>
      </div>
      {expanded && hasFolder && (
        <div className="ml-2 border-l border-border/40 pl-2">
          {filesQuery.isLoading && (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              Chargement…
            </div>
          )}
          {filesQuery.data && filesQuery.data.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              (vide)
            </div>
          )}
          {sortedChildren(tree).map((c) => (
            <FileNodeRow
              key={c.name}
              node={c}
              path={c.name}
              depth={0}
              expandedDirs={expandedDirs}
              onToggle={toggleDir}
              onSelectFile={onSelectFile}
              selectedPath={selectedFilePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Plugin node (expandable, lists its skills) ----------

interface PluginNodeProps {
  plugin: Plugin;
  marketplace: string;
  visibleSkills: Skill[];
  forceOpen: boolean;
  selection: Selection;
  localName: string;
  onSelectPlugin: () => void;
  onSelectSkill: (entry: SkillEntry) => void;
  onSelectFile: (entry: SkillEntry, relativePath: string) => void;
}

function PluginNode({
  plugin,
  marketplace,
  visibleSkills,
  forceOpen,
  selection,
  localName,
  onSelectPlugin,
  onSelectSkill,
  onSelectFile,
}: PluginNodeProps) {
  const [open, setOpen] = useState(false);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());
  const effectiveOpen = open || forceOpen;

  const isSelected =
    selection?.kind === "plugin" &&
    selection.marketplace === marketplace &&
    selection.plugin === plugin.name;
  // The plugin box ticks the plugin alone, not its skills: the two are acted on
  // by different buttons (install/update vs publish), so cascading down here
  // would conjure skill actions the user never asked for.
  const ticked = useIsSelected(plKey(marketplace, plugin.name));

  const toggleSkill = (key: string) =>
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="ml-4">
      <div
        className={cn(
          "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
          isSelected && "bg-accent"
        )}
        onClick={onSelectPlugin}
      >
        <RowCheckbox
          keys={[plKey(marketplace, plugin.name)]}
          state={ticked ? "all" : "none"}
          label={`Sélectionner ${plugin.name}`}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {effectiveOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </Button>
        <Package className="h-4 w-4 shrink-0 text-amber-400/80" />
        <Badge variant={stateVariant(plugin.installState)} className="shrink-0">
          {STATE_LABEL[plugin.installState]}
        </Badge>
        {plugin.remoteContentChanged &&
          plugin.installState !== "outdated" && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-sky-500"
              title="Le dépôt distant a changé depuis l'installation, sans changement de version"
              aria-label="Contenu distant modifié"
            />
          )}
        <span className="min-w-0 flex-1 truncate font-medium">{plugin.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {plugin.installedVersion || plugin.latestVersion || ""}
        </span>
      </div>
      {effectiveOpen && (
        <div className="ml-2 border-l border-border/60 pl-2">
          {visibleSkills.map((s) => {
            const entry = toEntry(s, plugin, marketplace);
            const key = entryKey(entry);
            const isSel =
              (selection?.kind === "skill" &&
                entryKey(selection.entry) === key) ||
              (selection?.kind === "file" && entryKey(selection.entry) === key);
            const selectedFileForRow =
              selection?.kind === "file" && entryKey(selection.entry) === key
                ? selection.relativePath
                : null;
            return (
              <SkillTreeRow
                key={key}
                entry={entry}
                selected={isSel}
                expanded={expandedSkills.has(key)}
                onSelect={() => onSelectSkill(entry)}
                onToggle={() => toggleSkill(key)}
                onSelectFile={(rel) => onSelectFile(entry, rel)}
                selectedFilePath={selectedFileForRow}
                localName={localName}
              />
            );
          })}
          {visibleSkills.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-muted-foreground">
              Aucun skill.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Marketplace node ----------

interface PluginView {
  plugin: Plugin;
  visibleSkills: Skill[];
}

interface MarketplaceNodeProps {
  marketplace: Marketplace;
  plugins: PluginView[];
  forceOpen: boolean;
  selection: Selection;
  localName: string;
  onSelectMarketplace: () => void;
  onSelectPlugin: (plugin: string) => void;
  onSelectSkill: (entry: SkillEntry) => void;
  onSelectFile: (entry: SkillEntry, relativePath: string) => void;
}

function MarketplaceNode({
  marketplace,
  plugins,
  forceOpen,
  selection,
  localName,
  onSelectMarketplace,
  onSelectPlugin,
  onSelectSkill,
  onSelectFile,
}: MarketplaceNodeProps) {
  const [open, setOpen] = useState(true);
  const effectiveOpen = open || forceOpen;
  const isSelected =
    selection?.kind === "marketplace" &&
    selection.marketplace === marketplace.name;
  const title =
    marketplace.name === localName ? "Compétences personnelles" : marketplace.name;
  // A marketplace box covers itself and its visible plugins — "check the whole
  // marketplace" is what the gesture means. Filtered-out plugins stay out.
  const groupKeys = useMemo(
    () => [
      mpKey(marketplace.name),
      ...plugins.map(({ plugin }) => plKey(marketplace.name, plugin.name)),
    ],
    [marketplace.name, plugins]
  );
  const groupState = useGroupState(groupKeys);

  return (
    <div className="px-2 py-1">
      <div
        className={cn(
          "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm font-medium hover:bg-accent",
          isSelected && "bg-accent"
        )}
        onClick={onSelectMarketplace}
      >
        <RowCheckbox
          keys={groupKeys}
          state={groupState}
          label={`Sélectionner ${title} et ses plugins`}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {effectiveOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </Button>
        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
        {marketplace.installed && (
          <Badge variant="success" className="shrink-0">
            installé
          </Badge>
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </div>
      {effectiveOpen && (
        <div className="ml-2 border-l border-border/60 pl-2">
          {plugins.map(({ plugin, visibleSkills }) => (
            <PluginNode
              key={plugin.name}
              plugin={plugin}
              marketplace={marketplace.name}
              visibleSkills={visibleSkills}
              forceOpen={forceOpen}
              selection={selection}
              localName={localName}
              onSelectPlugin={() => onSelectPlugin(plugin.name)}
              onSelectSkill={onSelectSkill}
              onSelectFile={onSelectFile}
            />
          ))}
          {plugins.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Aucun plugin listé.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Metadata helpers (mirrors the Skills tab) ----------

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function triggerLabel(s: SkillEntry, localName: string): string {
  if (isLocal(s, localName)) return "Automatique selon la description";
  return "Automatique si le pack est activé";
}

function authorLabel(s: SkillEntry, localName: string): string {
  if (isLocal(s, localName)) return "Vous";
  return `${s.pluginNameSafe}@${s.marketplaceNameSafe}`;
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="truncate text-foreground">{value}</div>
    </div>
  );
}

// ---------- Detail: marketplace + plugin (mirrors the Plugins tab) ----------

function MarketplaceDetail({ marketplace }: { marketplace: Marketplace }) {
  const install = useInstallMarketplace();
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);
  const [confirmMode, setConfirmMode] = useState<null | "uninstall" | "delete">(
    null
  );

  const settingsQuery = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });
  const cfg = settingsQuery.data?.marketplaces.find(
    (m) => m.name === marketplace.name
  );
  const cfgAutoUpdate = cfg?.autoUpdate ?? false;
  const cfgTrackPrs = cfg?.trackPrs ?? false;

  // Plugins of this marketplace that have a local install (and will be removed).
  const installedPluginCount = marketplace.plugins.filter(
    (p) =>
      p.installState === "installed" ||
      p.installState === "outdated" ||
      p.installState === "local_only"
  ).length;

  // Persist a flag toggle. Re-reads settings fresh (not the cached query) so we
  // never clobber a Gitea marketplace's provider/baseUrl with a synthesized
  // entry on a cold cache. Spreading the existing config preserves those fields;
  // when the marketplace isn't yet in app settings (an orphan added via Claude
  // Code) we synthesize one — without it the flag would never stick AND
  // refresh_all would skip it (it only iterates configured marketplaces).
  const persistCfg = async (patch: Partial<MarketplaceConfig>) => {
    const settings = await api.loadAppSettings();
    const existing = settings.marketplaces.find(
      (m) => m.name === marketplace.name
    );
    const next: MarketplaceConfig = existing
      ? { ...existing, ...patch }
      : {
          name: marketplace.name,
          githubRepo: marketplace.sourceRepo,
          defaultBranch: "main",
          owned: false,
          sourcePath: marketplace.sourcePath,
          autoUpdate: false,
          ...patch,
        };
    await api.settingsUpsertMarketplace(next);
  };

  const toggleAuto = useMutation({
    mutationFn: async (next: boolean) => {
      await persistCfg({ autoUpdate: next });
      if (marketplace.installed) {
        await api.setMarketplaceAutoUpdate(marketplace.name, next);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      forceRefresh(qc);
    },
    onError: (e) =>
      notify({
        kind: "error",
        title: `Échec du basculement de la mise à jour auto : ${marketplace.name}`,
        body: errMsg(e),
      }),
  });

  const toggleTrack = useMutation({
    mutationFn: (next: boolean) => persistCfg({ trackPrs: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["tracked-prs"] });
    },
    onError: (e) =>
      notify({
        kind: "error",
        title: `Échec du basculement du suivi des PR : ${marketplace.name}`,
        body: errMsg(e),
      }),
  });

  const uninstall = useMutation({
    mutationFn: () =>
      withTask(
        {
          kind: "marketplace",
          label: "Désinstallation du marketplace",
          detail: marketplace.name,
        },
        () => api.uninstallMarketplaceCascade(marketplace.name)
      ),
    onSuccess: () => {
      forceRefresh(qc);
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      notify({
        kind: "success",
        title: "Marketplace désinstallé",
        body: marketplace.name,
      });
      setConfirmMode(null);
    },
    onError: (e) =>
      notify({
        kind: "error",
        title: `Échec de la désinstallation : ${marketplace.name}`,
        body: errMsg(e),
      }),
  });

  const deleteCompletely = useMutation({
    mutationFn: () =>
      withTask(
        {
          kind: "marketplace",
          label: "Suppression du marketplace",
          detail: marketplace.name,
        },
        () => api.deleteMarketplaceCompletely(marketplace.name)
      ),
    onSuccess: () => {
      forceRefresh(qc);
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["tracked-prs"] });
      notify({
        kind: "success",
        title: "Marketplace supprimé",
        body: marketplace.name,
      });
      setConfirmMode(null);
    },
    onError: (e) =>
      notify({
        kind: "error",
        title: `Échec de la suppression : ${marketplace.name}`,
        body: errMsg(e),
      }),
  });

  const actions = (
    <>
      {marketplace.installed ? (
        <Badge variant="success" className="shrink-0">
          installé
        </Badge>
      ) : (
        marketplace.sourceRepo && (
          <Button
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            onClick={() => install.mutate(marketplace)}
            disabled={install.isPending}
            title="Télécharger ce marketplace localement (le rend visible par Claude Code)"
          >
            {install.isPending ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Download className="mr-1 h-3 w-3" />
            )}
            Installer
          </Button>
        )
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            title="Plus d'actions"
            aria-label={`Plus d'actions pour ${marketplace.name}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{marketplace.name}</DropdownMenuLabel>
          {marketplace.installed && (
            <DropdownMenuItem
              onSelect={() => setConfirmMode("uninstall")}
              title="Supprime les fichiers locaux mais garde ce marketplace dans la liste."
            >
              <PackageMinus className="h-4 w-4" />
              Désinstaller (garder dans la liste)
            </DropdownMenuItem>
          )}
          {marketplace.installed && <DropdownMenuSeparator />}
          <DropdownMenuItem
            destructive
            onSelect={() => setConfirmMode("delete")}
          >
            <Trash2 className="h-4 w-4" />
            {marketplace.installed
              ? "Supprimer définitivement (fichiers + liste)"
              : "Retirer de la liste"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <DetailShell title={marketplace.name} actions={actions}>
    <Card className="m-4">
      <CardHeader className="pb-2">
        <CardDescription>
          {marketplace.sourceRepo ||
            marketplace.sourcePath ||
            marketplace.sourceKind}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <span className="text-muted-foreground">Plugins :</span>{" "}
          {marketplace.plugins.length}
        </div>
        <div>
          <span className="text-muted-foreground">Dernière mise à jour :</span>{" "}
          {marketplace.lastUpdated || "—"}
        </div>
        {marketplace.installLocation && (
          <div className="break-all text-xs text-muted-foreground">
            {marketplace.installLocation}
          </div>
        )}

        {marketplace.sourceRepo && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">Mise à jour auto</div>
                <div className="text-xs text-muted-foreground">
                  Re-télécharge ce marketplace à chaque rafraîchissement si son
                  SHA distant a changé.
                </div>
              </div>
              <Switch
                checked={cfgAutoUpdate}
                onCheckedChange={(v) => toggleAuto.mutate(v)}
                disabled={toggleAuto.isPending}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">Suivi PR</div>
                <div className="text-xs text-muted-foreground">
                  Suit les PR ouvertes de ce marketplace et de ses plugins
                  (onglet Suivi marketplace + Dashboard).
                </div>
              </div>
              <Switch
                checked={cfgTrackPrs}
                onCheckedChange={(v) => toggleTrack.mutate(v)}
                disabled={toggleTrack.isPending}
              />
            </div>
          </div>
        )}
      </CardContent>

      <Dialog
        open={confirmMode !== null}
        onOpenChange={(v) => !v && setConfirmMode(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmMode === "delete"
                ? `Supprimer « ${marketplace.name} »`
                : `Désinstaller « ${marketplace.name} »`}
            </DialogTitle>
            <DialogDescription>
              {confirmMode === "delete" && !marketplace.installed ? (
                <>
                  Retire ce marketplace de la liste de l'app. Aucun fichier local
                  n'est touché (rien n'était installé).
                </>
              ) : (
                <>
                  Supprime localement ce marketplace
                  {installedPluginCount > 0 ? (
                    <>
                      {" "}et désinstalle ses{" "}
                      <strong>
                        {installedPluginCount} plugin
                        {installedPluginCount > 1 ? "s" : ""} installé
                        {installedPluginCount > 1 ? "s" : ""}
                      </strong>
                    </>
                  ) : null}
                  {confirmMode === "delete" ? (
                    <>
                      , puis l'oublie de la liste de l'app.
                    </>
                  ) : (
                    <>
                      . Le marketplace reste enregistré — vous pourrez le
                      réinstaller.
                    </>
                  )}{" "}
                  Vos compétences personnelles ne sont pas touchées.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Annuler</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() =>
                confirmMode === "delete"
                  ? deleteCompletely.mutate()
                  : uninstall.mutate()
              }
              disabled={uninstall.isPending || deleteCompletely.isPending}
            >
              {(uninstall.isPending || deleteCompletely.isPending) && (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              )}
              {confirmMode === "delete" ? "Supprimer" : "Désinstaller"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
    </DetailShell>
  );
}

function PluginDetail({
  plugin,
  onAddSkill,
}: {
  plugin: Plugin;
  onAddSkill: (p: Plugin) => void;
}) {
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);
  const findMarketplace = useApp((s) => s.findMarketplace);
  // Optimistic patches: the refresh that confirms them is a remote pass, and
  // until it lands the card would still show the state we just left.
  const markInstalled = useApp((s) => s.markPluginInstalled);
  const markUninstalled = useApp((s) => s.markPluginUninstalled);
  const markEnabled = useApp((s) => s.markPluginEnabled);
  const installMarketplace = useInstallMarketplace();
  const installed =
    plugin.installState === "installed" ||
    plugin.installState === "outdated" ||
    plugin.installState === "local_only";

  const installMutation = useMutation({
    mutationFn: async (p: Plugin) => {
      // Installing a plugin fetches its own repo and doesn't strictly require the
      // marketplace index — but Claude Code only surfaces it cleanly when the
      // marketplace is installed too. So install the marketplace first if it
      // isn't already (no-op when it is).
      const mp = findMarketplace(p.marketplaceName);
      if (mp && !mp.installed) {
        await installMarketplace.mutateAsync(mp);
      }
      return withTask(
        {
          kind: "install",
          label: "Installation du plugin",
          detail: `${p.name} · ${p.marketplaceName}`,
        },
        () => api.installPlugin(p)
      );
    },
    onSuccess: (_, p) => {
      markInstalled(p);
      forceRefresh(qc);
      notify({ kind: "success", title: "Plugin installé", body: p.name });
    },
    onError: (e, p) =>
      notify({
        kind: "error",
        title: `Échec de l'installation : ${p.name}`,
        body: errMsg(e),
      }),
  });
  const uninstallMutation = useMutation({
    mutationFn: (p: Plugin) =>
      withTask(
        {
          kind: "uninstall",
          label: "Désinstallation du plugin",
          detail: `${p.name} · ${p.marketplaceName}`,
        },
        () => api.uninstallPlugin(p)
      ),
    onSuccess: (_, p) => {
      markUninstalled(p);
      forceRefresh(qc);
      notify({ kind: "success", title: "Plugin désinstallé", body: p.name });
    },
    onError: (e, p) =>
      notify({
        kind: "error",
        title: `Échec de la désinstallation : ${p.name}`,
        body: errMsg(e),
      }),
  });
  const enableMutation = useMutation({
    mutationFn: ({
      plugin: pl,
      marketplace,
      value,
    }: {
      plugin: string;
      marketplace: string;
      value: boolean;
    }) =>
      withTask(
        {
          kind: "install",
          label: value ? "Activation du plugin" : "Désactivation du plugin",
          detail: `${pl} · ${marketplace}`,
        },
        () => api.setPluginEnabled(pl, marketplace, value)
      ),
    onSuccess: (_, vars) => {
      markEnabled(vars.marketplace, vars.plugin, vars.value);
      forceRefresh(qc);
    },
    onError: (e, vars) =>
      notify({
        kind: "error",
        title: `Échec du basculement : ${vars.plugin}`,
        body: errMsg(e),
      }),
  });

  const actions = (
    <>
      <Badge variant={stateVariant(plugin.installState)} className="shrink-0">
        {STATE_LABEL[plugin.installState]}
      </Badge>
      {plugin.remoteContentChanged && (
        <Badge
          variant="outline"
          className="shrink-0"
          title="Le dépôt distant a changé depuis l'installation, sans que la version du manifeste soit incrémentée"
        >
          contenu distant modifié
        </Badge>
      )}
      {readiness(plugin) && (
        <Badge variant={readiness(plugin)!.variant} className="shrink-0">
          {readiness(plugin)!.label}
        </Badge>
      )}
    </>
  );

  return (
    <DetailShell title={plugin.name} actions={actions}>
    <Card className="m-4">
      <CardHeader className="pb-2">
        <CardDescription>
          {plugin.description || "Aucune description"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {(plugin.installState === "not_installed" ||
            plugin.installState === "outdated") && (
            <Button
              size="sm"
              onClick={() => installMutation.mutate(plugin)}
              disabled={installMutation.isPending}
            >
              <Download className="mr-1 h-3 w-3" />
              {plugin.installState === "outdated" ? "Mettre à jour" : "Installer"}
            </Button>
          )}
          {installed && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => uninstallMutation.mutate(plugin)}
              disabled={uninstallMutation.isPending}
            >
              <Trash2 className="mr-1 h-3 w-3" />
              Désinstaller
            </Button>
          )}
          {installed && (
            <Button
              size="sm"
              onClick={() => onAddSkill(plugin)}
              title="Créer un nouveau skill dans le dossier de ce plugin"
            >
              <Plus className="mr-1 h-3 w-3" />
              Ajouter un skill
            </Button>
          )}
          {plugin.skills.length > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Sparkles className="h-3 w-3" />
              {plugin.skills.length} skill
              {plugin.skills.length === 1 ? "" : "s"} — dépliez le plugin à gauche
            </span>
          )}
          {plugin.installState !== "not_installed" && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Activé</span>
              <Switch
                checked={!!plugin.enabled}
                onCheckedChange={(v) =>
                  enableMutation.mutate({
                    plugin: plugin.name,
                    marketplace: plugin.marketplaceName,
                    value: v,
                  })
                }
              />
              {plugin.enabled ? (
                <Power className="h-3 w-3 text-emerald-500" />
              ) : (
                <PowerOff className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-muted-foreground">Version installée</div>
            <div>{plugin.installedVersion || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Dernière version</div>
            <div>{plugin.latestVersion || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Marketplace</div>
            <div>{plugin.marketplaceName}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Source</div>
            <div className="truncate">
              {plugin.source?.repo ||
                plugin.source?.url ||
                plugin.source?.path ||
                "—"}
            </div>
          </div>
        </div>
        {plugin.installPath && (
          <div className="break-all text-xs text-muted-foreground">
            {plugin.installPath}
          </div>
        )}
      </CardContent>
    </Card>
    </DetailShell>
  );
}

// Wording per sync status for the detail banner. A deletion is not a
// modification and must not be described as one — the PR it opens removes the
// skill from the repo, which is worth saying before the user clicks.
const DETAIL_BANNER: Partial<
  Record<SkillSyncStatus, { title: string; body: string; action: string }>
> = {
  modified: {
    title: "Modifications locales détectées",
    body: "Ce dossier a changé depuis sa dernière synchro. Poussez-le pour ouvrir une PR — sinon ces modifs seront écrasées à la prochaine mise à jour du plugin.",
    action: "Pousser la modification",
  },
  new: {
    title: "Compétence absente du dépôt distant",
    body: "Ce dossier n'existe que chez vous. Poussez-le pour l'ajouter au plugin — sinon il disparaîtra à la prochaine mise à jour du plugin.",
    action: "Pousser la compétence",
  },
  deleted: {
    title: "Compétence supprimée localement",
    body: "Le dépôt distant contient toujours cette compétence. Ouvrez une PR pour l'y supprimer — sinon la prochaine mise à jour du plugin la réinstallera.",
    action: "Pousser la suppression",
  },
};

/**
 * The right-hand panel's title bar — the same bar as the tree's on the left,
 * `PAGE_HEADER` and all, so the two halves of the split share one top rule
 * rather than one starting a dozen pixels below the other.
 *
 * Sticky, because this half scrolls: a SKILL.md is long enough that scrolling
 * used to leave the reader in front of an unnamed page of markdown. `z-20` puts
 * it over the `ScrollFade`'s top gradient (`z-10`), which would otherwise fade
 * the title it is meant to keep readable.
 */
const DETAIL_HEADER = cn(PAGE_HEADER, "sticky top-0 z-20 bg-background");

/**
 * A detail panel that is a card under a title bar: the marketplace and plugin
 * panels. Their name and their actions used to live in the card's own header,
 * which started 16 px lower than the tree's title bar beside it — the two
 * halves of the split read as two windows rather than one.
 */
function DetailShell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className={DETAIL_HEADER}>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
          {title}
        </h1>
        {actions}
      </header>
      {children}
    </div>
  );
}

/** Opening a skill's folder in VS Code, from wherever the menu offering it
 *  happens to be — the skill panel and the file panel offer the same one. */
async function openFolderInVsCode(entry: SkillEntry) {
  try {
    await api.openInVsCode(entry.folder as string);
  } catch (e) {
    useNotifications.getState().push({
      kind: "error",
      title: "Échec de l'ouverture dans VS Code",
      body: errMsg(e),
    });
  }
}

// ---------- Detail: skill + file (mirrors the Skills tab) ----------

interface SkillDetailProps {
  entry: SkillEntry;
  mtimeIso: string | null;
  showDescription: boolean;
  onToggleDescription: () => void;
  localName: string;
  status: SkillSyncStatus;
  canPush: boolean;
  onPush: () => void;
  onDelete: () => void;
}

function SkillDetailView({
  entry,
  mtimeIso,
  showDescription,
  onToggleDescription,
  localName,
  status,
  canPush,
  onPush,
  onDelete,
}: SkillDetailProps) {
  const mdPath =
    entry.skillMdPath ||
    (entry.folder ? joinPath(entry.folder as string, "SKILL.md") : null);
  const md = useQuery({
    enabled: !!mdPath,
    queryKey: ["file-content", mdPath],
    queryFn: () => api.readTextFile(mdPath as string),
  });
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className={DETAIL_HEADER}>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
          {entry.name}
        </h1>
        {entry.version && (
          <Badge variant="outline" className="shrink-0 font-mono text-xs">
            v{entry.version}
          </Badge>
        )}
        {/* Both actions fold into the overflow menu: neither is what one came
            to this panel to read, and one of them deletes a folder — a
            destructive action one stray click from the title is worse placed
            than one behind a menu. */}
        {entry.folder && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                aria-label="Autres actions"
                title="Autres actions sur cette compétence"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => openFolderInVsCode(entry)}>
                <Code2 className="h-4 w-4" />
                Ouvrir dans VS Code
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onDelete}>
                <Trash2 className="h-4 w-4" />
                Supprimer en local
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      {isActionable(status) && canPush && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-6 py-3">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              SYNC_BADGE[status]?.dot ?? "bg-amber-500"
            }`}
          />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium text-amber-700 dark:text-amber-300">
              {DETAIL_BANNER[status]?.title}
            </span>
            <p className="text-xs text-muted-foreground">
              {DETAIL_BANNER[status]?.body}
            </p>
          </div>
          <Button size="sm" className="shrink-0 gap-1.5" onClick={onPush}>
            <UploadCloud className="h-4 w-4" />
            {DETAIL_BANNER[status]?.action}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-8 gap-y-3 border-b px-6 py-4 text-xs sm:grid-cols-3">
        <MetaItem label="Ajouté par" value={authorLabel(entry, localName)} />
        <MetaItem label="Dernière mise à jour" value={formatDate(mtimeIso)} />
        <MetaItem label="Déclencheur" value={triggerLabel(entry, localName)} />
      </div>

      <div className="flex items-center gap-1.5 border-b px-6 py-3 text-xs">
        <span className="font-medium text-muted-foreground">Description</span>
        <button
          onClick={onToggleDescription}
          className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent"
          aria-label="Afficher/masquer la description"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </div>
      {showDescription && entry.description && (
        <div className="border-b px-6 py-3 text-sm text-muted-foreground">
          {entry.description}
        </div>
      )}

      <div className="min-w-0 flex-1 p-6">
        {entry.folder && (
          <div className="mb-3 overflow-hidden break-all rounded-md bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
            {entry.folder.toString()}
          </div>
        )}
        {!entry.folder ? (
          <div className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            Compétence non installée (distante uniquement) — installez le plugin
            pour parcourir ses fichiers et lire sa documentation.
          </div>
        ) : md.isLoading ? (
          <div className="text-sm text-muted-foreground">
            Chargement de la documentation…
          </div>
        ) : md.error ? (
          <div className="text-sm text-destructive">
            Impossible de lire le SKILL.md : {(md.error as Error).message}
          </div>
        ) : md.data !== undefined ? (
          <div className="min-w-0 max-w-full overflow-hidden rounded-lg border bg-card p-6 shadow-sm">
            <SkillMarkdown content={md.data} />
          </div>
        ) : (
          <div className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            Pas de SKILL.md pour cette compétence. Dépliez-la à gauche pour
            parcourir ses fichiers et cliquer sur l'un d'eux.
          </div>
        )}
      </div>
    </div>
  );
}

interface FileDetailProps {
  entry: SkillEntry;
  relativePath: string;
  absPath: string;
  content: string | undefined;
  loading: boolean;
  error: Error | null;
}

function FileDetailView({
  entry,
  relativePath,
  absPath,
  content,
  loading,
  error,
}: FileDetailProps) {
  const fileName = relativePath.split("/").pop() || relativePath;
  const isMarkdown = /\.(md|markdown)$/i.test(fileName);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className={DETAIL_HEADER}>
        <FileText className="h-4 w-4 shrink-0 text-violet-400/80" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{fileName}</h1>
          <div className="truncate text-xs text-muted-foreground">
            {entry.name} · {relativePath}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0"
              aria-label="Autres actions"
              title="Autres actions sur ce fichier"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => openFolderInVsCode(entry)}>
              <Code2 className="h-4 w-4" />
              Ouvrir dans VS Code
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="min-w-0 flex-1 p-6">
        <div className="mb-3 overflow-hidden break-all rounded-md bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
          {absPath}
        </div>
        <div className="min-w-0 max-w-full overflow-hidden rounded-lg border bg-card p-6 shadow-sm">
          {loading ? (
            <div className="text-xs text-muted-foreground">Chargement…</div>
          ) : error ? (
            <div className="text-xs text-destructive">
              Échec de la lecture du fichier : {error.message}
            </div>
          ) : content === undefined ? (
            <div className="text-xs text-muted-foreground">(aucun contenu)</div>
          ) : isMarkdown ? (
            <SkillMarkdown content={content} />
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Right-hand detail panel ----------

function DetailPanel({
  selection,
  localName,
  showDescription,
  onToggleDescription,
  onArchived,
  onRestored,
  onPushSkill,
  onDeleteSkill,
  onAddSkill,
}: {
  selection: Selection;
  localName: string;
  showDescription: boolean;
  onToggleDescription: () => void;
  onArchived: () => void;
  onRestored: () => void;
  onPushSkill: (entry: SkillEntry) => void;
  onDeleteSkill: (entry: SkillEntry) => void;
  onAddSkill: (p: Plugin) => void;
}) {
  const findPlugin = useApp((s) => s.findPlugin);
  const findMarketplace = useApp((s) => s.findMarketplace);

  const selectedSkill =
    selection?.kind === "skill"
      ? selection.entry
      : selection?.kind === "file"
      ? selection.entry
      : null;

  // "Pousser la modification" is offered only for installed skills under an
  // editable marketplace (a repo the current token can push to).
  const skillStatus = useSkillStatus(
    selectedSkill?.watchFolder ?? selectedSkill?.folder
  );
  const skillMarketplace = selectedSkill
    ? findMarketplace(selectedSkill.marketplaceNameSafe)
    : undefined;
  // A deletion has no local folder to push *from*, but is still pushable — the
  // draft it opens removes the skill from the repo.
  const canPushSkill =
    !!(selectedSkill?.folder ?? selectedSkill?.watchFolder) &&
    !!skillMarketplace?.editable &&
    !!skillMarketplace?.sourceRepo;

  const selectedFileAbs =
    selection?.kind === "file"
      ? joinPath(selection.entry.folder as string, selection.relativePath)
      : null;

  const fileContent = useQuery({
    enabled: !!selectedFileAbs,
    queryKey: ["file-content", selectedFileAbs],
    queryFn: () => api.readTextFile(selectedFileAbs as string),
  });

  const mtime = useQuery({
    enabled: !!selectedSkill?.folder,
    queryKey: ["skill-mtime", selectedSkill?.folder],
    queryFn: () => api.fileMtime(selectedSkill!.folder as string),
    staleTime: 60_000,
  });

  if (!selection) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 py-20 text-center text-sm text-muted-foreground">
        <Package className="h-8 w-8 opacity-40" />
        <span>
          Sélectionnez un marketplace, un plugin ou une compétence ; dépliez un
          plugin pour parcourir ses compétences, ou ouvrez un doublon / une
          entrée archivée.
        </span>
      </div>
    );
  }

  if (selection.kind === "marketplace") {
    const m = findMarketplace(selection.marketplace);
    if (!m) return null;
    return <MarketplaceDetail marketplace={m} />;
  }

  if (selection.kind === "plugin") {
    const p = findPlugin(selection.marketplace, selection.plugin);
    if (!p) return null;
    return <PluginDetail plugin={p} onAddSkill={onAddSkill} />;
  }

  if (selection.kind === "duplicate") {
    return (
      <div className="p-6">
        <DuplicateSkillDetail dup={selection.value} onArchived={onArchived} />
      </div>
    );
  }

  if (selection.kind === "archived") {
    return (
      <div className="p-6">
        <ArchivedSkillDetail skill={selection.value} onRestored={onRestored} />
      </div>
    );
  }

  if (selection.kind === "skill") {
    return (
      <SkillDetailView
        entry={selection.entry}
        mtimeIso={mtime.data ?? null}
        showDescription={showDescription}
        onToggleDescription={onToggleDescription}
        localName={localName}
        status={skillStatus}
        canPush={canPushSkill}
        onPush={() => onPushSkill(selection.entry)}
        onDelete={() => onDeleteSkill(selection.entry)}
      />
    );
  }

  if (selection.kind === "file") {
    return (
      <FileDetailView
        entry={selection.entry}
        relativePath={selection.relativePath}
        absPath={selectedFileAbs as string}
        content={fileContent.data}
        loading={fileContent.isLoading}
        error={fileContent.error as Error | null}
      />
    );
  }

  return null;
}

// ---------- Main page ----------

export function SkillsPage() {
  const navigate = useNavigate();
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  const globalSelection = useApp((s) => s.selection);
  const findPlugin = useApp((s) => s.findPlugin);
  const findSkill = useApp((s) => s.findSkill);

  const [selection, setSelection] = useState<Selection>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [showDescription, setShowDescription] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [addSkillFor, setAddSkillFor] = useState<Plugin | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillEntry | null>(null);
  const setSyncOne = useSkillSync((s) => s.setOne);
  // A skill still flagged `new` has no counterpart upstream, so deleting it
  // undoes the creation instead of queueing a removal — the dialog must not
  // promise a push that will never be offered.
  const deleteTargetNeverPushed = useSkillSync(
    (s) =>
      s.status[deleteTarget?.folder ?? deleteTarget?.watchFolder ?? ""] === "new"
  );
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);

  const localName = localOnly?.name ?? "(local skills)";

  // Pushing a single skill goes to the Changes tab with that skill alone
  // ticked, rather than opening a draft dialog: one screen builds every PR,
  // whatever the status, so there is a single place to review before pushing.
  // Keyed on the watch folder — a deleted skill has no `folder` left, and it is
  // exactly the one that needs pushing.
  const pushSkill = (entry: SkillEntry) => {
    const target = entry.folder ?? entry.watchFolder;
    if (!target) return;
    navigate("/changes", { state: { folders: [target], focus: target } });
  };

  // Delete the folder on disk. A plugin skill stays in the tree afterwards,
  // flagged `deleted` — the removal is then pushed like any other change.
  const deleteSkill = useMutation({
    mutationFn: async (entry: SkillEntry) => {
      const folder = entry.folder as string;
      const tracked = await withTask(
        {
          kind: "uninstall",
          label: "Suppression de la compétence",
          detail: entry.name,
        },
        () => api.deleteSkillLocal(folder)
      );
      return { entry, folder, tracked };
    },
    onSuccess: ({ entry, folder, tracked }) => {
      if (tracked) {
        // Red dot now rather than at the next sweep; the backend set the same
        // status, so the watcher will not overwrite it with `modified`.
        setSyncOne(folder, "deleted");
        // The tree rebuilds this row with `folder: null`; the detail panel holds
        // a snapshot, so drop the folder there too — otherwise its disk-bound
        // buttons (VS Code, Supprimer) outlive the bytes they act on.
        setSelection((cur) =>
          cur?.kind === "skill" && cur.entry.folder === folder
            ? {
                kind: "skill",
                entry: {
                  ...cur.entry,
                  folder: null,
                  watchFolder: cur.entry.watchFolder ?? folder,
                },
              }
            : cur
        );
      } else {
        // No upstream: the row is about to disappear from the tree.
        setSelection(null);
      }
      // ["refresh"] alone would leave the per-folder caches serving a skill
      // that no longer exists on disk.
      forceRefresh(qc);
      for (const key of [
        ["duplicate-skills"],
        ["archived-skills"],
        ["skill-files"],
        ["skill-mtime"],
      ]) {
        qc.invalidateQueries({ queryKey: key });
      }
      notify({
        kind: "success",
        title: "Compétence supprimée en local",
        body: tracked
          ? `${entry.name} — poussez la suppression depuis Changements pour la retirer du dépôt.`
          : entry.name,
      });
      setDeleteTarget(null);
    },
    onError: (e, entry) =>
      notify({
        kind: "error",
        title: `Échec de la suppression : ${entry.name}`,
        body: errMsg(e),
      }),
  });

  // Deep-links from the dashboard / command palette set the shared `useApp`
  // selection then navigate here; mirror it into the local selection so the
  // targeted marketplace / plugin / skill is shown and highlighted. A null
  // global selection is ignored so it never clobbers an in-page click.
  useEffect(() => {
    if (!globalSelection) return;
    if (globalSelection.kind === "marketplace") {
      setSelection({ kind: "marketplace", marketplace: globalSelection.marketplace });
    } else if (globalSelection.kind === "plugin") {
      setSelection({
        kind: "plugin",
        marketplace: globalSelection.marketplace,
        plugin: globalSelection.plugin,
      });
    } else if (globalSelection.kind === "skill") {
      const plugin = findPlugin(globalSelection.marketplace, globalSelection.plugin);
      const skill = findSkill(
        globalSelection.marketplace,
        globalSelection.plugin,
        globalSelection.skill
      );
      if (plugin && skill) {
        setSelection({
          kind: "skill",
          entry: toEntry(skill, plugin, globalSelection.marketplace),
        });
      } else {
        setSelection({
          kind: "plugin",
          marketplace: globalSelection.marketplace,
          plugin: globalSelection.plugin,
        });
      }
    }
  }, [globalSelection, findPlugin, findSkill]);

  const list = useMemo(() => {
    const out = [...marketplaces];
    if (localOnly && localOnly.plugins.length > 0) out.unshift(localOnly);
    return out;
  }, [marketplaces, localOnly]);

  const filtersActive = stateFilter !== "all";

  const skillVisible = useMemo(() => {
    return (s: Skill): boolean => {
      if (stateFilter === "installed" && !skillInstalled(s)) return false;
      if (stateFilter === "not_installed" && skillInstalled(s)) return false;
      return true;
    };
  }, [stateFilter]);

  // Build the filtered tree: marketplaces → plugins → visible skills.
  const tree = useMemo(() => {
    return list
      .map((m) => {
        const plugins = m.plugins
          .map((plugin) => ({
            plugin,
            visibleSkills: plugin.skills.filter(skillVisible),
          }))
          .filter(
            ({ visibleSkills }) => !filtersActive || visibleSkills.length > 0
          );
        return { marketplace: m, plugins };
      })
      .filter(({ plugins }) => !filtersActive || plugins.length > 0);
  }, [list, skillVisible, filtersActive]);

  const counts = useMemo(() => {
    let total = 0;
    let visible = 0;
    for (const m of list) {
      for (const p of m.plugins) {
        for (const s of p.skills) {
          total += 1;
          if (skillVisible(s)) visible += 1;
        }
      }
    }
    return { total, visible };
  }, [list, skillVisible]);

  // Feed the multi-selection store: `ordered` is the visible rows in tree order
  // (the axis shift-click walks along), `prune` runs against *every* key so a
  // filter change hides rows without silently dropping what they had ticked.
  const setOrdered = useTreeSelection((s) => s.setOrdered);
  const pruneSelection = useTreeSelection((s) => s.prune);

  const orderedKeys = useMemo(() => {
    const out: string[] = [];
    for (const { marketplace, plugins } of tree) {
      out.push(mpKey(marketplace.name));
      for (const { plugin, visibleSkills } of plugins) {
        out.push(plKey(marketplace.name, plugin.name));
        for (const s of visibleSkills) {
          const folder = s.watchFolder ?? s.folder;
          if (folder) out.push(skKey(folder));
        }
      }
    }
    return out;
  }, [tree]);

  const allKeys = useMemo(() => {
    const out = new Set<string>();
    for (const m of list) {
      out.add(mpKey(m.name));
      for (const p of m.plugins) {
        out.add(plKey(m.name, p.name));
        for (const s of p.skills) {
          const folder = s.watchFolder ?? s.folder;
          if (folder) out.add(skKey(folder));
        }
      }
    }
    return out;
  }, [list]);

  useEffect(() => setOrdered(orderedKeys), [orderedKeys, setOrdered]);
  useEffect(() => pruneSelection(allKeys), [allKeys, pruneSelection]);

  const selectedDuplicateFolder =
    selection?.kind === "duplicate" ? selection.value.local.folder : null;
  const selectedArchivedFolder =
    selection?.kind === "archived" ? selection.value.folder : null;

  const left = (
    <>
      <div className={PAGE_HEADER}>
        <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          Marketplaces · plugins · skills
        </h2>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 px-2 text-xs"
          onClick={() => setAddOpen(true)}
          title="Ajouter un marketplace depuis une URL Git"
        >
          <Plus className="mr-1 h-3 w-3" />
          Ajouter une Marketplace
        </Button>
      </div>

      <div className="space-y-2 border-b p-3">
        <DuplicateSkillsPanel
          selectedFolder={selectedDuplicateFolder}
          onSelect={(d) => setSelection({ kind: "duplicate", value: d })}
        />
        <ArchivedSkillsPanel
          selectedFolder={selectedArchivedFolder}
          onSelect={(s) => setSelection({ kind: "archived", value: s })}
        />
        {/* The tree's own search box used to sit here. Finding a skill by name
            is the title bar's job now (`components/SearchBox.tsx`), which
            reaches every marketplace, plugin and skill from any page — this
            one only worked once you were already here. What is left is the
            state filter, which is a different question: not "where is X" but
            "show me only what is / isn't installed". */}
        <div className="flex flex-wrap items-center gap-1">
          <Filter className="h-3 w-3 text-muted-foreground" />
          {(Object.keys(STATE_FILTER_LABELS) as StateFilter[]).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={stateFilter === k ? "default" : "ghost"}
              className="h-6 px-2 text-xs"
              onClick={() => setStateFilter(k)}
            >
              {STATE_FILTER_LABELS[k]}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {counts.visible} sur {counts.total} skills
        </p>
      </div>
      <ScrollFade className="flex-1" wraps>
        <ScrollArea className="h-full">
        <div className="py-2">
          {tree.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
              {filtersActive ? (
                <>
                  <Sparkles className="h-6 w-6 opacity-40" />
                  <span>Aucune compétence ne correspond à vos filtres.</span>
                </>
              ) : (
                <>
                  <Globe className="h-6 w-6 opacity-40" />
                  <span>Aucun marketplace pour l'instant.</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1"
                    onClick={() => setAddOpen(true)}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Ajouter un marketplace
                  </Button>
                </>
              )}
            </div>
          )}
          {tree.map(({ marketplace, plugins }) => (
            <MarketplaceNode
              key={marketplace.name}
              marketplace={marketplace}
              plugins={plugins}
              forceOpen={filtersActive}
              selection={selection}
              localName={localName}
              onSelectMarketplace={() =>
                setSelection({ kind: "marketplace", marketplace: marketplace.name })
              }
              onSelectPlugin={(plugin) =>
                setSelection({
                  kind: "plugin",
                  marketplace: marketplace.name,
                  plugin,
                })
              }
              onSelectSkill={(entry) => setSelection({ kind: "skill", entry })}
              onSelectFile={(entry, relativePath) =>
                setSelection({ kind: "file", entry, relativePath })
              }
            />
          ))}
        </div>
        </ScrollArea>
      </ScrollFade>

      <BulkActionBar
        onPublishSkills={(folders) =>
          navigate("/changes", { state: { folders } })
        }
      />
    </>
  );

  const right = (
    <ScrollFade className="h-full" wraps>
      <ScrollArea className="h-full">
      <DetailPanel
        selection={selection}
        localName={localName}
        showDescription={showDescription}
        onToggleDescription={() => setShowDescription((v) => !v)}
        onArchived={() => setSelection(null)}
        onRestored={() => setSelection(null)}
        onPushSkill={pushSkill}
        onDeleteSkill={(entry) => setDeleteTarget(entry)}
        onAddSkill={(p) => setAddSkillFor(p)}
      />
      </ScrollArea>
    </ScrollFade>
  );

  return (
    // One sub-window for the whole page: the tree and the detail are two
    // regions of it, told apart by the split's rule, not two panels floating
    // side by side.
    <div className="panel h-full min-h-0 w-full min-w-0 flex-1">
      <ResizableSplit
        storageId="skills"
        left={left}
        right={right}
        defaultLeftSize={32}
      />
      <AddMarketplaceDialog open={addOpen} onOpenChange={setAddOpen} />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Supprimer « {deleteTarget?.name} » en local
            </DialogTitle>
            <DialogDescription>
              {deleteTarget &&
              deleteTarget.marketplaceNameSafe === localName ? (
                <>
                  Le dossier est supprimé définitivement de{" "}
                  <code>~/.claude/skills/</code>. Cette compétence n'a pas de
                  dépôt distant : rien ne pourra la restaurer.
                </>
              ) : deleteTargetNeverPushed ? (
                <>
                  Cette compétence n'a jamais été poussée : le dépôt du plugin
                  ne la contient pas. Le dossier est supprimé définitivement et
                  la ligne disparaît — il n'y a rien à publier.
                </>
              ) : (
                <>
                  Le dossier est supprimé de cette machine. La compétence reste
                  listée avec la pastille <strong>supprimé</strong> : poussez-la
                  depuis l'onglet <strong>Changements</strong> pour la retirer
                  aussi du dépôt — sinon la prochaine mise à jour du plugin la
                  réinstallera.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Annuler</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={deleteSkill.isPending}
              onClick={() => deleteTarget && deleteSkill.mutate(deleteTarget)}
            >
              {deleteSkill.isPending && (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              )}
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {addSkillFor && (
        <AddSkillDialog
          open
          plugin={addSkillFor}
          onOpenChange={(v) => !v && setAddSkillFor(null)}
          onCreated={(folder) => {
            // The backend already flagged it `new` (skill-sync-changed) and the
            // dialog invalidated the refresh; keep the plugin selected so the new
            // skill shows up under it once the tree refreshes.
            setSyncOne(folder, "new");
            setSelection({
              kind: "plugin",
              marketplace: addSkillFor.marketplaceName,
              plugin: addSkillFor.name,
            });
          }}
        />
      )}
    </div>
  );
}

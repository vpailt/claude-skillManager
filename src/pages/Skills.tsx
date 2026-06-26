// Skills — vue unifiée (fusion des anciens menus Plugins et Skills).
//
// Vue arborescente Marketplace → Plugin → Skills :
//  - au niveau plugin : installer/désinstaller, activer/désactiver et le
//    panneau récapitulatif du plugin ;
//  - en dépliant un plugin : la liste de ses skills avec l'arborescence de
//    fichiers et le détail SKILL.md ;
//  - panneaux doublons & archivés ;
//  - filtre des skills par état d'installation (installé / non installé).
import { useEffect, useMemo, useRef, useState } from "react";
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
  Package,
  Plus,
  Power,
  PowerOff,
  Search,
  Sparkles,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { useApp } from "@/stores/app";
import { useNotifications } from "@/stores/notifications";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { ResizableSplit } from "@/components/ResizableSplit";
import { SkillMarkdown } from "@/components/SkillMarkdown";
import {
  ArchivedSkillDetail,
  DuplicateSkillDetail,
  DuplicateSkillsPanel,
} from "@/components/DuplicateSkillsPanel";
import { ArchivedSkillsPanel } from "@/components/ArchivedSkillsPanel";
import { AddMarketplaceDialog } from "@/components/AddMarketplaceDialog";
import { WizardHost, type WizardKind } from "@/components/AdminWizards";
import { useInstallMarketplace } from "@/hooks/useInstallMarketplace";
import { useIsSkillDirty, useSkillDirty } from "@/stores/skillDirty";
import type {
  ArchivedSkill,
  DuplicateSkill,
  InstallState,
  Marketplace,
  Plugin,
  Skill,
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
  const dirty = useIsSkillDirty(entry.folder);

  return (
    <div className="group">
      <div
        className={`flex items-center gap-1 rounded-md px-1 py-1 ${
          selected ? "bg-accent text-foreground" : "hover:bg-accent/50"
        }`}
      >
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
          {dirty && (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
              title="Modifié localement — non poussé"
              aria-label="Modifié localement"
            />
          )}
          {!entry.folder && entry.remotePresent && (
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

  return (
    <div className="px-2 py-1">
      <div
        className={cn(
          "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm font-medium hover:bg-accent",
          isSelected && "bg-accent"
        )}
        onClick={onSelectMarketplace}
      >
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
  return (
    <Card className="m-4">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="min-w-0 truncate">{marketplace.name}</CardTitle>
          {marketplace.installed ? (
            <Badge variant="success" className="shrink-0">
              installé
            </Badge>
          ) : (
            marketplace.sourceRepo && (
              <Button
                size="sm"
                className="shrink-0"
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
        </div>
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
      </CardContent>
    </Card>
  );
}

function PluginDetail({ plugin }: { plugin: Plugin }) {
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);

  const installMutation = useMutation({
    mutationFn: api.installPlugin,
    onSuccess: (_, p) => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
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
    mutationFn: api.uninstallPlugin,
    onSuccess: (_, p) => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
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
    }) => api.setPluginEnabled(pl, marketplace, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["refresh"] }),
    onError: (e, vars) =>
      notify({
        kind: "error",
        title: `Échec du basculement : ${vars.plugin}`,
        body: errMsg(e),
      }),
  });

  return (
    <Card className="m-4">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{plugin.name}</CardTitle>
            <CardDescription>
              {plugin.description || "Aucune description"}
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge variant={stateVariant(plugin.installState)}>
              {STATE_LABEL[plugin.installState]}
            </Badge>
            {readiness(plugin) && (
              <Badge variant={readiness(plugin)!.variant}>
                {readiness(plugin)!.label}
              </Badge>
            )}
          </div>
        </div>
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
          {(plugin.installState === "installed" ||
            plugin.installState === "outdated" ||
            plugin.installState === "local_only") && (
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
  );
}

// ---------- Detail: skill + file (mirrors the Skills tab) ----------

interface SkillDetailProps {
  entry: SkillEntry;
  mtimeIso: string | null;
  showDescription: boolean;
  onToggleDescription: () => void;
  localName: string;
  dirty: boolean;
  canPush: boolean;
  onPush: () => void;
}

function SkillDetailView({
  entry,
  mtimeIso,
  showDescription,
  onToggleDescription,
  localName,
  dirty,
  canPush,
  onPush,
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
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <h1 className="flex-1 truncate text-xl font-semibold">{entry.name}</h1>
        {entry.folder && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 px-2 text-xs"
            aria-label="Ouvrir dans VS Code"
            title="Ouvrir le dossier de ce skill dans VS Code"
            onClick={async () => {
              try {
                await api.openInVsCode(entry.folder as string);
              } catch (e) {
                useNotifications.getState().push({
                  kind: "error",
                  title: "Échec de l'ouverture dans VS Code",
                  body: errMsg(e),
                });
              }
            }}
          >
            <Code2 className="h-4 w-4" />
            VS Code
          </Button>
        )}
      </header>

      {dirty && canPush && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-6 py-3">
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium text-amber-700 dark:text-amber-300">
              Modifications locales détectées
            </span>
            <p className="text-xs text-muted-foreground">
              Ce dossier a changé depuis sa dernière synchro. Poussez-le pour
              ouvrir une PR — sinon ces modifs seront écrasées à la prochaine
              mise à jour du plugin.
            </p>
          </div>
          <Button size="sm" className="shrink-0 gap-1.5" onClick={onPush}>
            <UploadCloud className="h-4 w-4" />
            Pousser la modification
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
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <FileText className="h-5 w-5 shrink-0 text-violet-400/80" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{fileName}</h1>
          <div className="truncate text-xs text-muted-foreground">
            {entry.name} · {relativePath}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-2 text-xs"
          aria-label="Ouvrir dans VS Code"
          title="Ouvrir le dossier du skill dans VS Code"
          onClick={async () => {
            try {
              await api.openInVsCode(entry.folder as string);
            } catch (e) {
              useNotifications.getState().push({
                kind: "error",
                title: "Échec de l'ouverture dans VS Code",
                body: errMsg(e),
              });
            }
          }}
        >
          <Code2 className="h-4 w-4" />
          VS Code
        </Button>
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
}: {
  selection: Selection;
  localName: string;
  showDescription: boolean;
  onToggleDescription: () => void;
  onArchived: () => void;
  onRestored: () => void;
  onPushSkill: (entry: SkillEntry) => void;
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
  const skillDirty = useIsSkillDirty(selectedSkill?.folder);
  const skillMarketplace = selectedSkill
    ? findMarketplace(selectedSkill.marketplaceNameSafe)
    : undefined;
  const canPushSkill =
    !!selectedSkill?.folder &&
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
    return <PluginDetail plugin={p} />;
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
        dirty={skillDirty}
        canPush={canPushSkill}
        onPush={() => onPushSkill(selection.entry)}
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
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  const globalSelection = useApp((s) => s.selection);
  const findPlugin = useApp((s) => s.findPlugin);
  const findSkill = useApp((s) => s.findSkill);

  const [selection, setSelection] = useState<Selection>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [showDescription, setShowDescription] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [wizard, setWizard] = useState<WizardKind | null>(null);
  // Folder being pushed, so we can mark it synced once the PR is opened.
  const pushFolderRef = useRef<string | null>(null);
  const setDirtyOne = useSkillDirty((s) => s.setOne);

  const localName = localOnly?.name ?? "(local skills)";

  // Launch the upload-skill wizard pre-filled from the selected skill. The repo
  // path uses the folder's basename (not the frontmatter `name`) so it matches
  // `skills/<folder>` on the remote.
  const pushSkill = (entry: SkillEntry) => {
    const plugin = findPlugin(entry.marketplaceNameSafe, entry.pluginNameSafe);
    if (!plugin || !entry.folder) return;
    const folder = entry.folder as string;
    const basename =
      folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || entry.name;
    pushFolderRef.current = folder;
    setWizard({
      kind: "uploadSkill",
      marketplace: entry.marketplaceNameSafe,
      plugin,
      initialLocalFolder: folder,
      initialTargetName: basename,
    });
  };

  const onWizardSubmitted = () => {
    const folder = pushFolderRef.current;
    if (!folder) return;
    // The local folder now matches what we just pushed → clear the nudge.
    api.skillMarkSynced(folder).catch(() => {});
    setDirtyOne(folder, false);
  };

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

  const filtersActive = query.trim() !== "" || stateFilter !== "all";

  const skillVisible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (s: Skill, pluginName: string): boolean => {
      if (q) {
        const hit =
          s.name.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q) ||
          pluginName.toLowerCase().includes(q);
        if (!hit) return false;
      }
      if (stateFilter === "installed" && !skillInstalled(s)) return false;
      if (stateFilter === "not_installed" && skillInstalled(s)) return false;
      return true;
    };
  }, [query, stateFilter]);

  // Build the filtered tree: marketplaces → plugins → visible skills.
  const tree = useMemo(() => {
    return list
      .map((m) => {
        const plugins = m.plugins
          .map((plugin) => ({
            plugin,
            visibleSkills: plugin.skills.filter((s) =>
              skillVisible(s, plugin.name)
            ),
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
          if (skillVisible(s, p.name)) visible += 1;
        }
      }
    }
    return { total, visible };
  }, [list, skillVisible]);

  const selectedDuplicateFolder =
    selection?.kind === "duplicate" ? selection.value.local.folder : null;
  const selectedArchivedFolder =
    selection?.kind === "archived" ? selection.value.folder : null;

  const left = (
    <>
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <h2 className="flex-1 truncate text-sm font-semibold">
          Marketplaces · plugins · skills
        </h2>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setAddOpen(true)}
          title="Ajouter un marketplace depuis une URL Git"
        >
          <Plus className="h-3.5 w-3.5" />
          Ajouter
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
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Rechercher un plugin ou une compétence…"
            className="h-8 pl-9 text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
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

      <ScrollArea className="flex-1">
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
    </>
  );

  const right = (
    <ScrollArea className="h-full">
      <DetailPanel
        selection={selection}
        localName={localName}
        showDescription={showDescription}
        onToggleDescription={() => setShowDescription((v) => !v)}
        onArchived={() => setSelection(null)}
        onRestored={() => setSelection(null)}
        onPushSkill={pushSkill}
      />
    </ScrollArea>
  );

  return (
    <div className="h-full min-h-0 w-full min-w-0 flex-1">
      <ResizableSplit
        storageId="skills"
        left={left}
        right={right}
        defaultLeftSize={32}
      />
      <AddMarketplaceDialog open={addOpen} onOpenChange={setAddOpen} />
      <WizardHost
        active={wizard}
        onClose={() => setWizard(null)}
        onSubmitted={onWizardSubmitted}
      />
    </div>
  );
}

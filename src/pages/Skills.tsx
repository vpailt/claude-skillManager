import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code2,
  FileText,
  Folder,
  Info,
  MoreVertical,
  Plus,
  Search,
  Sparkles,
  Filter,
  X,
} from "lucide-react";
import { useApp } from "@/stores/app";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizableSplit } from "@/components/ResizableSplit";
import { SkillMarkdown } from "@/components/SkillMarkdown";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ArchivedSkill, DuplicateSkill, Skill } from "@/lib/types";
import {
  ArchivedSkillDetail,
  DuplicateSkillDetail,
  DuplicateSkillsPanel,
} from "@/components/DuplicateSkillsPanel";
import { ArchivedSkillsPanel } from "@/components/ArchivedSkillsPanel";
import { useNotifications } from "@/stores/notifications";

interface SkillEntry extends Skill {
  pluginNameSafe: string;
  marketplaceNameSafe: string;
  pluginEnabled: boolean | null;
}

interface FileSelection {
  skill: SkillEntry;
  relativePath: string;
}

type Selection =
  | { kind: "skill"; value: SkillEntry }
  | { kind: "file"; value: FileSelection }
  | { kind: "duplicate"; value: DuplicateSkill }
  | { kind: "archived"; value: ArchivedSkill }
  | null;

function joinPath(folder: string, rel: string): string {
  if (!folder) return rel;
  const trimmed = folder.replace(/[\\/]+$/, "");
  return `${trimmed}/${rel}`;
}

type Origin = "all" | "local" | "plugin" | "remote";

const ORIGIN_LABELS: Record<Origin, string> = {
  all: "All",
  local: "Local",
  plugin: "Plugin",
  remote: "Remote",
};

function skillKey(s: SkillEntry) {
  return `${s.marketplaceNameSafe}/${s.pluginNameSafe}/${s.name}`;
}

function isLocal(s: SkillEntry, localName: string) {
  return s.marketplaceNameSafe === localName;
}

// ---------- Tree helpers ----------

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
        node.children[part] = {
          name: part,
          isDir: !last,
          children: {},
        };
      }
      node = node.children[part];
      // A directory may appear later as a file segment of a sibling; once
      // marked as having children it stays directory.
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
        onClick={() =>
          node.isDir ? onToggle(path) : onSelectFile(path)
        }
        className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/40 ${
          isSelected
            ? "bg-accent text-foreground"
            : "text-muted-foreground"
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
          className={`h-3 w-3 shrink-0 ${
            isSkillMd ? "text-violet-400" : ""
          } ${node.isDir ? "text-amber-400/80" : ""}`}
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

// ---------- Skill tree row (expandable) ----------

interface SkillRowProps {
  skill: SkillEntry;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onSelectFile: (skill: SkillEntry, relativePath: string) => void;
  selectedFilePath: string | null;
  localName: string;
}

function SkillRow({
  skill,
  selected,
  expanded,
  onSelect,
  onToggle,
  onSelectFile,
  selectedFilePath,
  localName,
}: SkillRowProps) {
  const filesQuery = useQuery({
    enabled: !!skill.folder && expanded,
    queryKey: ["skill-files", skill.folder],
    queryFn: () => api.listSkillFiles(skill.folder as string),
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

  const tree = useMemo(
    () => buildTree(filesQuery.data ?? []),
    [filesQuery.data]
  );

  const hasFolder = !!skill.folder;
  const localBadge = isLocal(skill, localName);

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
          aria-label={expanded ? "Collapse" : "Expand"}
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
            className={`min-w-0 flex-1 truncate ${
              selected ? "font-semibold" : ""
            }`}
          >
            {skill.name}
          </span>
          {!skill.folder && skill.remotePresent && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              remote
            </Badge>
          )}
          {localBadge && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              local
            </Badge>
          )}
        </button>
      </div>
      {expanded && hasFolder && (
        <div className="ml-2 border-l border-border/40 pl-2">
          {filesQuery.isLoading && (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              Loading…
            </div>
          )}
          {filesQuery.data && filesQuery.data.length === 0 && (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              (empty)
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
              onSelectFile={(p) => onSelectFile(skill, p)}
              selectedPath={selectedFilePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Tree section (Personnelles / per-plugin) ----------

interface SectionProps {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function Section({ title, count, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="flex-1 truncate normal-case">{title}</span>
        <span className="text-[10px] text-muted-foreground/70">{count}</span>
      </button>
      {open && <div className="mt-0.5">{children}</div>}
    </div>
  );
}

// ---------- Metadata helpers ----------

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
  if (isLocal(s, localName)) return "Auto · description";
  return "Plugin · auto";
}

function authorLabel(s: SkillEntry, localName: string): string {
  if (isLocal(s, localName)) return "Vous";
  return `${s.pluginNameSafe}@${s.marketplaceNameSafe}`;
}

// ---------- Main page ----------

export function SkillsPage() {
  const qc = useQueryClient();
  const push = useNotifications((s) => s.push);
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [origin, setOrigin] = useState<Origin>("all");
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>("all");
  const [pluginFilter, setPluginFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());
  const [showDescription, setShowDescription] = useState(true);

  const localName = localOnly?.name ?? "(local skills)";

  // Honour ?marketplace=...&plugin=... when navigated to from the Plugins page.
  // We do this on every searchParams change so a second click from Plugins
  // re-applies the filter even when the user has cleared it manually.
  useEffect(() => {
    const mp = searchParams.get("marketplace");
    const pl = searchParams.get("plugin");
    if (mp) setMarketplaceFilter(mp);
    if (pl) setPluginFilter(pl);
  }, [searchParams]);

  const clearPluginFilter = () => {
    setPluginFilter(null);
    setMarketplaceFilter("all");
    if (searchParams.has("plugin") || searchParams.has("marketplace")) {
      const next = new URLSearchParams(searchParams);
      next.delete("plugin");
      next.delete("marketplace");
      setSearchParams(next, { replace: true });
    }
  };

  const all = useMemo<SkillEntry[]>(() => {
    const out: SkillEntry[] = [];
    for (const m of marketplaces) {
      for (const p of m.plugins) {
        for (const s of p.skills) {
          out.push({
            ...s,
            pluginNameSafe: p.name,
            marketplaceNameSafe: m.name,
            pluginEnabled: p.enabled ?? null,
          });
        }
      }
    }
    if (localOnly) {
      for (const p of localOnly.plugins) {
        for (const s of p.skills) {
          out.push({
            ...s,
            pluginNameSafe: p.name,
            marketplaceNameSafe: localOnly.name,
            pluginEnabled: null,
          });
        }
      }
    }
    return out;
  }, [marketplaces, localOnly]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((s) => {
      if (q) {
        const hit =
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.pluginNameSafe.toLowerCase().includes(q);
        if (!hit) return false;
      }
      if (
        marketplaceFilter !== "all" &&
        s.marketplaceNameSafe !== marketplaceFilter
      )
        return false;
      if (pluginFilter && s.pluginNameSafe !== pluginFilter) return false;
      if (origin === "local" && !isLocal(s, localName)) return false;
      if (origin === "plugin" && (isLocal(s, localName) || !s.folder))
        return false;
      if (origin === "remote" && (s.folder || !s.remotePresent)) return false;
      return true;
    });
  }, [all, query, origin, marketplaceFilter, pluginFilter, localName]);

  const marketplaceNames = useMemo(() => {
    const set = new Set<string>();
    for (const s of all) set.add(s.marketplaceNameSafe);
    return Array.from(set).sort();
  }, [all]);

  // Group by marketplace; "(local skills)" → "Compétences personnelles".
  const grouped = useMemo(() => {
    const map = new Map<string, SkillEntry[]>();
    for (const s of filtered) {
      const arr = map.get(s.marketplaceNameSafe) ?? [];
      arr.push(s);
      map.set(s.marketplaceNameSafe, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  }, [filtered]);

  const selectedSkill =
    selected?.kind === "skill"
      ? selected.value
      : selected?.kind === "file"
      ? selected.value.skill
      : null;
  const selectedFile = selected?.kind === "file" ? selected.value : null;
  const selectedFileAbs = selectedFile
    ? joinPath(selectedFile.skill.folder as string, selectedFile.relativePath)
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

  const togglePlugin = useMutation({
    mutationFn: ({
      plugin,
      marketplace,
      value,
    }: {
      plugin: string;
      marketplace: string;
      value: boolean;
    }) => api.setPluginEnabled(plugin, marketplace, value),
    onSuccess: (_, vars) => {
      push({
        kind: "success",
        title: `Plugin ${vars.value ? "enabled" : "disabled"}`,
        body: `${vars.plugin}@${vars.marketplace}`,
      });
      qc.invalidateQueries({ queryKey: ["refresh"] });
    },
  });

  const selectedDuplicateFolder =
    selected?.kind === "duplicate" ? selected.value.local.folder : null;
  const selectedArchivedFolder =
    selected?.kind === "archived" ? selected.value.folder : null;

  const toggleExpanded = (key: string) =>
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // ---------- Left ----------

  const sectionOrder = useMemo(() => {
    const names = Array.from(grouped.keys());
    return names.sort((a, b) => {
      if (a === localName) return -1;
      if (b === localName) return 1;
      return a.localeCompare(b);
    });
  }, [grouped, localName]);

  const left = (
    <>
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <h2 className="flex-1 truncate text-sm font-semibold">Compétences</h2>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => setShowSearch((v) => !v)}
          aria-label="Search"
        >
          <Search className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => (window.location.hash = "#/admin")}
          aria-label="New skill"
          title="Add a new skill via Admin"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-2 border-b p-3">
        <DuplicateSkillsPanel
          selectedFolder={selectedDuplicateFolder}
          onSelect={(d) => setSelected({ kind: "duplicate", value: d })}
        />
        <ArchivedSkillsPanel
          selectedFolder={selectedArchivedFolder}
          onSelect={(s) => setSelected({ kind: "archived", value: s })}
        />
        {showSearch && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              placeholder="Filter skills…"
              className="h-8 pl-9 text-xs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <Filter className="h-3 w-3 text-muted-foreground" />
          {(Object.keys(ORIGIN_LABELS) as Origin[]).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={origin === k ? "default" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setOrigin(k)}
            >
              {ORIGIN_LABELS[k]}
            </Button>
          ))}
        </div>
        {pluginFilter && (
          <div className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[11px]">
            <Sparkles className="h-3 w-3 text-primary" />
            <span className="truncate">
              Plugin: <span className="font-medium">{pluginFilter}</span>
            </span>
            <button
              onClick={clearPluginFilter}
              className="ml-auto grid h-4 w-4 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Clear plugin filter"
              title="Clear plugin filter"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {marketplaceNames.length > 1 && (
          <select
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
            value={marketplaceFilter}
            onChange={(e) => setMarketplaceFilter(e.target.value)}
          >
            <option value="all">All marketplaces</option>
            {marketplaceNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
        <p className="text-[11px] text-muted-foreground">
          {filtered.length} of {all.length} skills
        </p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2">
          {filtered.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
              <Sparkles className="h-6 w-6 opacity-40" />
              <span>No skill matches your filters.</span>
            </div>
          )}
          {sectionOrder.map((mp) => {
            const skills = grouped.get(mp) ?? [];
            const title =
              mp === localName ? "Compétences personnelles" : mp;
            return (
              <Section
                key={mp}
                title={title}
                count={skills.length}
                defaultOpen={mp === localName}
              >
                {skills.map((s) => {
                  const k = skillKey(s);
                  const isSel =
                    (selected?.kind === "skill" &&
                      skillKey(selected.value) === k) ||
                    (selected?.kind === "file" &&
                      skillKey(selected.value.skill) === k);
                  const selectedFileForRow =
                    selected?.kind === "file" &&
                    skillKey(selected.value.skill) === k
                      ? selected.value.relativePath
                      : null;
                  return (
                    <SkillRow
                      key={k}
                      skill={s}
                      selected={isSel}
                      expanded={expandedSkills.has(k)}
                      onSelect={() =>
                        setSelected({ kind: "skill", value: s })
                      }
                      onToggle={() => toggleExpanded(k)}
                      onSelectFile={(skill, relativePath) => {
                        setSelected({
                          kind: "file",
                          value: { skill, relativePath },
                        });
                      }}
                      selectedFilePath={selectedFileForRow}
                      localName={localName}
                    />
                  );
                })}
              </Section>
            );
          })}
        </div>
      </ScrollArea>
    </>
  );

  // ---------- Right ----------

  const right = (
    <div className="h-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
      {!selected && (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
          <Sparkles className="h-8 w-8 opacity-40" />
          <span>
            Pick a skill to see its description, expand it to browse files,
            or open a duplicate / archived entry.
          </span>
        </div>
      )}

      {selected?.kind === "duplicate" && (
        <div className="p-6">
          <DuplicateSkillDetail
            dup={selected.value}
            onArchived={() => setSelected(null)}
          />
        </div>
      )}

      {selected?.kind === "archived" && (
        <div className="p-6">
          <ArchivedSkillDetail
            skill={selected.value}
            onRestored={() => setSelected(null)}
          />
        </div>
      )}

      {selected?.kind === "skill" && (
        <SkillDetailView
          skill={selected.value}
          mtimeIso={mtime.data ?? null}
          showDescription={showDescription}
          onToggleDescription={() => setShowDescription((v) => !v)}
          localName={localName}
          onTogglePlugin={(value) => {
            if (selected.value.pluginEnabled === null) return;
            togglePlugin.mutate({
              plugin: selected.value.pluginNameSafe,
              marketplace: selected.value.marketplaceNameSafe,
              value,
            });
          }}
        />
      )}

      {selected?.kind === "file" && (
        <FileDetailView
          skill={selected.value.skill}
          relativePath={selected.value.relativePath}
          absPath={selectedFileAbs as string}
          content={fileContent.data}
          loading={fileContent.isLoading}
          error={fileContent.error as Error | null}
        />
      )}
    </div>
  );

  return (
    <div className="h-full min-h-0 w-full min-w-0 flex-1">
      <ResizableSplit storageId="skills" left={left} right={right} />
    </div>
  );
}

// ---------- Right-side detail view ----------

interface DetailProps {
  skill: SkillEntry;
  mtimeIso: string | null;
  showDescription: boolean;
  onToggleDescription: () => void;
  localName: string;
  onTogglePlugin: (value: boolean) => void;
}

function SkillDetailView({
  skill,
  mtimeIso,
  showDescription,
  onToggleDescription,
  localName,
  onTogglePlugin,
}: DetailProps) {
  const hasToggle = skill.pluginEnabled !== null;
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <h1 className="flex-1 truncate text-xl font-semibold">{skill.name}</h1>
        {hasToggle && (
          <Switch
            checked={skill.pluginEnabled === true}
            onCheckedChange={onTogglePlugin}
            aria-label="Toggle plugin"
          />
        )}
        {skill.folder && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 px-2 text-xs"
            aria-label="Open in VS Code"
            title="Open this skill folder in VS Code"
            onClick={async () => {
              try {
                await api.openInVsCode(skill.folder as string);
              } catch (e) {
                useNotifications.getState().push({
                  kind: "error",
                  title: "Open in VS Code failed",
                  body: e instanceof Error ? e.message : String(e),
                });
              }
            }}
          >
            <Code2 className="h-4 w-4" />
            VS Code
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0 text-muted-foreground"
          aria-label="More"
          title="More actions (Admin tab)"
          onClick={() => (window.location.hash = "#/admin")}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-x-8 gap-y-3 border-b px-6 py-4 text-xs sm:grid-cols-3">
        <MetaItem label="Ajouté par" value={authorLabel(skill, localName)} />
        <MetaItem label="Dernière mise à jour" value={formatDate(mtimeIso)} />
        <MetaItem label="Déclencheur" value={triggerLabel(skill, localName)} />
      </div>

      <div className="flex items-center gap-1.5 border-b px-6 py-3 text-xs">
        <span className="font-medium text-muted-foreground">Description</span>
        <button
          onClick={onToggleDescription}
          className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent"
          aria-label="Toggle description"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </div>
      {showDescription && skill.description && (
        <div className="border-b px-6 py-3 text-sm text-muted-foreground">
          {skill.description}
        </div>
      )}

      <div className="min-w-0 flex-1 p-6">
        {skill.folder && (
          <div className="mb-3 overflow-hidden break-all rounded-md bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
            {skill.folder.toString()}
          </div>
        )}
        {!skill.folder && (
          <div className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            Remote-only skill — install the plugin to browse its files.
          </div>
        )}
        {skill.folder && (
          <div className="rounded-md border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            Expand the skill on the left and click a file to view its
            contents.
          </div>
        )}
      </div>
    </div>
  );
}

interface FileDetailProps {
  skill: SkillEntry;
  relativePath: string;
  absPath: string;
  content: string | undefined;
  loading: boolean;
  error: Error | null;
}

function FileDetailView({
  skill,
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
          <div className="truncate text-[11px] text-muted-foreground">
            {skill.name} · {relativePath}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-2 text-xs"
          aria-label="Open in VS Code"
          title="Open this file in VS Code"
          onClick={async () => {
            try {
              await api.openInVsCode(absPath);
            } catch (e) {
              useNotifications.getState().push({
                kind: "error",
                title: "Open in VS Code failed",
                body: e instanceof Error ? e.message : String(e),
              });
            }
          }}
        >
          <Code2 className="h-4 w-4" />
          VS Code
        </Button>
      </header>

      <div className="min-w-0 flex-1 p-6">
        <div className="mb-3 overflow-hidden break-all rounded-md bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
          {absPath}
        </div>
        <div className="min-w-0 max-w-full overflow-hidden rounded-lg border bg-card p-6 shadow-sm">
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : error ? (
            <div className="text-xs text-destructive">
              Failed to read file: {error.message}
            </div>
          ) : content === undefined ? (
            <div className="text-xs text-muted-foreground">(no content)</div>
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

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
        {label}
      </div>
      <div className="truncate text-foreground">{value}</div>
    </div>
  );
}

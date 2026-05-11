import { useMemo, useState } from "react";
import { Sparkles, Search, Filter, ChevronRight } from "lucide-react";
import { useApp } from "@/stores/app";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ResizableSplit } from "@/components/ResizableSplit";
import { SkillMarkdown } from "@/components/SkillMarkdown";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ArchivedSkill, DuplicateSkill, Skill } from "@/lib/types";
import {
  ArchivedSkillDetail,
  DuplicateSkillDetail,
  DuplicateSkillsPanel,
} from "@/components/DuplicateSkillsPanel";
import { ArchivedSkillsPanel } from "@/components/ArchivedSkillsPanel";

interface SkillEntry extends Skill {
  pluginNameSafe: string;
  marketplaceNameSafe: string;
}

type Selection =
  | { kind: "skill"; value: SkillEntry }
  | { kind: "duplicate"; value: DuplicateSkill }
  | { kind: "archived"; value: ArchivedSkill }
  | null;

type Origin = "all" | "local" | "plugin" | "remote";

const ORIGIN_LABELS: Record<Origin, string> = {
  all: "All",
  local: "Local",
  plugin: "Plugin",
  remote: "Remote",
};

function isLocal(s: SkillEntry, localName: string) {
  return s.marketplaceNameSafe === localName;
}

export function SkillsPage() {
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState<Origin>("all");
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Selection>(null);

  const localName = localOnly?.name ?? "(local skills)";

  const all = useMemo<SkillEntry[]>(() => {
    const out: SkillEntry[] = [];
    for (const m of marketplaces) {
      for (const p of m.plugins) {
        for (const s of p.skills) {
          out.push({
            ...s,
            pluginNameSafe: p.name,
            marketplaceNameSafe: m.name,
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
      if (origin === "local" && !isLocal(s, localName)) return false;
      if (origin === "plugin" && (isLocal(s, localName) || !s.folder))
        return false;
      if (origin === "remote" && (s.folder || !s.remotePresent)) return false;
      return true;
    });
  }, [all, query, origin, marketplaceFilter, localName]);

  const marketplaceNames = useMemo(() => {
    const set = new Set<string>();
    for (const s of all) set.add(s.marketplaceNameSafe);
    return Array.from(set).sort();
  }, [all]);

  const selectedSkill =
    selected?.kind === "skill" ? selected.value : null;

  const skillContent = useQuery({
    enabled: !!selectedSkill?.skillMdPath,
    queryKey: ["skill-md", selectedSkill?.skillMdPath],
    queryFn: () => api.readTextFile(selectedSkill!.skillMdPath as string),
  });

  const selectedDuplicateFolder =
    selected?.kind === "duplicate" ? selected.value.local.folder : null;
  const selectedArchivedFolder =
    selected?.kind === "archived" ? selected.value.folder : null;

  const left = (
    <>
      <div className="space-y-3 border-b p-4">
        <DuplicateSkillsPanel
          selectedFolder={selectedDuplicateFolder}
          onSelect={(d) => setSelected({ kind: "duplicate", value: d })}
        />
        <ArchivedSkillsPanel
          selectedFolder={selectedArchivedFolder}
          onSelect={(s) => setSelected({ kind: "archived", value: s })}
        />
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search skills…"
            className="pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
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
        <p className="text-xs text-muted-foreground">
          {filtered.length} of {all.length} skills
        </p>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {filtered.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
              <Sparkles className="h-6 w-6 opacity-40" />
              <span>No skill matches your filters.</span>
            </div>
          )}
          {filtered.map((s) => {
            const isSelected =
              selected?.kind === "skill" &&
              selected.value.name === s.name &&
              selected.value.pluginNameSafe === s.pluginNameSafe &&
              selected.value.marketplaceNameSafe === s.marketplaceNameSafe;
            return (
              <button
                key={`${s.marketplaceNameSafe}/${s.pluginNameSafe}/${s.name}`}
                onClick={() => setSelected({ kind: "skill", value: s })}
                className={`w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${
                  isSelected ? "bg-accent" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{s.name}</span>
                  {!s.folder && s.remotePresent && (
                    <Badge variant="outline" className="text-[10px]">
                      remote
                    </Badge>
                  )}
                  {isLocal(s, localName) && (
                    <Badge variant="secondary" className="text-[10px]">
                      local
                    </Badge>
                  )}
                </div>
                <div className="ml-5 truncate text-xs text-muted-foreground">
                  {s.pluginNameSafe} · {s.marketplaceNameSafe}
                </div>
                {s.description && (
                  <div className="ml-5 line-clamp-2 text-xs text-muted-foreground">
                    {s.description}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </>
  );

  const right = (
    <ScrollArea className="h-full">
      <div className="p-4">
        {!selected && (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-20 text-center text-sm text-muted-foreground">
            <Sparkles className="h-8 w-8 opacity-40" />
            <span>
              Pick a skill, a duplicate or an archived entry to view details.
            </span>
          </div>
        )}
        {selected?.kind === "duplicate" && (
          <DuplicateSkillDetail
            dup={selected.value}
            onArchived={() => setSelected(null)}
          />
        )}
        {selected?.kind === "archived" && (
          <ArchivedSkillDetail
            skill={selected.value}
            onRestored={() => setSelected(null)}
          />
        )}
        {selected?.kind === "skill" && (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <span>{selected.value.marketplaceNameSafe}</span>
                <ChevronRight className="h-3 w-3" />
                <span>{selected.value.pluginNameSafe}</span>
                <ChevronRight className="h-3 w-3" />
                <span className="text-foreground">{selected.value.name}</span>
              </div>
              <CardTitle className="mt-1">{selected.value.name}</CardTitle>
              <CardDescription>{selected.value.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {selected.value.folder && (
                <div className="break-all rounded-md bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                  {selected.value.folder.toString()}
                </div>
              )}
              {selected.value.skillMdPath && (
                <div className="rounded-md border bg-card p-4">
                  {skillContent.isLoading ? (
                    <div className="text-xs text-muted-foreground">Loading…</div>
                  ) : skillContent.data ? (
                    <SkillMarkdown content={skillContent.data} />
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      (failed to read)
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </ScrollArea>
  );

  return (
    <div className="h-full min-h-0">
      <ResizableSplit storageId="skills" left={left} right={right} />
    </div>
  );
}

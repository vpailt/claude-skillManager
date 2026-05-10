import { useMemo, useState } from "react";
import { Sparkles, Search } from "lucide-react";
import { useApp } from "@/stores/app";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Skill } from "@/lib/types";

interface SkillEntry extends Skill {
  pluginNameSafe: string;
  marketplaceNameSafe: string;
}

export function SkillsPage() {
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SkillEntry | null>(null);

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
    if (!q) return all;
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.pluginNameSafe.toLowerCase().includes(q)
    );
  }, [all, query]);

  const skillContent = useQuery({
    enabled: !!selected?.skillMdPath,
    queryKey: ["skill-md", selected?.skillMdPath],
    queryFn: () => api.readTextFile(selected!.skillMdPath as string),
  });

  return (
    <div className="grid h-full grid-cols-[400px_1fr] divide-x">
      <div className="flex h-full flex-col">
        <div className="border-b p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search skills…"
              className="pl-9"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {filtered.length} of {all.length} skills
          </p>
        </div>
        <ScrollArea className="flex-1">
          <div className="space-y-1 p-2">
            {filtered.map((s) => (
              <button
                key={`${s.marketplaceNameSafe}/${s.pluginNameSafe}/${s.name}`}
                onClick={() => setSelected(s)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${
                  selected?.name === s.name &&
                  selected?.pluginNameSafe === s.pluginNameSafe &&
                  selected?.marketplaceNameSafe === s.marketplaceNameSafe
                    ? "bg-accent"
                    : ""
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
            ))}
          </div>
        </ScrollArea>
      </div>
      <ScrollArea className="h-full">
        <div className="p-4">
          {selected ? (
            <Card>
              <CardHeader>
                <CardTitle>{selected.name}</CardTitle>
                <CardDescription>{selected.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Plugin:</span>{" "}
                  {selected.pluginNameSafe}
                </div>
                <div>
                  <span className="text-muted-foreground">Marketplace:</span>{" "}
                  {selected.marketplaceNameSafe}
                </div>
                {selected.folder && (
                  <div className="break-all text-xs text-muted-foreground">
                    {selected.folder.toString()}
                  </div>
                )}
                {selected.skillMdPath && (
                  <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
                    {skillContent.isLoading
                      ? "Loading…"
                      : skillContent.data ?? "(failed to read)"}
                  </pre>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a skill to preview its SKILL.md.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

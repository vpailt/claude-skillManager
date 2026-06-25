import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { cn, shortDate } from "@/lib/utils";
import type { ArchivedSkill } from "@/lib/types";

interface ArchivedSkillsPanelProps {
  selectedFolder: string | null;
  onSelect: (skill: ArchivedSkill) => void;
}

export function ArchivedSkillsPanel({
  selectedFolder,
  onSelect,
}: ArchivedSkillsPanelProps) {
  const [open, setOpen] = useState(false);
  const archived = useQuery({
    queryKey: ["archived-skills"],
    queryFn: api.listArchivedSkills,
    staleTime: 60_000,
  });

  const items = archived.data ?? [];
  if (archived.isLoading) return null;
  if (items.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-left text-sm"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <Archive className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold">Skills archivés ({items.length})</span>
        </button>
        {open && (
          <div className="space-y-1">
            {items.map((s) => {
              const isSelected = selectedFolder === s.folder;
              return (
                <button
                  key={s.folder}
                  type="button"
                  onClick={() => onSelect(s)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                    isSelected
                      ? "border-foreground/30 bg-accent"
                      : "border-transparent",
                  )}
                >
                  <span className="truncate font-medium">{s.name}</span>
                  {s.version && (
                    <Badge variant="outline" className="text-xs">
                      v{s.version}
                    </Badge>
                  )}
                  <span className="ml-auto text-muted-foreground">
                    {shortDate(s.archivedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

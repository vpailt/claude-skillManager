import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  HardDrive,
  Loader2,
  Package,
  Trash2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { shortDate } from "@/lib/utils";
import type { DuplicateCopy, DuplicateSkill } from "@/lib/types";

function CopyCard({
  copy,
  origin,
}: {
  copy: DuplicateCopy;
  origin: "local" | "plugin";
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        {origin === "local" ? (
          <HardDrive className="h-3 w-3 text-muted-foreground" />
        ) : (
          <Package className="h-3 w-3 text-muted-foreground" />
        )}
        <span className="font-medium text-foreground">{copy.source}</span>
        {copy.version ? (
          <Badge variant="outline" className="text-[10px]">
            v{copy.version}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            no version
          </Badge>
        )}
      </div>
      <div className="space-y-0.5 text-muted-foreground">
        <div>
          <span className="text-foreground/70">Modified:</span>{" "}
          {copy.lastModified ? shortDate(copy.lastModified) : "—"}
        </div>
        <div className="break-all">
          <span className="text-foreground/70">Folder:</span> {copy.folder}
        </div>
        {copy.description && (
          <div className="line-clamp-2 italic">{copy.description}</div>
        )}
      </div>
    </div>
  );
}

function DuplicateRow({ dup }: { dup: DuplicateSkill }) {
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");
  const qc = useQueryClient();

  const remove = useMutation({
    mutationFn: () => api.deleteUserSkill(dup.local.folder),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["duplicate-skills"] });
      qc.invalidateQueries({ queryKey: ["refresh"] });
      setConfirmOpen(false);
      setError("");
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const localDate = dup.local.lastModified
    ? new Date(dup.local.lastModified).getTime()
    : 0;
  const newestPluginDate = dup.pluginCopies.reduce((acc, c) => {
    const t = c.lastModified ? new Date(c.lastModified).getTime() : 0;
    return t > acc ? t : acc;
  }, 0);
  const localIsNewer = localDate > 0 && localDate > newestPluginDate;
  const localIsOlder = newestPluginDate > 0 && localDate < newestPluginDate;

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
          <span className="font-medium">{dup.name}</span>
          <Badge variant="warning" className="text-[10px]">
            duplicate
          </Badge>
          <span className="text-xs text-muted-foreground">
            local + {dup.pluginCopies.length} plugin copy
            {dup.pluginCopies.length === 1 ? "" : "ies"}
          </span>
          {localIsNewer && (
            <Badge variant="secondary" className="ml-auto text-[10px]">
              local is newer
            </Badge>
          )}
          {localIsOlder && (
            <Badge variant="outline" className="ml-auto text-[10px]">
              local is older
            </Badge>
          )}
        </button>

        {open && (
          <div className="grid grid-cols-1 gap-2 pt-1 md:grid-cols-2">
            <CopyCard copy={dup.local} origin="local" />
            <div className="space-y-2">
              {dup.pluginCopies.map((c, i) => (
                <CopyCard key={i} copy={c} origin="plugin" />
              ))}
            </div>
            <div className="md:col-span-2 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs text-destructive"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Delete local copy
              </Button>
            </div>
          </div>
        )}

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete local skill “{dup.name}”?</DialogTitle>
              <DialogDescription>
                Removes the folder under{" "}
                <code className="break-all">{dup.local.folder}</code>. The
                plugin copy is not affected. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {error}
              </div>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button
                variant="destructive"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                {remove.isPending && (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                )}
                Delete local
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export function DuplicateSkillsPanel() {
  const dup = useQuery({
    queryKey: ["duplicate-skills"],
    queryFn: api.listDuplicateSkills,
    staleTime: 60_000,
  });

  if (dup.isLoading || !dup.data) return null;
  if (dup.data.length === 0) return null;

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardContent className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h3 className="text-sm font-semibold">
            Duplicate skills ({dup.data.length})
          </h3>
          <span className="text-xs text-muted-foreground">
            present both in <code>~/.claude/skills/</code> and in an installed
            plugin
          </span>
        </div>
        <div className="space-y-2">
          {dup.data.map((d) => (
            <DuplicateRow key={`${d.name}:${d.local.folder}`} dup={d} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

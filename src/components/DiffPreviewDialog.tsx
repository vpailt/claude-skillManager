import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  GitBranch,
  Package,
  Plus,
  Pencil,
  Trash,
  Tag,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import type { AdminDraft, UploadResult } from "@/lib/types";
import { useUi } from "@/stores/ui";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: AdminDraft | null;
  onSubmitted?: (result: UploadResult, companion?: UploadResult) => void;
}

function ActionIcon({ action }: { action: string }) {
  if (action === "add") return <Plus className="h-3 w-3 text-emerald-500" />;
  if (action === "delete") return <Trash className="h-3 w-3 text-destructive" />;
  return <Pencil className="h-3 w-3 text-amber-500" />;
}

function FileDiff({ entry }: { entry: AdminDraft["entries"][number] }) {
  const [open, setOpen] = useState(true);
  const theme = useUi((s) => s.ui.theme);
  const resolvedTheme =
    theme === "auto"
      ? document.documentElement.classList.contains("dark")
        ? "dark"
        : "light"
      : theme;
  return (
    <div className="overflow-hidden rounded-md border">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-left text-xs hover:bg-muted/60"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <ActionIcon action={entry.action} />
        <code className="font-mono text-[11px]">{entry.path}</code>
        <Badge variant="outline" className="ml-auto text-[10px]">
          {entry.action}
        </Badge>
      </button>
      {open && (
        <div className="max-h-[400px] overflow-auto">
          {entry.newContent === null && entry.oldContent === null ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              (summary entry — no inline diff)
            </div>
          ) : (
            <ReactDiffViewer
              oldValue={entry.oldContent ?? ""}
              newValue={entry.newContent ?? ""}
              splitView={false}
              hideLineNumbers={false}
              useDarkTheme={resolvedTheme === "dark"}
              styles={{
                contentText: {
                  fontSize: "11px",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                },
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function DiffPreviewDialog({
  open,
  onOpenChange,
  draft,
  onSubmitted,
}: Props) {
  const [tagCreated, setTagCreated] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);

  const createTagMutation = useMutation({
    mutationFn: ({ repo, tag }: { repo: string; tag: string }) =>
      api.adminCreateTag(repo, tag),
    onSuccess: () => {
      setTagCreated(true);
      setTagError(null);
    },
    onError: (e: unknown) => {
      setTagError(e instanceof Error ? e.message : String(e));
    },
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("no draft");
      const main = await api.adminSubmitDraft(draft);
      let companion: UploadResult | undefined;
      if (draft.companion) {
        try {
          companion = await api.adminSubmitDraft(draft.companion);
        } catch (e) {
          // surface but don't fail the main PR
          companion = undefined;
          console.error("companion PR failed", e);
        }
      }
      return { main, companion };
    },
    onSuccess: ({ main, companion }) => {
      onSubmitted?.(main, companion);
      onOpenChange(false);
    },
  });

  if (!draft) return null;

  const hasErrors = draft.problems.length > 0;
  const hasConflicts = draft.conflicts.length > 0;
  const tagBlocked = draft.needsTag !== null && !tagCreated;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            {draft.prTitle}
          </DialogTitle>
          <DialogDescription className="space-y-1">
            <div className="flex items-center gap-2">
              <Package className="h-3 w-3" />
              <code className="text-xs">{draft.targetRepo}</code>
              <span className="text-muted-foreground">→</span>
              <code className="text-xs">{draft.branchName}</code>
              <span className="text-muted-foreground">on</span>
              <code className="text-xs">{draft.baseBranch}</code>
            </div>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-3">
          <div className="space-y-3">
            {draft.needsTag && (
              <Card>
                <CardContent className="flex items-center gap-3 p-3 text-sm">
                  <Tag className="h-4 w-4 text-amber-500" />
                  <div className="flex-1">
                    Tag <code className="font-mono">{draft.needsTag.tag}</code> is
                    missing on <code className="font-mono">{draft.needsTag.repo}</code>.
                    {tagCreated && (
                      <span className="ml-2 text-emerald-600">Created.</span>
                    )}
                    {tagError && (
                      <div className="text-destructive">{tagError}</div>
                    )}
                  </div>
                  {!tagCreated && (
                    <Button
                      size="sm"
                      onClick={() =>
                        createTagMutation.mutate({
                          repo: draft.needsTag!.repo,
                          tag: draft.needsTag!.tag,
                        })
                      }
                      disabled={createTagMutation.isPending}
                    >
                      {createTagMutation.isPending && (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      )}
                      Create tag
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}

            {hasErrors && (
              <Card className="border-amber-500/40 bg-amber-500/5">
                <CardContent className="space-y-1 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-amber-600">
                    <AlertCircle className="h-4 w-4" />
                    Validation problems
                  </div>
                  <ul className="ml-6 list-disc text-xs">
                    {draft.problems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {hasConflicts && (
              <Card className="border-destructive/40 bg-destructive/5">
                <CardContent className="space-y-2 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    Conflicting open PRs touch the same files
                  </div>
                  <ul className="space-y-1">
                    {draft.conflicts.map((c) => (
                      <li
                        key={c.prNumber}
                        className="flex items-center gap-2 text-xs"
                      >
                        <Badge variant="outline">#{c.prNumber}</Badge>
                        <span className="truncate">{c.title}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-6 px-2"
                          onClick={() => openUrl(c.url)}
                        >
                          <ExternalLink className="h-3 w-3" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {!hasErrors && !hasConflicts && !draft.needsTag && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Ready to submit. {draft.changes.length} file change(s),{" "}
                {draft.deletions.length} deletion(s).
              </div>
            )}

            {draft.companion && (
              <Card className="border-primary/30 bg-primary/5">
                <CardContent className="space-y-1 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium text-primary">
                    <GitBranch className="h-4 w-4" />
                    Companion PR will also be opened
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {draft.companion.prTitle} on{" "}
                    <code>{draft.companion.targetRepo}</code>
                  </div>
                </CardContent>
              </Card>
            )}

            <div>
              <div className="mb-2 text-sm font-medium">
                {draft.entries.length} file change(s)
              </div>
              <div className="space-y-2">
                {draft.entries.map((e, i) => (
                  <FileDiff key={`${e.path}-${i}`} entry={e} />
                ))}
              </div>
            </div>

            {draft.prBody && (
              <div>
                <div className="mb-1 text-sm font-medium">PR body</div>
                <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                  {draft.prBody}
                </pre>
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={() => submitMutation.mutate()}
            disabled={submitMutation.isPending || tagBlocked}
          >
            {submitMutation.isPending && (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            )}
            Open PR{draft.companion ? "s" : ""}
          </Button>
        </DialogFooter>
        {submitMutation.error && (
          <div className="text-xs text-destructive">
            {submitMutation.error instanceof Error
              ? submitMutation.error.message
              : String(submitMutation.error)}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

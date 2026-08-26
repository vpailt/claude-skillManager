// Per-file diff rendering for an `AdminDraft`, shared by the single-draft
// preview dialog and the Changes tab. Extracted so both show a change the same
// way — a diff that reads differently depending on where you opened it is a
// diff you end up double-checking.
import { useState } from "react";
import { ChevronDown, ChevronRight, Columns2, Pencil, Plus, Rows2, Trash } from "lucide-react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { Badge } from "@/components/ui/badge";
import { useUi } from "@/stores/ui";
import type { AdminDraft } from "@/lib/types";

export type DiffEntryView = AdminDraft["entries"][number];

function ActionIcon({ action }: { action: string }) {
  if (action === "add") return <Plus className="h-3 w-3 text-emerald-500" />;
  if (action === "delete") return <Trash className="h-3 w-3 text-destructive" />;
  return <Pencil className="h-3 w-3 text-amber-500" />;
}

export function FileDiff({
  entry,
  splitView,
  defaultOpen = true,
}: {
  entry: DiffEntryView;
  splitView: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
        <code className="font-mono text-xs">{entry.path}</code>
        <Badge variant="outline" className="ml-auto text-xs">
          {entry.action}
        </Badge>
      </button>
      {open && (
        <div className="max-h-[400px] overflow-auto">
          {entry.newContent === null && entry.oldContent === null ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              (entrée récapitulative — pas de diff en ligne)
            </div>
          ) : (
            <ReactDiffViewer
              oldValue={entry.oldContent ?? ""}
              newValue={entry.newContent ?? ""}
              splitView={splitView}
              leftTitle={splitView ? "Distant (actuel)" : undefined}
              rightTitle={splitView ? "Local (proposé)" : undefined}
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

/** Side-by-side vs unified switch. */
export function DiffViewToggle({
  splitView,
  onChange,
}: {
  splitView: boolean;
  onChange: (split: boolean) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border text-xs">
      <button
        type="button"
        onClick={() => onChange(true)}
        className={`flex items-center gap-1 px-2 py-1 transition-colors ${
          splitView
            ? "bg-primary text-primary-foreground"
            : "bg-background hover:bg-accent"
        }`}
        title="Côte à côte : distant (gauche) vs local (droite)"
      >
        <Columns2 className="h-3 w-3" />
        Côte à côte
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        className={`flex items-center gap-1 border-l px-2 py-1 transition-colors ${
          !splitView
            ? "bg-primary text-primary-foreground"
            : "bg-background hover:bg-accent"
        }`}
        title="Diff unifié en ligne"
      >
        <Rows2 className="h-3 w-3" />
        Unifié
      </button>
    </div>
  );
}

// Skill authoring dialog.
//
// What is left of the old admin wizards: the "Proposer une amélioration" tab
// they served is gone, and every PR on a plugin is now built from the Changes
// tab. Creating a skill inside a plugin still needs a dialog, so this one stays.
import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, FilePlus2, FolderInput, Loader2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useNotifications } from "@/stores/notifications";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { Plugin } from "@/lib/types";

function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <pre className="whitespace-pre-wrap">{msg}</pre>
    </div>
  );
}

// =====================================================================
// Add skill to a plugin (scaffold blank, or import an existing folder)
// =====================================================================

interface AddSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plugin: Plugin;
  /** Called with the created folder path once the skill exists on disk. */
  onCreated: (folder: string) => void;
}

export function AddSkillDialog({
  open,
  onOpenChange,
  plugin,
  onCreated,
}: AddSkillDialogProps) {
  const [mode, setMode] = useState<"blank" | "copy">("blank");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [sourceFolder, setSourceFolder] = useState("");
  const notify = useNotifications((s) => s.push);
  const qc = useQueryClient();

  const localSkills = useQuery({
    enabled: open && mode === "copy",
    queryKey: ["user-skills"],
    queryFn: api.adminListUserSkills,
  });

  useEffect(() => {
    if (!open) {
      setMode("blank");
      setName("");
      setDescription("");
      setBody("");
      setSourceFolder("");
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const basename = (p: string) =>
    p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

  const pickFolder = async () => {
    const sel = (await openDialog({
      directory: true,
      multiple: false,
      title: "Choisir un dossier de skill à importer",
    })) as string | null;
    if (sel) {
      setSourceFolder(sel);
      if (!name.trim()) setName(basename(sel));
    }
  };

  const create = useMutation({
    mutationFn: () =>
      api.addSkillToPlugin({
        plugin,
        mode,
        name: name.trim(),
        description: description.trim(),
        body,
        sourceFolder: mode === "copy" ? sourceFolder.trim() : undefined,
      }),
    onSuccess: (folder) => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
      notify({
        kind: "success",
        title: "Skill ajouté au plugin",
        body: `${name.trim()} — pensez à le pousser pour ouvrir une PR.`,
      });
      // Blank skills are empty scaffolds — open them so the user can edit.
      if (mode === "blank") api.openInVsCode(folder).catch(() => {});
      onCreated(folder);
      onOpenChange(false);
    },
  });

  const canSubmit =
    !!name.trim() &&
    (mode === "blank" || !!sourceFolder.trim()) &&
    !create.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onOpenChange(false);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Ajouter un skill à « {plugin.name} »</DialogTitle>
          <DialogDescription>
            Crée un skill dans le dossier local du plugin (sous{" "}
            <code>skills/&lt;nom&gt;/</code>). Il sera aussitôt détecté comme une
            modification à pousser.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="inline-flex overflow-hidden rounded-md border text-xs">
            <button
              type="button"
              onClick={() => setMode("blank")}
              className={`flex items-center gap-1 px-3 py-1.5 transition-colors ${
                mode === "blank"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent"
              }`}
            >
              <FilePlus2 className="h-3.5 w-3.5" />
              Créer vierge
            </button>
            <button
              type="button"
              onClick={() => setMode("copy")}
              className={`flex items-center gap-1 border-l px-3 py-1.5 transition-colors ${
                mode === "copy"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent"
              }`}
            >
              <FolderInput className="h-3.5 w-3.5" />
              Importer un dossier
            </button>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Nom du skill (dossier)
            </label>
            <Input
              placeholder="mon-skill"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          {mode === "blank" ? (
            <>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Description (frontmatter)
                </label>
                <Textarea
                  placeholder="À quoi sert ce skill / quand le déclencher."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Contenu du SKILL.md (optionnel)
                </label>
                <Textarea
                  placeholder="# Mon skill&#10;&#10;Instructions…"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                />
              </div>
            </>
          ) : (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Dossier source à copier
              </label>
              <div className="flex gap-2">
                <Input
                  placeholder="C:\Users\…\.claude\skills\mon-skill"
                  value={sourceFolder}
                  onChange={(e) => setSourceFolder(e.target.value)}
                />
                <Button variant="outline" onClick={pickFolder}>
                  Parcourir
                </Button>
              </div>
              {localSkills.data && localSkills.data.length > 0 && (
                <div className="mt-2 space-y-1">
                  <div className="text-xs text-muted-foreground">
                    Depuis <code>~/.claude/skills/</code> :
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {localSkills.data.map((s) => (
                      <Button
                        key={s.folder}
                        size="sm"
                        variant={
                          sourceFolder === s.folder ? "default" : "outline"
                        }
                        className="h-6 px-2 text-xs"
                        onClick={() => {
                          setSourceFolder(s.folder);
                          if (!name.trim()) setName(basename(s.folder));
                        }}
                      >
                        {s.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Le dossier doit contenir un <code>SKILL.md</code>. Il est copié tel
                quel (hors <code>.git</code>).
              </p>
            </div>
          )}

          <ErrorBox error={create.error} />
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Annuler</Button>
          </DialogClose>
          <Button onClick={() => create.mutate()} disabled={!canSubmit}>
            {create.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


import { useState, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Loader2,
  Trash,
  Upload,
  ArrowUpCircle,
  Plus,
  ExternalLink,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openExternal } from "@/lib/utils";
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
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import type { AdminDraft, LocalSkill, Plugin, UploadResult } from "@/lib/types";
import { useApp } from "@/stores/app";
import { DiffPreviewDialog } from "./DiffPreviewDialog";

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

function PRSubmittedToast({
  result,
  companion,
}: {
  result: UploadResult | null;
  companion?: UploadResult;
}) {
  if (!result) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm space-y-2 rounded-md border bg-card p-4 shadow-lg">
      <div className="text-sm font-medium">PR ouverte</div>
      <Button
        variant="ghost"
        size="sm"
        className="h-auto justify-start p-0 text-xs"
        onClick={() => openExternal(result.prUrl)}
      >
        <ExternalLink className="mr-1 h-3 w-3" />
        {result.prUrl}
      </Button>
      {companion && (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto justify-start p-0 text-xs"
          onClick={() => openExternal(companion.prUrl)}
        >
          <ExternalLink className="mr-1 h-3 w-3" />
          {companion.prUrl}
        </Button>
      )}
    </div>
  );
}

// =====================================================================
// Add plugin
// =====================================================================

interface AddPluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: string;
  onSubmitted: (r: UploadResult) => void;
}

export function AddPluginDialog({
  open,
  onOpenChange,
  marketplace,
  onSubmitted,
}: AddPluginDialogProps) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [draft, setDraft] = useState<AdminDraft | null>(null);

  useEffect(() => {
    if (!open) {
      setSourceUrl("");
      setDraft(null);
      prepare.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const prepare = useMutation({
    mutationFn: () => api.adminPrepareAddPlugin(marketplace, sourceUrl.trim()),
    onSuccess: (d) => setDraft(d),
  });

  return (
    <>
      <Dialog
        open={open && !draft}
        onOpenChange={(v) => {
          if (!v) onOpenChange(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ajouter un plugin à « {marketplace} »</DialogTitle>
            <DialogDescription>
              Colle l'URL Git du repo source du plugin (il doit contenir
              <code> manifest.json</code> à la racine). SkillManager y récupère le
              nom / la version / la description.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="https://github.com/owner/plugin-repo"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            autoFocus
          />
          <ErrorBox error={prepare.error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Annuler</Button>
            </DialogClose>
            <Button
              onClick={() => prepare.mutate()}
              disabled={!sourceUrl.trim() || prepare.isPending}
            >
              {prepare.isPending && (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              )}
              Continuer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DiffPreviewDialog
        open={open && !!draft}
        onOpenChange={(v) => {
          if (!v) {
            setDraft(null);
            onOpenChange(false);
          }
        }}
        draft={draft}
        onSubmitted={(r) => {
          setDraft(null);
          onSubmitted(r);
          onOpenChange(false);
        }}
      />
    </>
  );
}

// =====================================================================
// Bump plugin
// =====================================================================

interface BumpPluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: string;
  plugin: Plugin;
  onSubmitted: (r: UploadResult) => void;
}

export function BumpPluginDialog({
  open,
  onOpenChange,
  marketplace,
  plugin,
  onSubmitted,
}: BumpPluginDialogProps) {
  const [version, setVersion] = useState("");
  const [draft, setDraft] = useState<AdminDraft | null>(null);

  const suggestion = useQuery({
    enabled: open,
    queryKey: ["bump-suggest", plugin.latestVersion ?? plugin.installedVersion],
    queryFn: () =>
      api.adminSuggestBumps(
        plugin.latestVersion || plugin.installedVersion || "0.0.0"
      ),
  });

  useEffect(() => {
    if (!open) {
      setVersion("");
      setDraft(null);
      prepare.reset();
    } else if (suggestion.data && !version) {
      setVersion(suggestion.data.patch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, suggestion.data]);

  const prepare = useMutation({
    mutationFn: () =>
      api.adminPrepareBumpPlugin(marketplace, plugin.name, version.trim()),
    onSuccess: (d) => setDraft(d),
  });

  return (
    <>
      <Dialog
        open={open && !draft}
        onOpenChange={(v) => {
          if (!v) onOpenChange(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Incrémenter « {plugin.name} »</DialogTitle>
            <DialogDescription>
              Dernière version actuelle : {plugin.latestVersion || "—"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Nouvelle version (ex. 1.2.3)"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              autoFocus
            />
            {suggestion.data && (
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="text-muted-foreground">Choix rapides :</span>
                {(["patch", "minor", "major"] as const).map((k) => (
                  <Button
                    key={k}
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      suggestion.data && setVersion(suggestion.data[k])
                    }
                  >
                    {k} → {suggestion.data[k]}
                  </Button>
                ))}
              </div>
            )}
            <ErrorBox error={prepare.error} />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Annuler</Button>
            </DialogClose>
            <Button
              onClick={() => prepare.mutate()}
              disabled={!version.trim() || prepare.isPending}
            >
              {prepare.isPending && (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              )}
              Continuer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DiffPreviewDialog
        open={open && !!draft}
        onOpenChange={(v) => {
          if (!v) {
            setDraft(null);
            onOpenChange(false);
          }
        }}
        draft={draft}
        onSubmitted={(r) => {
          setDraft(null);
          onSubmitted(r);
          onOpenChange(false);
        }}
      />
    </>
  );
}

// =====================================================================
// Remove plugin
// =====================================================================

interface RemovePluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: string;
  plugin: Plugin;
  onSubmitted: (r: UploadResult) => void;
}

export function RemovePluginDialog({
  open,
  onOpenChange,
  marketplace,
  plugin,
  onSubmitted,
}: RemovePluginDialogProps) {
  const [draft, setDraft] = useState<AdminDraft | null>(null);

  const prepare = useMutation({
    mutationFn: () => api.adminPrepareRemovePlugin(marketplace, plugin.name),
    onSuccess: (d) => setDraft(d),
  });

  useEffect(() => {
    if (open && !draft && !prepare.isPending && !prepare.isError) {
      prepare.mutate();
    }
    if (!open) {
      setDraft(null);
      prepare.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (prepare.isPending && !draft) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Préparation du retrait de « {plugin.name} »…</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Récupération du registre
            de la marketplace…
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (prepare.isError && !draft) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Retirer « {plugin.name} »</DialogTitle>
          </DialogHeader>
          <ErrorBox error={prepare.error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Fermer</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <DiffPreviewDialog
      open={open && !!draft}
      onOpenChange={(v) => {
        if (!v) {
          setDraft(null);
          onOpenChange(false);
        }
      }}
      draft={draft}
      onSubmitted={(r) => {
        setDraft(null);
        onSubmitted(r);
        onOpenChange(false);
      }}
    />
  );
}

// =====================================================================
// Upload skill
// =====================================================================

interface UploadSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: string;
  plugin: Plugin;
  /** When opening from the "Upgrade" affordance on a remote-skill row. */
  initialTargetName?: string;
  initialLocalFolder?: string;
  onSubmitted: (r: UploadResult, companion?: UploadResult) => void;
}

export function UploadSkillDialog({
  open,
  onOpenChange,
  marketplace,
  plugin,
  initialTargetName,
  initialLocalFolder,
  onSubmitted,
}: UploadSkillDialogProps) {
  const [localFolder, setLocalFolder] = useState(initialLocalFolder ?? "");
  const [targetName, setTargetName] = useState(initialTargetName ?? "");
  const [newVersion, setNewVersion] = useState("");
  const [pluginBumpLevel, setPluginBumpLevel] = useState<
    "patch" | "minor" | "major"
  >("patch");
  const [alsoBump, setAlsoBump] = useState(true);
  const [draft, setDraft] = useState<AdminDraft | null>(null);

  const localSkills = useQuery({
    enabled: open,
    queryKey: ["user-skills"],
    queryFn: api.adminListUserSkills,
  });

  useEffect(() => {
    if (!open) {
      setDraft(null);
      prepare.reset();
      setLocalFolder(initialLocalFolder ?? "");
      setTargetName(initialTargetName ?? "");
      setNewVersion("");
      setPluginBumpLevel("patch");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const prepare = useMutation({
    mutationFn: () =>
      api.adminPrepareUploadSkill({
        marketplace,
        pluginName: plugin.name,
        localFolder: localFolder.trim(),
        targetName: targetName.trim() || undefined,
        newVersion: newVersion.trim() || undefined,
        pluginBumpLevel,
        alsoBumpMarketplace: alsoBump,
      }),
    onSuccess: (d) => setDraft(d),
  });

  const pickFolder = async () => {
    const sel = (await openDialog({
      directory: true,
      multiple: false,
      title: "Choisir un dossier de skill local",
    })) as string | null;
    if (sel) {
      setLocalFolder(sel);
      // Default target name to the picked folder's basename.
      const last = sel.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
      if (!targetName) setTargetName(last);
    }
  };

  const pickFromList = (s: LocalSkill) => {
    setLocalFolder(s.folder);
    if (!targetName) setTargetName(s.name);
    if (!newVersion && s.version) setNewVersion(s.version);
  };

  return (
    <>
      <Dialog
        open={open && !draft}
        onOpenChange={(v) => {
          if (!v) onOpenChange(false);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Téléverser un skill vers « {plugin.name} »</DialogTitle>
            <DialogDescription>
              Choisis un dossier sous <code>~/.claude/skills/</code>, ou n'importe
              quel dossier local. Le frontmatter du SKILL.md est validé avant
              l'ouverture de la PR.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Dossier local
              </label>
              <div className="flex gap-2">
                <Input
                  placeholder="C:\Users\…\.claude\skills\my-skill"
                  value={localFolder}
                  onChange={(e) => setLocalFolder(e.target.value)}
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
                          localFolder === s.folder ? "default" : "outline"
                        }
                        className="h-6 px-2 text-xs"
                        onClick={() => pickFromList(s)}
                      >
                        {s.name}
                        {s.version && (
                          <Badge variant="outline" className="ml-1 text-[9px]">
                            v{s.version}
                          </Badge>
                        )}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Nom du skill dans le repo
                </label>
                <Input
                  placeholder="(par défaut le nom du dossier)"
                  value={targetName}
                  onChange={(e) => setTargetName(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Version du skill (optionnel)
                </label>
                <Input
                  placeholder="ex. 1.7.6"
                  value={newVersion}
                  onChange={(e) => setNewVersion(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Incrément de version du plugin
              </label>
              <div className="flex gap-1">
                {(["patch", "minor", "major"] as const).map((lvl) => (
                  <Button
                    key={lvl}
                    type="button"
                    size="sm"
                    variant={pluginBumpLevel === lvl ? "default" : "outline"}
                    className="h-7 flex-1 text-xs"
                    onClick={() => setPluginBumpLevel(lvl)}
                  >
                    {lvl}
                  </Button>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                La version du plugin est toujours incrémentée lors du
                téléversement d'un skill — choisis comment. Indépendant de la
                version du skill ci-dessus.
              </p>
            </div>

            <label className="flex cursor-pointer items-center gap-2">
              <Switch checked={alsoBump} onCheckedChange={setAlsoBump} />
              <span>
                Ouvrir aussi une PR compagnon incrémentant{" "}
                <code className="text-xs">{plugin.name}</code> dans le registre
                de la marketplace
              </span>
            </label>

            <ErrorBox error={prepare.error} />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Annuler</Button>
            </DialogClose>
            <Button
              onClick={() => prepare.mutate()}
              disabled={!localFolder.trim() || prepare.isPending}
            >
              {prepare.isPending && (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              )}
              Continuer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DiffPreviewDialog
        open={open && !!draft}
        onOpenChange={(v) => {
          if (!v) {
            setDraft(null);
            onOpenChange(false);
          }
        }}
        draft={draft}
        onSubmitted={(r, c) => {
          setDraft(null);
          onSubmitted(r, c);
          onOpenChange(false);
        }}
      />
    </>
  );
}

// =====================================================================
// Delete skill
// =====================================================================

interface DeleteSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: string;
  plugin: Plugin;
  skillName: string;
  onSubmitted: (r: UploadResult) => void;
}

export function DeleteSkillDialog({
  open,
  onOpenChange,
  marketplace,
  plugin,
  skillName,
  onSubmitted,
}: DeleteSkillDialogProps) {
  const [draft, setDraft] = useState<AdminDraft | null>(null);

  const prepare = useMutation({
    mutationFn: () =>
      api.adminPrepareDeleteSkill(marketplace, plugin.name, skillName),
    onSuccess: (d) => setDraft(d),
  });

  useEffect(() => {
    if (open && !draft && !prepare.isPending && !prepare.isError) {
      prepare.mutate();
    }
    if (!open) {
      setDraft(null);
      prepare.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (prepare.isPending && !draft) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Préparation de la suppression de « {skillName} »…</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Listage des fichiers distants…
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (prepare.isError && !draft) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer le skill « {skillName} »</DialogTitle>
          </DialogHeader>
          <ErrorBox error={prepare.error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Fermer</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <DiffPreviewDialog
      open={open && !!draft}
      onOpenChange={(v) => {
        if (!v) {
          setDraft(null);
          onOpenChange(false);
        }
      }}
      draft={draft}
      onSubmitted={(r) => {
        setDraft(null);
        onSubmitted(r);
        onOpenChange(false);
      }}
    />
  );
}

// =====================================================================
// Wizard host (used by Admin tab)
// =====================================================================

export type WizardKind =
  | { kind: "addPlugin"; marketplace: string }
  | { kind: "bumpPlugin"; marketplace: string; plugin: Plugin }
  | { kind: "removePlugin"; marketplace: string; plugin: Plugin }
  | {
      kind: "uploadSkill";
      marketplace: string;
      plugin: Plugin;
      initialTargetName?: string;
      initialLocalFolder?: string;
    }
  | {
      kind: "deleteSkill";
      marketplace: string;
      plugin: Plugin;
      skillName: string;
    };

interface WizardHostProps {
  active: WizardKind | null;
  onClose: () => void;
}

export function WizardHost({ active, onClose }: WizardHostProps) {
  const qc = useQueryClient();
  const [toast, setToast] = useState<{
    main: UploadResult;
    companion?: UploadResult;
  } | null>(null);

  const handleSubmit = (r: UploadResult, companion?: UploadResult) => {
    setToast({ main: r, companion });
    qc.invalidateQueries({ queryKey: ["pr-history"] });
    qc.invalidateQueries({ queryKey: ["pending-prs"] });
    qc.invalidateQueries({ queryKey: ["refresh"] });
    setTimeout(() => setToast(null), 8000);
  };

  if (!active) return <PRSubmittedToast result={toast?.main ?? null} companion={toast?.companion} />;

  return (
    <>
      {active.kind === "addPlugin" && (
        <AddPluginDialog
          open
          onOpenChange={(v) => !v && onClose()}
          marketplace={active.marketplace}
          onSubmitted={handleSubmit}
        />
      )}
      {active.kind === "bumpPlugin" && (
        <BumpPluginDialog
          open
          onOpenChange={(v) => !v && onClose()}
          marketplace={active.marketplace}
          plugin={active.plugin}
          onSubmitted={handleSubmit}
        />
      )}
      {active.kind === "removePlugin" && (
        <RemovePluginDialog
          open
          onOpenChange={(v) => !v && onClose()}
          marketplace={active.marketplace}
          plugin={active.plugin}
          onSubmitted={handleSubmit}
        />
      )}
      {active.kind === "uploadSkill" && (
        <UploadSkillDialog
          open
          onOpenChange={(v) => !v && onClose()}
          marketplace={active.marketplace}
          plugin={active.plugin}
          initialTargetName={active.initialTargetName}
          initialLocalFolder={active.initialLocalFolder}
          onSubmitted={handleSubmit}
        />
      )}
      {active.kind === "deleteSkill" && (
        <DeleteSkillDialog
          open
          onOpenChange={(v) => !v && onClose()}
          marketplace={active.marketplace}
          plugin={active.plugin}
          skillName={active.skillName}
          onSubmitted={handleSubmit}
        />
      )}
      <PRSubmittedToast result={toast?.main ?? null} companion={toast?.companion} />
    </>
  );
}

// =====================================================================
// Editable-marketplace selector + plugin picker — reused by AdminPage
// =====================================================================

export function useEditableMarketplaces() {
  const marketplaces = useApp((s) => s.marketplaces);
  return useMemo(
    () => marketplaces.filter((m) => m.editable && m.sourceRepo),
    [marketplaces]
  );
}

export function PluginActionsRow({
  marketplace,
  plugin,
  onLaunch,
}: {
  marketplace: string;
  plugin: Plugin;
  onLaunch: (w: WizardKind) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      <Button
        size="sm"
        variant="ghost"
        onClick={() =>
          onLaunch({ kind: "uploadSkill", marketplace, plugin })
        }
        title="Téléverser un dossier de skill vers ce plugin"
      >
        <Upload className="mr-1 h-3 w-3" />
        Téléverser un skill
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onLaunch({ kind: "bumpPlugin", marketplace, plugin })}
      >
        <ArrowUpCircle className="mr-1 h-3 w-3" />
        Incrémenter
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onLaunch({ kind: "removePlugin", marketplace, plugin })}
        className="text-destructive"
      >
        <Trash className="mr-1 h-3 w-3" />
        Retirer de la marketplace
      </Button>
    </div>
  );
}

export function AddPluginButton({
  marketplace,
  onLaunch,
}: {
  marketplace: string;
  onLaunch: (w: WizardKind) => void;
}) {
  return (
    <Button
      size="sm"
      onClick={() => onLaunch({ kind: "addPlugin", marketplace })}
    >
      <Plus className="mr-1 h-3 w-3" />
      Ajouter un plugin
    </Button>
  );
}

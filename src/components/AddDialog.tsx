// Parcours d'ajout unifié — un plugin ou un skill, d'où qu'il vienne.
//
// Deux étapes, qui sont celles du backend (`add_flow.rs`) :
//
//  1. « Provenance » — un dépôt distant (la forge se déduit de l'URL collée,
//     jamais d'un sélecteur, comme pour l'ajout d'une marketplace) ou une source
//     locale (sélection de dossier *ou* glisser-déposer : les deux aboutissent
//     au même appel, `addStageSource` en mode `local`).
//  2. « Métadonnées » — ce que la source porte déjà, pré-rempli et éditable,
//     plus la destination. La complétion est proposée, l'ajout n'est pas refusé.
//
// Le glisser-déposer passe par `onDragDropEvent` de Tauri et non par les
// événements HTML5 : la webview intercepte le drop au niveau de l'OS
// (`dragDropEnabled`), donc un handler `onDrop` React ne reçoit jamais de
// chemin. Le dialogue étant modal, tout drop qui survient pendant qu'il est
// ouvert lui revient — il n'y a rien d'autre à viser.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  FilePlus2,
  FolderInput,
  FolderOpen,
  GitBranch,
  Loader2,
  Package,
  Sparkles,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
import { ScrollFade } from "@/components/ScrollFade";
import { api } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useNotifications } from "@/stores/notifications";
import { withTask } from "@/stores/progress";
import { forceRefresh } from "@/hooks/useRefresh";
import type {
  AddInspection,
  AddKind,
  AddTarget,
  Marketplace,
  Plugin,
} from "@/lib/types";

const log = createLogger("add-flow");

/** Destination imposée par l'appelant (menu « … » d'une marketplace ou d'un
 *  plugin). Absente, le dialogue la fait choisir. */
export interface AddDialogTarget {
  marketplace?: string;
  plugin?: string;
  installPath?: string;
}

interface AddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: AddKind;
  /** L'arborescence courante : sert à proposer les destinations possibles. */
  marketplaces: Marketplace[];
  preset?: AddDialogTarget;
}

type Origin = "remote" | "local" | "blank";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Les plugins installés qui ont un dossier local — seuls ceux-là peuvent
 *  recevoir un skill. Les droits de push ne gouvernent que la publication. */
function installedPlugins(marketplaces: Marketplace[]) {
  const out: { marketplace: string; plugin: Plugin }[] = [];
  for (const mp of marketplaces) {
    // « Sans plugin » n'est pas un plugin : le proposer ici doublerait l'option
    // « Sans plugin (~/.claude/skills/) » et poserait le skill sous un
    // `skills/skills/` qui n'existe pas.
    if (mp.sourceKind === "local") continue;
    for (const p of mp.plugins) {
      if (p.installPath) out.push({ marketplace: mp.name, plugin: p });
    }
  }
  return out;
}

export function AddDialog({
  open,
  onOpenChange,
  kind,
  marketplaces,
  preset,
}: AddDialogProps) {
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);

  const [origin, setOrigin] = useState<Origin>("remote");
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [blankName, setBlankName] = useState("");
  const [blankBody, setBlankBody] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [inspection, setInspection] = useState<AddInspection | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [destMarketplace, setDestMarketplace] = useState("");
  const [destPlugin, setDestPlugin] = useState("");
  const [error, setError] = useState("");
  // La préparation vit sur le disque : elle doit être effacée si le dialogue se
  // ferme sans valider. Une ref, pour que le nettoyage au démontage voie la
  // dernière valeur et non celle capturée à l'ouverture.
  const stagingRef = useRef<string>("");

  const plugins = useMemo(() => installedPlugins(marketplaces), [marketplaces]);
  const installedMarketplaces = useMemo(
    // `sourceKind: "local"` est le pseudo-marketplace des skills sans plugin :
    // il n'a pas de cache à soi, donc rien à y installer.
    () => marketplaces.filter((m) => m.installed && m.sourceKind !== "local"),
    [marketplaces]
  );

  const reset = useCallback(() => {
    setOrigin("remote");
    setUrl("");
    setFolder("");
    setBlankName("");
    setBlankBody("");
    setDragOver(false);
    setInspection(null);
    setValues({});
    setError("");
    stagingRef.current = "";
  }, []);

  // Sélection préréglée par l'appelant (Lot 5) ou premier choix disponible.
  useEffect(() => {
    if (!open) return;
    setDestMarketplace(preset?.marketplace ?? "");
    setDestPlugin(preset?.plugin ?? "");
  }, [open, preset?.marketplace, preset?.plugin]);

  const discardStaging = useCallback(() => {
    const dir = stagingRef.current;
    if (!dir) return;
    stagingRef.current = "";
    api.addDiscard(dir).catch((e) => log.warn("addDiscard", errorText(e)));
  }, []);

  const close = useCallback(() => {
    discardStaging();
    reset();
    onOpenChange(false);
  }, [discardStaging, reset, onOpenChange]);

  const stage = useMutation({
    mutationFn: async (args: {
      origin: Origin;
      path?: string;
      url?: string;
      name?: string;
      body?: string;
    }) => {
      // Une source déjà préparée est abandonnée : on n'en garde jamais deux.
      discardStaging();
      return withTask(
        {
          kind: "install",
          label: kind === "plugin" ? "Analyse du plugin" : "Analyse du skill",
          detail: args.url || args.path || args.name || "",
        },
        () =>
          api.addStageSource({
            kind,
            origin: args.origin,
            path: args.path ?? "",
            url: args.url ?? "",
            name: args.name ?? "",
            body: args.body ?? "",
          })
      );
    },
    onSuccess: (data) => {
      stagingRef.current = data.stagingDir;
      setInspection(data);
      setValues(Object.fromEntries(data.fields.map((f) => [f.key, f.value])));
      setError("");
    },
    onError: (e) => setError(errorText(e)),
  });

  const commit = useMutation({
    mutationFn: async () => {
      if (!inspection) throw new Error("Analysez d'abord une source.");
      const target = buildTarget();
      const outcome = await withTask(
        {
          kind: "install",
          label: kind === "plugin" ? "Ajout du plugin" : "Ajout du skill",
          detail: values.name ?? inspection.suggestedName,
        },
        () =>
          api.addCommit({
            kind,
            stagingDir: inspection.stagingDir,
            fields: values,
            target,
          })
      );
      stagingRef.current = "";
      return outcome;
    },
    onSuccess: (outcome) => {
      notify({
        kind: "success",
        title: kind === "plugin" ? "Plugin ajouté" : "Skill ajouté",
        body: outcome.path,
      });
      // L'état d'installation sur le disque vient de changer : `local` est le
      // mode fait pour ça — pas de réutilisation d'un balayage antérieur à cet
      // ajout, et pas les sondes de manifeste qui figent l'arbre.
      forceRefresh(qc, "local");
      reset();
      onOpenChange(false);
    },
    onError: (e) => setError(errorText(e)),
  });

  const buildTarget = (): AddTarget => {
    if (kind === "plugin") {
      if (!destMarketplace) {
        throw new Error("Choisissez la marketplace de destination.");
      }
      return { kind: "marketplace", marketplace: destMarketplace };
    }
    if (!destPlugin) return { kind: "userSkills" };
    const found = plugins.find(
      (p) => `${p.marketplace}/${p.plugin.name}` === destPlugin
    );
    if (!found?.plugin.installPath) {
      throw new Error("Ce plugin n'a pas de dossier local.");
    }
    return {
      kind: "plugin",
      marketplace: found.marketplace,
      plugin: found.plugin.name,
      installPath: found.plugin.installPath,
    };
  };

  const pickFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setFolder(picked);
      stage.mutate({ origin: "local", path: picked });
    }
  };

  // Glisser-déposer : même chemin de code que la sélection de dossier.
  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setDragOver(true);
          return;
        }
        if (event.payload.type === "leave") {
          setDragOver(false);
          return;
        }
        setDragOver(false);
        const path = event.payload.paths?.[0];
        if (!path) return;
        setOrigin("local");
        setFolder(path);
        stage.mutate({ origin: "local", path });
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => log.warn("onDragDropEvent", errorText(e)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // `stage` est stable pour la durée du dialogue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind]);

  // Une préparation abandonnée ne doit pas survivre au démontage.
  useEffect(() => () => discardStaging(), [discardStaging]);

  const missing = (inspection?.fields ?? []).filter(
    (f) => f.required && !(values[f.key] ?? "").trim()
  );
  const destinationMissing =
    kind === "plugin" ? !destMarketplace : false;
  const canSubmit =
    !!inspection && missing.length === 0 && !destinationMissing && !commit.isPending;

  const title =
    kind === "plugin" ? "Ajouter un plugin" : "Ajouter un skill";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {kind === "plugin" ? (
              <Package className="h-4 w-4" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription>
            Depuis un dépôt Git (GitHub ou Gitea) ou depuis un dossier de cette
            machine — sélectionné ou déposé sur cette fenêtre.
          </DialogDescription>
        </DialogHeader>

        <ScrollFade className="max-h-[60vh] pr-1">
          <div className="space-y-4 text-sm">
            <div className="inline-flex overflow-hidden rounded-md border text-xs">
              <button
                type="button"
                onClick={() => setOrigin("remote")}
                className={`flex items-center gap-1 px-3 py-1.5 transition-colors ${
                  origin === "remote"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-accent"
                }`}
              >
                <GitBranch className="h-3.5 w-3.5" />
                Depuis un dépôt
              </button>
              <button
                type="button"
                onClick={() => setOrigin("local")}
                className={`flex items-center gap-1 border-l px-3 py-1.5 transition-colors ${
                  origin === "local"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-accent"
                }`}
              >
                <FolderInput className="h-3.5 w-3.5" />
                Depuis un dossier
              </button>
              <button
                type="button"
                onClick={() => setOrigin("blank")}
                className={`flex items-center gap-1 border-l px-3 py-1.5 transition-colors ${
                  origin === "blank"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background hover:bg-accent"
                }`}
              >
                <FilePlus2 className="h-3.5 w-3.5" />
                Créer vierge
              </button>
            </div>

            {origin === "blank" ? (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Nom {kind === "plugin" ? "du plugin" : "du skill"}
                  </label>
                  <div className="flex gap-2">
                    <Input
                      placeholder={kind === "plugin" ? "mon-plugin" : "mon-skill"}
                      value={blankName}
                      onChange={(e) => setBlankName(e.target.value)}
                      autoFocus
                    />
                    <Button
                      variant="outline"
                      disabled={!blankName.trim() || stage.isPending}
                      onClick={() =>
                        stage.mutate({
                          origin: "blank",
                          name: blankName.trim(),
                          body: blankBody,
                        })
                      }
                    >
                      {stage.isPending && (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      )}
                      Créer
                    </Button>
                  </div>
                </div>
                {kind === "skill" && (
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">
                      Contenu du SKILL.md (facultatif)
                    </label>
                    <Textarea
                      rows={4}
                      placeholder={"# Mon skill\n\nInstructions…"}
                      value={blankBody}
                      onChange={(e) => setBlankBody(e.target.value)}
                    />
                  </div>
                )}
              </div>
            ) : origin === "remote" ? (
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  URL du dépôt
                </label>
                <div className="flex gap-2">
                  <Input
                    placeholder="https://github.com/owner/repo (ou .../tree/main/skills/mon-skill)"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && url.trim()) {
                        stage.mutate({ origin: "remote", url: url.trim() });
                      }
                    }}
                    autoFocus
                  />
                  <Button
                    variant="outline"
                    disabled={!url.trim() || stage.isPending}
                    onClick={() => stage.mutate({ origin: "remote", url: url.trim() })}
                  >
                    {stage.isPending && (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    )}
                    Analyser
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  La forge est déduite de l'URL. Un hôte qui n'est ni github.com
                  ni une instance Gitea enregistrée est refusé.
                </p>
              </div>
            ) : (
              <div
                className={`rounded-md border border-dashed p-4 transition-colors ${
                  dragOver ? "border-primary bg-primary/5" : "border-input"
                }`}
              >
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <Input
                    placeholder="C:\\Users\\…\\mon-skill"
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                  />
                  <Button variant="outline" onClick={pickFolder}>
                    Parcourir
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!folder.trim() || stage.isPending}
                    onClick={() =>
                      stage.mutate({ origin: "local", path: folder.trim() })
                    }
                  >
                    {stage.isPending && (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    )}
                    Analyser
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Ou déposez le dossier sur cette fenêtre. Il est copié, jamais
                  déplacé ni modifié.
                </p>
              </div>
            )}

            {inspection && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="text-xs text-muted-foreground">
                  Source : <code>{inspection.sourceLabel}</code> —{" "}
                  {inspection.fileCount} fichier
                  {inspection.fileCount > 1 ? "s" : ""}
                </div>

                {inspection.problems.length > 0 && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-600 dark:text-amber-400">
                    <div className="mb-1 font-medium">
                      Métadonnées à compléter
                    </div>
                    <ul className="list-inside list-disc space-y-0.5">
                      {inspection.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                    <div className="mt-1.5 opacity-80">
                      Les valeurs ci-dessous seront écrites dans{" "}
                      <code>
                        {kind === "plugin" ? "manifest.json" : "SKILL.md"}
                      </code>{" "}
                      à la validation — dans la copie ajoutée, jamais dans la
                      source.
                    </div>
                  </div>
                )}

                {inspection.fields.map((f) => {
                  // Un champ requis vide n'est pas une erreur de l'utilisateur :
                  // c'est ce que la source ne portait pas, et ce que ce
                  // formulaire est là pour lui faire écrire.
                  const empty = !(values[f.key] ?? "").trim();
                  const blocking = f.required && empty;
                  return (
                    <div key={f.key}>
                      <label className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{f.label}</span>
                        {f.required ? (
                          <span className="text-destructive">requis</span>
                        ) : (
                          <span className="opacity-70">suggéré</span>
                        )}
                      </label>
                      {f.multiline ? (
                        <Textarea
                          rows={2}
                          className={blocking ? "border-destructive/60" : undefined}
                          value={values[f.key] ?? ""}
                          onChange={(e) =>
                            setValues((v) => ({ ...v, [f.key]: e.target.value }))
                          }
                        />
                      ) : (
                        <Input
                          className={blocking ? "border-destructive/60" : undefined}
                          value={values[f.key] ?? ""}
                          onChange={(e) =>
                            setValues((v) => ({ ...v, [f.key]: e.target.value }))
                          }
                        />
                      )}
                    </div>
                  );
                })}

                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Destination
                  </label>
                  {kind === "plugin" ? (
                    <select
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={destMarketplace}
                      onChange={(e) => setDestMarketplace(e.target.value)}
                      disabled={!!preset?.marketplace}
                    >
                      <option value="">— choisir une marketplace —</option>
                      {installedMarketplaces.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={destPlugin}
                      onChange={(e) => setDestPlugin(e.target.value)}
                      disabled={!!preset?.plugin}
                    >
                      <option value="">
                        Sans plugin (~/.claude/skills/)
                      </option>
                      {plugins.map(({ marketplace, plugin }) => (
                        <option
                          key={`${marketplace}/${plugin.name}`}
                          value={`${marketplace}/${plugin.name}`}
                        >
                          {plugin.name} · {marketplace}
                        </option>
                      ))}
                    </select>
                  )}
                  {kind === "plugin" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Un plugin appartient toujours à une marketplace : c'est ce
                      qui le rend chargeable par Claude Code.
                    </p>
                  )}
                </div>
              </div>
            )}

            {error && (
              <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <pre className="whitespace-pre-wrap">{error}</pre>
              </div>
            )}
          </div>
        </ScrollFade>

        <DialogFooter className="items-center gap-2">
          {/* Un bouton grisé sans raison est une impasse : dire ce qui manque. */}
          {inspection && !canSubmit && !commit.isPending && (
            <span className="mr-auto text-xs text-muted-foreground">
              {missing.length > 0
                ? `À compléter : ${missing.map((f) => f.label).join(", ")}`
                : "Choisissez la marketplace de destination."}
            </span>
          )}
          <DialogClose asChild>
            <Button variant="outline">Annuler</Button>
          </DialogClose>
          <Button onClick={() => commit.mutate()} disabled={!canSubmit}>
            {commit.isPending && (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            )}
            Ajouter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

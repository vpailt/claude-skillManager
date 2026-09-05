// Bulk action bar for the Skills tree.
//
// Appears as soon as something is ticked, and only ever offers actions that
// apply to the current selection — a marketplace, a plugin and a skill have
// nothing in common, so the bar derives what is possible instead of showing a
// fixed row of half-disabled buttons.
//
// Execution goes through `useBulkRunner` (sequential, failure-tolerant, one
// invalidation at the end); this component only builds the operation list.
import { useMemo, useState } from "react";
import {
  Archive,
  Code2,
  Download,
  Loader2,
  Power,
  PowerOff,
  RefreshCw,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { installMarketplaceOnce } from "@/hooks/useInstallMarketplace";
import { useBulkRunner, type BulkOp } from "@/hooks/useBulkRunner";
import { useApp } from "@/stores/app";
import { isActionable, useSkillSync } from "@/stores/skillSync";
import { mpKey, plKey, skKey, useTreeSelection } from "@/stores/treeSelection";
import type { Marketplace, Plugin, Skill } from "@/lib/types";

interface ResolvedSkill {
  skill: Skill;
  plugin: Plugin;
  marketplace: Marketplace;
  folder: string;
}

interface Resolved {
  marketplaces: Marketplace[];
  plugins: { plugin: Plugin; marketplace: Marketplace }[];
  skills: ResolvedSkill[];
}

function isInstalled(p: Plugin) {
  return (
    p.installState === "installed" ||
    p.installState === "outdated" ||
    p.installState === "local_only"
  );
}

interface Props {
  /** Hand the selected skill folders to the Changes tab. */
  onPublishSkills: (folders: string[]) => void;
}

export function BulkActionBar({ onPublishSkills }: Props) {
  const selected = useTreeSelection((s) => s.selected);
  const setSyncOne = useSkillSync((s) => s.setOne);
  const clear = useTreeSelection((s) => s.clear);
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  // Each op patches the tree as it succeeds, so a long batch shows its progress
  // instead of standing still until the closing sweep lands.
  const markInstalled = useApp((s) => s.markPluginInstalled);
  const markUninstalled = useApp((s) => s.markPluginUninstalled);
  const markEnabled = useApp((s) => s.markPluginEnabled);
  const syncMap = useSkillSync((s) => s.status);
  const [confirm, setConfirm] = useState<null | "uninstall" | "delete">(null);

  const runner = useBulkRunner({
    invalidate: [
      ["refresh"],
      ["app-settings"],
      // A delete resolves a duplicate and strands the per-folder caches, so the
      // batch clears those too rather than leaving phantom rows behind.
      ["duplicate-skills"],
      ["archived-skills"],
      ["skill-files"],
      ["skill-mtime"],
    ],
    summaryTitle: "Actions groupées",
  });

  // Walk the tree rather than parsing the keys: a marketplace name could
  // contain the separator, and the objects are needed anyway.
  const resolved = useMemo<Resolved>(() => {
    const out: Resolved = { marketplaces: [], plugins: [], skills: [] };
    const all = localOnly ? [localOnly, ...marketplaces] : marketplaces;
    for (const m of all) {
      if (selected.has(mpKey(m.name))) out.marketplaces.push(m);
      for (const p of m.plugins) {
        if (selected.has(plKey(m.name, p.name)))
          out.plugins.push({ plugin: p, marketplace: m });
        for (const s of p.skills) {
          const folder = s.folder ?? s.watchFolder;
          if (folder && selected.has(skKey(folder)))
            out.skills.push({ skill: s, plugin: p, marketplace: m, folder });
        }
      }
    }
    return out;
  }, [selected, marketplaces, localOnly]);

  const { marketplaces: selMps, plugins: selPlugins, skills: selSkills } = resolved;

  const toInstallMp = selMps.filter((m) => !m.installed && m.sourceRepo);
  const toInstall = selPlugins.filter(
    ({ plugin }) => plugin.installState === "not_installed"
  );
  const toUpdate = selPlugins.filter(
    ({ plugin }) => plugin.installState === "outdated"
  );
  const toEnable = selPlugins.filter(
    ({ plugin }) => isInstalled(plugin) && !plugin.enabled
  );
  const toDisable = selPlugins.filter(
    ({ plugin }) => isInstalled(plugin) && plugin.enabled
  );
  const toUninstall = selPlugins.filter(({ plugin }) => isInstalled(plugin));
  const uninstallableMps = selMps.filter((m) => m.installed);

  const toPublish = selSkills.filter(
    (s) =>
      s.marketplace.editable &&
      s.marketplace.sourceRepo &&
      isActionable(syncMap[s.folder] ?? "unknown")
  );
  const toOpen = selSkills.filter((s) => !!s.skill.folder);
  const toArchive = selSkills.filter(
    (s) => !!localOnly && s.marketplace.name === localOnly.name && !!s.skill.folder
  );
  // Only folders still on disk: a skill already deleted stays selectable (its
  // row is rebuilt from the remote listing), and deleting it twice is nonsense.
  const toDelete = selSkills.filter((s) => !!s.skill.folder);
  const deleteLocalCount = toDelete.filter(
    (s) => !!localOnly && s.marketplace.name === localOnly.name
  ).length;
  const deletePluginCount = toDelete.length - deleteLocalCount;

  const total = selected.size;

  const runOps = (ops: BulkOp[]) => {
    void runner.run(ops).then(() => clear());
  };

  const installOps = (): BulkOp[] => [
    ...toInstallMp.map((m) => ({
      id: mpKey(m.name),
      label: `Marketplace ${m.name}`,
      run: () => installMarketplaceOnce(m),
    })),
    ...toInstall.map(({ plugin, marketplace }) => ({
      id: plKey(marketplace.name, plugin.name),
      label: plugin.name,
      run: async () => {
        // Claude Code only surfaces a plugin cleanly when its marketplace index
        // is installed too — mirrors the single-plugin path in Skills.tsx.
        if (!marketplace.installed && marketplace.sourceRepo) {
          await installMarketplaceOnce(marketplace);
        }
        const path = await api.installPlugin(plugin);
        markInstalled(plugin);
        return path;
      },
    })),
  ];

  const updateOps = (): BulkOp[] =>
    toUpdate.map(({ plugin, marketplace }) => ({
      id: plKey(marketplace.name, plugin.name),
      label: `${plugin.name} → ${plugin.latestVersion ?? "?"}`,
      run: async () => {
        const path = await api.installPlugin(plugin);
        markInstalled(plugin);
        return path;
      },
    }));

  const enableOps = (value: boolean): BulkOp[] =>
    (value ? toEnable : toDisable).map(({ plugin, marketplace }) => ({
      id: plKey(marketplace.name, plugin.name),
      label: plugin.name,
      run: async () => {
        await api.setPluginEnabled(plugin.name, marketplace.name, value);
        markEnabled(marketplace.name, plugin.name, value);
      },
    }));

  const uninstallOps = (): BulkOp[] => [
    ...toUninstall.map(({ plugin, marketplace }) => ({
      id: plKey(marketplace.name, plugin.name),
      label: plugin.name,
      run: async () => {
        await api.uninstallPlugin(plugin);
        markUninstalled(plugin);
      },
    })),
    ...uninstallableMps.map((m) => ({
      id: mpKey(m.name),
      label: `Marketplace ${m.name}`,
      run: () => api.uninstallMarketplaceCascade(m.name),
    })),
  ];

  const openOps = (): BulkOp[] =>
    toOpen.map((s) => ({
      id: skKey(s.folder),
      label: s.skill.name,
      run: () => api.openInVsCode(s.skill.folder as string),
    }));

  const archiveOps = (): BulkOp[] =>
    toArchive.map((s) => ({
      id: skKey(s.folder),
      label: s.skill.name,
      run: () => api.archiveUserSkill(s.skill.folder as string),
    }));

  const deleteOps = (): BulkOp[] =>
    toDelete.map((s) => ({
      id: skKey(s.folder),
      label: s.skill.name,
      run: async () => {
        const tracked = await api.deleteSkillLocal(s.skill.folder as string);
        // Red dot straight away for a plugin skill; the backend set the same
        // status, so the watcher will not overwrite it with `modified`.
        if (tracked) setSyncOne(s.folder, "deleted");
        return tracked;
      },
    }));

  const failures = runner.results.filter((r) => !r.ok);

  if (total === 0 && !runner.running && failures.length === 0) return null;

  if (runner.running) {
    return (
      <div className="flex items-center gap-2 border-t bg-card px-3 py-2">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs">
          {runner.done}/{runner.total}
          {runner.current ? ` · ${runner.current}` : ""}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={runner.cancel}
        >
          Annuler
        </Button>
      </div>
    );
  }

  if (total === 0 && failures.length > 0) {
    return (
      <div className="space-y-1 border-t border-destructive/40 bg-destructive/5 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-xs font-medium text-destructive">
            {failures.length} échec{failures.length > 1 ? "s" : ""}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 shrink-0 p-0"
            onClick={runner.reset}
            aria-label="Fermer le récapitulatif"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <ul className="max-h-24 space-y-0.5 overflow-auto text-xs text-destructive">
          {failures.map((f) => (
            <li key={f.id} className="truncate" title={f.error}>
              {f.label} — {f.error}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const summary = [
    selMps.length > 0
      ? `${selMps.length} marketplace${selMps.length > 1 ? "s" : ""}`
      : null,
    selPlugins.length > 0
      ? `${selPlugins.length} plugin${selPlugins.length > 1 ? "s" : ""}`
      : null,
    selSkills.length > 0
      ? `${selSkills.length} skill${selSkills.length > 1 ? "s" : ""}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const installCount = toInstall.length + toInstallMp.length;
  const uninstallCount = toUninstall.length + uninstallableMps.length;

  return (
    <>
      <div className="space-y-1.5 border-t bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {summary || `${total} élément${total > 1 ? "s" : ""}`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={clear}
          >
            Tout décocher
          </Button>
        </div>
        <div className="flex flex-wrap gap-1">
          {installCount > 0 && (
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => runOps(installOps())}
            >
              <Download className="h-3.5 w-3.5" />
              Installer {installCount}
            </Button>
          )}
          {toUpdate.length > 0 && (
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => runOps(updateOps())}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Mettre à jour {toUpdate.length}
            </Button>
          )}
          {toEnable.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => runOps(enableOps(true))}
            >
              <Power className="h-3.5 w-3.5" />
              Activer {toEnable.length}
            </Button>
          )}
          {toDisable.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => runOps(enableOps(false))}
            >
              <PowerOff className="h-3.5 w-3.5" />
              Désactiver {toDisable.length}
            </Button>
          )}
          {toPublish.length > 0 && (
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => {
                onPublishSkills(toPublish.map((s) => s.folder));
                clear();
              }}
              title="Ouvrir l'onglet Changements avec ces compétences cochées"
            >
              <UploadCloud className="h-3.5 w-3.5" />
              Publier {toPublish.length}
            </Button>
          )}
          {toOpen.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => runOps(openOps())}
            >
              <Code2 className="h-3.5 w-3.5" />
              Ouvrir {toOpen.length}
            </Button>
          )}
          {toArchive.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => runOps(archiveOps())}
            >
              <Archive className="h-3.5 w-3.5" />
              Archiver {toArchive.length}
            </Button>
          )}
          {toDelete.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs text-destructive"
              onClick={() => setConfirm("delete")}
              title="Supprimer ces dossiers de compétence sur cette machine"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Supprimer {toDelete.length}
            </Button>
          )}
          {uninstallCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs text-destructive"
              onClick={() => setConfirm("uninstall")}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Désinstaller {uninstallCount}
            </Button>
          )}
        </div>
      </div>

      <Dialog open={confirm !== null} onOpenChange={(v) => !v && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === "delete"
                ? `Supprimer ${toDelete.length} compétence${
                    toDelete.length > 1 ? "s" : ""
                  } en local`
                : `Désinstaller ${uninstallCount} élément${
                    uninstallCount > 1 ? "s" : ""
                  }`}
            </DialogTitle>
            <DialogDescription>
              {confirm === "delete" ? (
                <>
                  {deletePluginCount > 0 && (
                    <>
                      {deletePluginCount === 1
                        ? "1 compétence de plugin est supprimée du disque et reste listée en "
                        : `${deletePluginCount} compétences de plugin sont supprimées du disque et restent listées en `}
                      <strong>supprimé</strong> : poussez la suppression depuis
                      l'onglet <strong>Changements</strong> pour{" "}
                      {deletePluginCount === 1 ? "la" : "les"} retirer aussi du
                      dépôt.{" "}
                    </>
                  )}
                  {deleteLocalCount === 1 && (
                    <>
                      1 compétence personnelle sous{" "}
                      <code>~/.claude/skills/</code> est supprimée
                      définitivement : aucun dépôt distant ne la contient.
                    </>
                  )}
                  {deleteLocalCount > 1 && (
                    <>
                      {deleteLocalCount} compétences personnelles sous{" "}
                      <code>~/.claude/skills/</code> sont supprimées
                      définitivement : aucun dépôt distant ne les contient.
                    </>
                  )}
                </>
              ) : (
                <>
                  {toUninstall.length > 0 && (
                    <>
                      {toUninstall.length} plugin
                      {toUninstall.length > 1 ? "s" : ""} seront supprimés du
                      cache local.{" "}
                    </>
                  )}
                  {uninstallableMps.length > 0 && (
                    <>
                      {uninstallableMps.length} marketplace
                      {uninstallableMps.length > 1 ? "s" : ""} seront désinstallés
                      avec tous leurs plugins installés (ils restent
                      enregistrés).{" "}
                    </>
                  )}
                  Vos compétences personnelles ne sont pas touchées.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Annuler</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const ops = confirm === "delete" ? deleteOps() : uninstallOps();
                setConfirm(null);
                runOps(ops);
              }}
            >
              {confirm === "delete" ? "Supprimer" : "Désinstaller"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

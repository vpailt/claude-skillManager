// Admin → Local: pure-local marketplace + plugin management. Mirrors the Python
// admin_local_panel.py. Install/uninstall/enable/disable/check-updates only —
// nothing opens a PR from this panel.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Download,
  Eye,
  Loader2,
  MoreHorizontal,
  PackageMinus,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useApp } from "@/stores/app";
import { useNotifications } from "@/stores/notifications";
import { useInstallMarketplace } from "@/hooks/useInstallMarketplace";
import { AddMarketplaceDialog } from "@/components/AddMarketplaceDialog";
import type { InstallState, Marketplace, MarketplaceConfig, Plugin } from "@/lib/types";
import { cn } from "@/lib/utils";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ============================================================
// Helpers
// ============================================================

function pluginsInstalled(mp: Marketplace) {
  return mp.plugins.filter((p) => p.installedVersion).length;
}

function pluginsOutdated(mp: Marketplace) {
  return mp.plugins.filter((p) => p.installState === "outdated").length;
}

function freshness(mp: Marketplace): { text: string; tone: "muted" | "ok" | "warn" } {
  if (!mp.installed) return { text: "non installé", tone: "muted" };
  const out = pluginsOutdated(mp);
  if (out > 0) return { text: `⚠ ${out} obsolète(s)`, tone: "warn" };
  if (pluginsInstalled(mp) === 0) return { text: "rien d'installé", tone: "muted" };
  return { text: "à jour", tone: "ok" };
}

const STATE_LABEL: Record<InstallState, string> = {
  not_installed: "non installé",
  installed: "à jour",
  outdated: "obsolète",
  local_only: "local uniquement",
  unknown: "inconnu",
};

function stateVariant(s: InstallState) {
  if (s === "installed") return "success" as const;
  if (s === "outdated") return "warning" as const;
  if (s === "local_only") return "secondary" as const;
  return "outline" as const;
}

// ============================================================
// Uninstall-marketplace confirmation dialog
// ============================================================

function UninstallMarketplaceDialog({
  marketplace,
  open,
  onOpenChange,
}: {
  marketplace: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [alsoForget, setAlsoForget] = useState(false);
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!marketplace) return;
      await api.uninstallMarketplace(marketplace);
      if (alsoForget) {
        await api.settingsRemoveMarketplace(marketplace);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      setAlsoForget(false);
      setError("");
      onOpenChange(false);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Désinstaller le marketplace « {marketplace ?? ""} »</DialogTitle>
          <DialogDescription>
            Retire l'entrée de <code>known_marketplaces.json</code> et supprime le
            dossier sous <code>~/.claude/plugins/marketplaces/{marketplace ?? ""}/</code>.
            Les enregistrements d'installation des plugins ne sont pas modifiés.
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch checked={alsoForget} onCheckedChange={setAlsoForget} />
          Retirer aussi de la liste des marketplaces de l'app
        </label>
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Annuler</Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Désinstaller
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Delete-marketplace confirmation dialog
//
// Unlike "Uninstall" (local files only), this does a full removal: it uninstalls
// the marketplace folder + entry in `known_marketplaces.json` (no-op if not
// installed) AND forgets it from the app's `marketplaces.json`. Without the
// uninstall step, an installed marketplace immediately reappears via the
// orphan-detection logic in `local_scanner::build_marketplaces_from_settings`.
// ============================================================

function DeleteMarketplaceDialog({
  marketplace,
  installed,
  installedPluginCount,
  open,
  onOpenChange,
}: {
  marketplace: string | null;
  installed: boolean;
  installedPluginCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      if (!marketplace) return;
      // Cascade-delete: uninstall plugins + marketplace folder + forget settings.
      // Doing this in one Rust command keeps the operation atomic and avoids
      // the orphan-resurrection problem where any leftover plugin entry in
      // installed_plugins.json would re-surface the marketplace.
      await api.deleteMarketplaceCompletely(marketplace);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      setError("");
      onOpenChange(false);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setError("");
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Supprimer le marketplace « {marketplace ?? ""} »</DialogTitle>
          <DialogDescription>
            {installed ? (
              <>
                Retire l'entrée de <code>known_marketplaces.json</code>, supprime
                le dossier sous{" "}
                <code>~/.claude/plugins/marketplaces/{marketplace ?? ""}/</code>,
                {installedPluginCount > 0 ? (
                  <>
                    {" "}désinstalle{" "}
                    <strong>
                      {installedPluginCount} plugin
                      {installedPluginCount > 1 ? "s" : ""} installé
                      {installedPluginCount > 1 ? "s" : ""}
                    </strong>{" "}
                    de celui-ci,
                  </>
                ) : null}{" "}
                et l'oublie des paramètres de l'app.
              </>
            ) : (
              <>
                Retire ce marketplace des paramètres de l'app. Aucun fichier local
                n'est touché (rien n'avait été installé pour lui).
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Annuler</Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Supprimer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Marketplaces table row
// ============================================================

function MarketplaceRow({
  mp,
  cfgAutoUpdate,
  cfgTrackPrs,
  selected,
  showAdvanced,
  onSelect,
  onUninstallRequest,
  onDeleteRequest,
  onCheckOne,
  status,
}: {
  mp: Marketplace;
  cfgAutoUpdate: boolean;
  cfgTrackPrs: boolean;
  selected: boolean;
  showAdvanced: boolean;
  onSelect: () => void;
  onUninstallRequest: () => void;
  onDeleteRequest: () => void;
  onCheckOne: () => void;
  status: "idle" | "checking" | "updated" | "ok" | "error";
}) {
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);
  const install = useInstallMarketplace();
  const toggleAuto = useMutation({
    mutationFn: async (next: boolean) => {
      const settings = await api.loadAppSettings();
      const cfg = settings.marketplaces.find((m) => m.name === mp.name);
      // Persist even when the marketplace isn't yet in app settings (an "orphan"
      // added via Claude Code's `/plugin marketplace add`). Without an entry in
      // marketplaces.json the flag never sticks (the toggle springs back to off)
      // AND refresh_all never auto-updates it, since it only iterates configured
      // marketplaces. Synthesize a config from the resolved marketplace view;
      // {...cfg} preserves provider/baseUrl for Gitea marketplaces already saved.
      const next_cfg: MarketplaceConfig = cfg
        ? { ...cfg, autoUpdate: next }
        : {
            name: mp.name,
            githubRepo: mp.sourceRepo,
            defaultBranch: "main",
            owned: false,
            sourcePath: mp.sourcePath,
            autoUpdate: next,
          };
      await api.settingsUpsertMarketplace(next_cfg);
      if (mp.installed) {
        await api.setMarketplaceAutoUpdate(mp.name, next);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["refresh"] });
    },
    onError: (e) =>
      notify({
        kind: "error",
        title: `Échec du basculement de la mise à jour auto : ${mp.name}`,
        body: errMsg(e),
      }),
  });
  const toggleTrack = useMutation({
    mutationFn: async (next: boolean) => {
      const settings = await api.loadAppSettings();
      const cfg = settings.marketplaces.find((m) => m.name === mp.name);
      // Same orphan-persistence handling as auto-update above: create the entry
      // when missing so the flag sticks instead of springing back to off.
      const next_cfg: MarketplaceConfig = cfg
        ? { ...cfg, trackPrs: next }
        : {
            name: mp.name,
            githubRepo: mp.sourceRepo,
            defaultBranch: "main",
            owned: false,
            sourcePath: mp.sourcePath,
            autoUpdate: false,
            trackPrs: next,
          };
      await api.settingsUpsertMarketplace(next_cfg);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["tracked-prs"] });
    },
    onError: (e) =>
      notify({
        kind: "error",
        title: `Échec du basculement du suivi des PR : ${mp.name}`,
        body: errMsg(e),
      }),
  });

  const f = freshness(mp);
  const out = pluginsOutdated(mp);

  return (
    <tr
      className={cn(
        "cursor-pointer border-b transition-colors hover:bg-accent/40",
        selected && "bg-accent"
      )}
      onClick={onSelect}
    >
      <td className="px-3 py-2 font-medium">{mp.name}</td>
      <td className="px-3 py-2 text-xs">
        {mp.installed ? (
          <Badge variant="success">installé</Badge>
        ) : (
          <Badge variant="outline">non installé</Badge>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        <span
          className={cn(
            f.tone === "ok" && "text-emerald-500",
            f.tone === "warn" && "text-amber-500",
            f.tone === "muted" && "text-muted-foreground"
          )}
        >
          {f.text}
        </span>
        {status === "checking" && (
          <Loader2 className="ml-1 inline h-3 w-3 animate-spin text-muted-foreground" />
        )}
        {status === "updated" && (
          <span className="ml-1 text-xs text-emerald-500">· mis à jour</span>
        )}
        {status === "ok" && (
          <span className="ml-1 text-xs text-muted-foreground">· vérifié</span>
        )}
        {status === "error" && (
          <span className="ml-1 text-xs text-destructive">· échec</span>
        )}
      </td>
      {showAdvanced && (
        <>
          <td className="px-3 py-2 text-xs text-muted-foreground">
            {mp.sourceRepo || mp.sourcePath || "—"}
          </td>
          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            <div
              className={cn(
                "flex items-center gap-2",
                !mp.sourceRepo && "opacity-50"
              )}
              title={
                mp.sourceRepo
                  ? "Mettre à jour auto à chaque rafraîchissement si le SHA distant a changé"
                  : "Indisponible : ce marketplace n'a pas de repo distant (GitHub/Gitea) configuré"
              }
            >
              <Switch
                checked={cfgAutoUpdate}
                onCheckedChange={(v) => toggleAuto.mutate(v)}
                disabled={!mp.sourceRepo || toggleAuto.isPending}
              />
              <span className="text-xs text-muted-foreground">
                {cfgAutoUpdate ? "activé" : "désactivé"}
              </span>
            </div>
          </td>
          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
            <div
              className={cn(
                "flex items-center gap-2",
                !mp.sourceRepo && "opacity-50"
              )}
              title={
                mp.sourceRepo
                  ? "Suivre les PR ouvertes de ce marketplace et de ses plugins (onglet Suivi Marketplace + Dashboard)"
                  : "Indisponible : ce marketplace n'a pas de repo distant (GitHub/Gitea) configuré"
              }
            >
              <Switch
                checked={cfgTrackPrs}
                onCheckedChange={(v) => toggleTrack.mutate(v)}
                disabled={!mp.sourceRepo || toggleTrack.isPending}
              />
              <span className="text-xs text-muted-foreground">
                {cfgTrackPrs ? "activé" : "désactivé"}
              </span>
            </div>
          </td>
        </>
      )}
      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          {mp.installed ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={onCheckOne}
              title="Re-télécharger ce marketplace si sa version distante a changé"
              disabled={status === "checking"}
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              Vérifier
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => install.mutate(mp)}
              disabled={!mp.sourceRepo || install.isPending}
            >
              {install.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Download className="mr-1 h-3 w-3" />
              )}
              Installer
            </Button>
          )}
          {out > 0 && (
            <Badge variant="warning" className="ml-1 text-xs">
              ⚠ {out}
            </Badge>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                title="Plus d'actions"
                aria-label={`Plus d'actions pour ${mp.name}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{mp.name}</DropdownMenuLabel>
              {mp.installed && (
                <DropdownMenuItem
                  onSelect={onUninstallRequest}
                  title="Supprime les fichiers locaux mais garde ce marketplace dans la liste — vous pourrez le réinstaller plus tard."
                >
                  <PackageMinus className="h-4 w-4" />
                  Désinstaller (garder dans la liste)
                </DropdownMenuItem>
              )}
              {mp.installed && <DropdownMenuSeparator />}
              <DropdownMenuItem destructive onSelect={onDeleteRequest}>
                <Trash2 className="h-4 w-4" />
                {mp.installed
                  ? "Supprimer définitivement (fichiers + liste)"
                  : "Retirer de la liste"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
}

// ============================================================
// Plugins table
// ============================================================

function PluginsTable({
  marketplace,
  filter,
  checked,
  setChecked,
}: {
  marketplace: Marketplace | undefined;
  filter: string;
  checked: Set<string>;
  setChecked: (s: Set<string>) => void;
}) {
  const qc = useQueryClient();
  const notify = useNotifications((s) => s.push);
  const updateOne = useMutation({
    mutationFn: (p: Plugin) => api.installPlugin(p),
    onSuccess: (_, p) => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
      notify({ kind: "success", title: "Plugin mis à jour", body: p.name });
    },
    onError: (e, p) =>
      notify({
        kind: "error",
        title: `Échec de la mise à jour : ${p.name}`,
        body: errMsg(e),
      }),
  });

  const plugins = useMemo(() => {
    if (!marketplace) return [];
    const q = filter.trim().toLowerCase();
    return marketplace.plugins.filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [marketplace, filter]);

  if (!marketplace) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        Choisissez un marketplace ci-dessus pour voir ses plugins.
      </div>
    );
  }
  if (plugins.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        Aucun plugin {filter.trim() && `correspondant à « ${filter} » `}dans ce marketplace.
      </div>
    );
  }

  const toggleAll = (v: boolean) => {
    setChecked(v ? new Set(plugins.map((p) => p.name)) : new Set());
  };

  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="w-8 px-2 py-2">
              <input
                type="checkbox"
                aria-label="Tout sélectionner"
                checked={checked.size === plugins.length && plugins.length > 0}
                onChange={(e) => toggleAll(e.target.checked)}
              />
            </th>
            <th className="px-3 py-2 text-left">Plugin</th>
            <th className="px-3 py-2 text-left">Installé</th>
            <th className="px-3 py-2 text-left">Dernière</th>
            <th className="px-3 py-2 text-left">État</th>
            <th className="px-3 py-2 text-left">Activé</th>
            <th className="px-3 py-2 text-left">Description</th>
            <th className="px-3 py-2 text-left">Actions</th>
          </tr>
        </thead>
        <tbody>
          {plugins.map((p) => (
            <tr key={p.name} className="border-b last:border-b-0 hover:bg-accent/30">
              <td className="px-2 py-2">
                <input
                  type="checkbox"
                  checked={checked.has(p.name)}
                  onChange={(e) => {
                    const next = new Set(checked);
                    if (e.target.checked) next.add(p.name);
                    else next.delete(p.name);
                    setChecked(next);
                  }}
                />
              </td>
              <td className="px-3 py-2 font-medium">{p.name}</td>
              <td className="px-3 py-2 text-xs">{p.installedVersion || "—"}</td>
              <td className="px-3 py-2 text-xs">{p.latestVersion || "—"}</td>
              <td className="px-3 py-2">
                <Badge variant={stateVariant(p.installState)} className="text-xs">
                  {STATE_LABEL[p.installState]}
                </Badge>
              </td>
              <td className="px-3 py-2 text-xs">
                {p.enabled === true ? (
                  <span className="text-emerald-500">activé</span>
                ) : p.enabled === false ? (
                  <span className="text-muted-foreground">désactivé</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                <div className="line-clamp-1 max-w-xs">{p.description || ""}</div>
              </td>
              <td className="px-3 py-2">
                {p.installState === "outdated" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => updateOne.mutate(p)}
                    disabled={updateOne.isPending}
                  >
                    {updateOne.isPending && updateOne.variables?.name === p.name ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-3 w-3" />
                    )}
                    Mettre à jour
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// Panel
// ============================================================

export function AdminLocalPanel() {
  // The synthetic "(local skills)" marketplace is intentionally excluded — it
  // has no install/uninstall/source-repo to manage. Users still see those
  // skills under the regular Plugins tab.
  const allMps = useApp((s) => s.marketplaces);
  const settingsQuery = useQuery({
    queryKey: ["app-settings"],
    queryFn: api.loadAppSettings,
  });

  const [mpFilter, setMpFilter] = useState("");
  const [pluginFilter, setPluginFilter] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    name: string;
    installed: boolean;
    installedPluginCount: number;
  } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [updateStatus, setUpdateStatus] = useState<
    Record<string, "idle" | "checking" | "updated" | "ok" | "error">
  >({});
  const [bottomMsg, setBottomMsg] = useState<{ text: string; ok: boolean } | null>(
    null
  );

  const filteredMps = useMemo(() => {
    const q = mpFilter.trim().toLowerCase();
    return allMps.filter(
      (m) =>
        !q ||
        m.name.toLowerCase().includes(q) ||
        (m.sourceRepo && m.sourceRepo.toLowerCase().includes(q))
    );
  }, [allMps, mpFilter]);

  const selected = useMemo(
    () => allMps.find((m) => m.name === selectedName) ?? filteredMps[0],
    [allMps, filteredMps, selectedName]
  );

  const qc = useQueryClient();

  const checkAll = useMutation({
    mutationFn: (only?: string) => api.checkMarketplaceUpdates(only),
    onMutate: (only) => {
      const targets = only
        ? [only]
        : allMps.filter((m) => m.installed && m.sourceRepo).map((m) => m.name);
      const next: typeof updateStatus = { ...updateStatus };
      targets.forEach((n) => (next[n] = "checking"));
      setUpdateStatus(next);
    },
    onSuccess: (results) => {
      const next = { ...updateStatus };
      const updatedNames: string[] = [];
      const errors: string[] = [];
      for (const r of results) {
        if (r.updated) {
          next[r.name] = "updated";
          updatedNames.push(r.name);
        } else if (r.message === "up to date" || r.message === "no repo") {
          next[r.name] = "ok";
        } else {
          next[r.name] = "error";
          errors.push(`${r.name}: ${r.message}`);
        }
      }
      setUpdateStatus(next);
      qc.invalidateQueries({ queryKey: ["refresh"] });
      if (updatedNames.length > 0) {
        setBottomMsg({
          text: `${updatedNames.length} marketplace(s) mis à jour : ${updatedNames.join(", ")}`,
          ok: true,
        });
      } else if (errors.length > 0) {
        setBottomMsg({
          text: `${errors.length} erreur(s) de vérification : ${errors.slice(0, 3).join("; ")}`,
          ok: false,
        });
      } else if (results.length > 0) {
        setBottomMsg({ text: "Tous les marketplaces vérifiés sont à jour.", ok: true });
      } else {
        setBottomMsg({
          text: "Aucun marketplace installé avec un repo GitHub à vérifier.",
          ok: true,
        });
      }
    },
    onError: (e) =>
      setBottomMsg({
        text: e instanceof Error ? e.message : String(e),
        ok: false,
      }),
  });

  const setEnabledBatch = useMutation({
    mutationFn: async (value: boolean) => {
      if (!selected) throw new Error("Choisissez un marketplace");
      const failures: string[] = [];
      for (const name of checked) {
        try {
          await api.setPluginEnabled(name, selected.name, value);
        } catch (e) {
          failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { count: checked.size, failures, value };
    },
    onSuccess: ({ count, failures, value }) => {
      const verb = value ? "activé(s)" : "désactivé(s)";
      if (failures.length > 0) {
        setBottomMsg({
          text: `${count - failures.length}/${count} ${verb} ; ${failures.slice(0, 3).join("; ")}`,
          ok: false,
        });
      } else {
        setBottomMsg({ text: `${count} plugin(s) ${verb}.`, ok: true });
      }
      qc.invalidateQueries({ queryKey: ["refresh"] });
    },
    // The mutationFn already swallows per-plugin errors into `failures`, so this
    // only fires on unexpected throws (e.g. the "Pick a marketplace" guard).
    onError: (e) =>
      setBottomMsg({ text: errMsg(e), ok: false }),
  });

  const updateOutdated = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Choisissez un marketplace");
      const targets = selected.plugins.filter(
        (p) => p.installState === "outdated" && p.source && (p.source.repo || p.source.path)
      );
      const failures: string[] = [];
      for (const p of targets) {
        try {
          await api.installPlugin(p);
        } catch (e) {
          failures.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { count: targets.length, failures };
    },
    onSuccess: ({ count, failures }) => {
      if (count === 0) {
        setBottomMsg({
          text: `Aucun plugin obsolète dans '${selected?.name ?? ""}'.`,
          ok: true,
        });
      } else if (failures.length > 0) {
        setBottomMsg({
          text: `${count - failures.length}/${count} mis à jour ; ${failures.slice(0, 3).join("; ")}`,
          ok: false,
        });
      } else {
        setBottomMsg({
          text: `${count} plugin(s) mis à jour dans '${selected?.name ?? ""}'.`,
          ok: true,
        });
      }
      qc.invalidateQueries({ queryKey: ["refresh"] });
    },
    // Per-plugin errors are already captured in `failures`; this fires only on
    // unexpected throws (e.g. the no-marketplace guard).
    onError: (e) => setBottomMsg({ text: errMsg(e), ok: false }),
  });

  const onSelect = (name: string) => {
    setSelectedName(name);
    setChecked(new Set());
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Gère les marketplaces et plugins installés localement sous{" "}
        <code>~/.claude/plugins/</code>. Aucune pull request n'est ouverte depuis cet onglet.
      </p>

      {/* Marketplaces section */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Marketplaces</h3>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={showAdvanced ? "default" : "ghost"}
                onClick={() => setShowAdvanced((v) => !v)}
                title="Afficher/masquer les colonnes avancées (repo source, mise à jour auto, suivi PR)"
              >
                <SlidersHorizontal className="mr-1 h-3 w-3" />
                Options avancées
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAddOpen(true)}
              >
                <Plus className="mr-1 h-3 w-3" />
                Ajouter depuis URL
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => checkAll.mutate(undefined)}
                disabled={checkAll.isPending}
              >
                {checkAll.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3 w-3" />
                )}
                Vérifier les mises à jour
              </Button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-7"
              placeholder="Filtrer les marketplaces…"
              value={mpFilter}
              onChange={(e) => setMpFilter(e.target.value)}
            />
          </div>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left">Nom</th>
                  <th className="px-3 py-2 text-left">Installation</th>
                  <th className="px-3 py-2 text-left">Fraîcheur</th>
                  {showAdvanced && (
                    <>
                      <th className="px-3 py-2 text-left">Repo source</th>
                      <th className="px-3 py-2 text-left">Mise à jour auto</th>
                      <th className="px-3 py-2 text-left">Suivi PR</th>
                    </>
                  )}
                  <th className="px-3 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredMps.map((mp) => (
                  <MarketplaceRow
                    key={mp.name}
                    mp={mp}
                    cfgAutoUpdate={
                      settingsQuery.data?.marketplaces.find(
                        (m) => m.name === mp.name
                      )?.autoUpdate ?? false
                    }
                    cfgTrackPrs={
                      settingsQuery.data?.marketplaces.find(
                        (m) => m.name === mp.name
                      )?.trackPrs ?? false
                    }
                    selected={selected?.name === mp.name}
                    showAdvanced={showAdvanced}
                    onSelect={() => onSelect(mp.name)}
                    onUninstallRequest={() => setUninstallTarget(mp.name)}
                    onDeleteRequest={() =>
                      setDeleteTarget({
                        name: mp.name,
                        installed: mp.installed,
                        installedPluginCount: pluginsInstalled(mp),
                      })
                    }
                    onCheckOne={() => checkAll.mutate(mp.name)}
                    status={updateStatus[mp.name] ?? "idle"}
                  />
                ))}
                {filteredMps.length === 0 && (
                  <tr>
                    <td
                      colSpan={showAdvanced ? 7 : 4}
                      className="px-3 py-6 text-center text-xs text-muted-foreground"
                    >
                      Aucun marketplace. Cliquez sur <em>Ajouter depuis URL</em>.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Plugins section */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              Plugins de{" "}
              <span className="text-primary">{selected?.name || "(aucun)"}</span>
            </h3>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEnabledBatch.mutate(true)}
                disabled={checked.size === 0 || setEnabledBatch.isPending}
              >
                <Check className="mr-1 h-3 w-3" />
                Activer la sélection
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEnabledBatch.mutate(false)}
                disabled={checked.size === 0 || setEnabledBatch.isPending}
              >
                <Eye className="mr-1 h-3 w-3" />
                Désactiver la sélection
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => updateOutdated.mutate()}
                disabled={updateOutdated.isPending}
              >
                {updateOutdated.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3 w-3" />
                )}
                Mettre à jour les obsolètes
              </Button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-7"
              placeholder="Filtrer les plugins…"
              value={pluginFilter}
              onChange={(e) => setPluginFilter(e.target.value)}
            />
          </div>
          <PluginsTable
            marketplace={selected}
            filter={pluginFilter}
            checked={checked}
            setChecked={setChecked}
          />
        </CardContent>
      </Card>

      {bottomMsg && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md border p-3 text-xs",
            bottomMsg.ok
              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
              : "border-destructive/40 bg-destructive/5 text-destructive"
          )}
        >
          {bottomMsg.ok ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
          {bottomMsg.text}
        </div>
      )}

      <AddMarketplaceDialog open={addOpen} onOpenChange={setAddOpen} />
      <UninstallMarketplaceDialog
        marketplace={uninstallTarget}
        open={uninstallTarget !== null}
        onOpenChange={(v) => !v && setUninstallTarget(null)}
      />
      <DeleteMarketplaceDialog
        marketplace={deleteTarget?.name ?? null}
        installed={deleteTarget?.installed ?? false}
        installedPluginCount={deleteTarget?.installedPluginCount ?? 0}
        open={deleteTarget !== null}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
      />
    </div>
  );
}

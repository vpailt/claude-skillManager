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
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import type { InstallState, Marketplace, Plugin } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  if (!mp.installed) return { text: "not installed", tone: "muted" };
  const out = pluginsOutdated(mp);
  if (out > 0) return { text: `⚠ ${out} outdated`, tone: "warn" };
  if (pluginsInstalled(mp) === 0) return { text: "nothing installed", tone: "muted" };
  return { text: "up to date", tone: "ok" };
}

const STATE_LABEL: Record<InstallState, string> = {
  not_installed: "not installed",
  installed: "up to date",
  outdated: "outdated",
  local_only: "local only",
  unknown: "unknown",
};

function stateVariant(s: InstallState) {
  if (s === "installed") return "success" as const;
  if (s === "outdated") return "warning" as const;
  if (s === "local_only") return "secondary" as const;
  return "outline" as const;
}

// ============================================================
// Add-marketplace-from-URL dialog
// ============================================================

function AddMarketplaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [parsedRepo, setParsedRepo] = useState<string | null>(null);
  const [error, setError] = useState("");

  const reset = () => {
    setUrl("");
    setName("");
    setParsedRepo(null);
    setError("");
  };

  const onUrlBlur = async () => {
    setError("");
    if (!url.trim()) {
      setParsedRepo(null);
      return;
    }
    const repo = await api.parseMarketplaceUrl(url.trim());
    if (!repo) {
      setError(`Cannot parse owner/repo from: ${url}`);
      setParsedRepo(null);
      return;
    }
    setParsedRepo(repo);
    if (!name.trim()) setName(repo.split("/").pop() || "");
  };

  const upsert = useMutation({
    mutationFn: async () => {
      if (!parsedRepo) throw new Error("URL is invalid");
      if (!name.trim()) throw new Error("Marketplace name is required");
      return api.settingsUpsertMarketplace({
        name: name.trim(),
        githubRepo: parsedRepo,
        defaultBranch: "main",
        owned: false,
        sourcePath: "",
        autoUpdate: false,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["refresh"] });
      reset();
      onOpenChange(false);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add marketplace from Git URL</DialogTitle>
          <DialogDescription>
            Pulls the marketplace registry (<code>.claude-plugin/marketplace.json</code>) and
            registers it in this app's settings. Use “Install” afterwards to download it locally.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Git URL
            </label>
            <Input
              placeholder="https://github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={onUrlBlur}
              autoFocus
            />
            {parsedRepo && (
              <div className="mt-1 text-xs text-muted-foreground">
                Parsed: <code>{parsedRepo}</code>
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Marketplace name
            </label>
            <Input
              placeholder="(defaults to repo name)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={() => upsert.mutate()}
            disabled={!parsedRepo || !name.trim() || upsert.isPending}
          >
            {upsert.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
          <DialogTitle>Uninstall marketplace “{marketplace ?? ""}”</DialogTitle>
          <DialogDescription>
            Removes the entry from <code>known_marketplaces.json</code> and deletes the
            folder under <code>~/.claude/plugins/marketplaces/{marketplace ?? ""}/</code>.
            Plugin install records are not touched.
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch checked={alsoForget} onCheckedChange={setAlsoForget} />
          Also remove from this app's marketplace list
        </label>
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
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Uninstall
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
  selected,
  onSelect,
  onUninstallRequest,
  onCheckOne,
  status,
}: {
  mp: Marketplace;
  cfgAutoUpdate: boolean;
  selected: boolean;
  onSelect: () => void;
  onUninstallRequest: () => void;
  onCheckOne: () => void;
  status: "idle" | "checking" | "updated" | "ok" | "error";
}) {
  const qc = useQueryClient();
  const install = useMutation({
    mutationFn: async () => {
      const cfg = await api.loadAppSettings().then((s) =>
        s.marketplaces.find((m) => m.name === mp.name)
      );
      const repo = cfg?.githubRepo || mp.sourceRepo;
      const branch = cfg?.defaultBranch || "main";
      const auto = cfg?.autoUpdate ?? null;
      if (!repo) throw new Error("No GitHub repo configured for this marketplace");
      return api.installMarketplace(mp.name, repo, branch, auto);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["refresh"] }),
  });
  const forget = useMutation({
    mutationFn: () => api.settingsRemoveMarketplace(mp.name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["refresh"] });
    },
  });
  const toggleAuto = useMutation({
    mutationFn: async (next: boolean) => {
      const settings = await api.loadAppSettings();
      const cfg = settings.marketplaces.find((m) => m.name === mp.name);
      if (cfg) {
        await api.settingsUpsertMarketplace({ ...cfg, autoUpdate: next });
      }
      if (mp.installed) {
        await api.setMarketplaceAutoUpdate(mp.name, next);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["refresh"] });
    },
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
          <Badge variant="success">installed</Badge>
        ) : (
          <Badge variant="outline">not installed</Badge>
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
          <span className="ml-1 text-xs text-emerald-500">· updated</span>
        )}
        {status === "ok" && (
          <span className="ml-1 text-xs text-muted-foreground">· checked</span>
        )}
        {status === "error" && (
          <span className="ml-1 text-xs text-destructive">· failed</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {mp.sourceRepo || mp.sourcePath || "—"}
      </td>
      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2" title="Auto-update on every refresh if the remote SHA changed">
          <Switch
            checked={cfgAutoUpdate}
            onCheckedChange={(v) => toggleAuto.mutate(v)}
            disabled={!mp.sourceRepo || toggleAuto.isPending}
          />
          <span className="text-[11px] text-muted-foreground">
            {cfgAutoUpdate ? "on" : "off"}
          </span>
        </div>
      </td>
      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          {mp.installed ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={onUninstallRequest}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Uninstall
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={onCheckOne}
                title="Re-pull this marketplace if its remote SHA changed"
                disabled={status === "checking"}
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                Check
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => install.mutate()}
              disabled={!mp.sourceRepo || install.isPending}
            >
              {install.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Download className="mr-1 h-3 w-3" />
              )}
              Install
            </Button>
          )}
          {out > 0 && (
            <Badge variant="warning" className="ml-1 text-[10px]">
              ⚠ {out}
            </Badge>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-destructive"
            onClick={() => forget.mutate()}
            title="Forget this marketplace from the app's settings (does not delete local files)"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
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
  const updateOne = useMutation({
    mutationFn: (p: Plugin) => api.installPlugin(p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["refresh"] }),
  });

  const plugins = useMemo(() => {
    if (!marketplace) return [];
    const q = filter.trim().toLowerCase();
    return marketplace.plugins.filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [marketplace, filter]);

  if (!marketplace) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        Pick a marketplace above to see its plugins.
      </div>
    );
  }
  if (plugins.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No plugins {filter.trim() && `matching “${filter}” `}in this marketplace.
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
                aria-label="Toggle all"
                checked={checked.size === plugins.length && plugins.length > 0}
                onChange={(e) => toggleAll(e.target.checked)}
              />
            </th>
            <th className="px-3 py-2 text-left">Plugin</th>
            <th className="px-3 py-2 text-left">Installed</th>
            <th className="px-3 py-2 text-left">Latest</th>
            <th className="px-3 py-2 text-left">State</th>
            <th className="px-3 py-2 text-left">Enabled</th>
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
                <Badge variant={stateVariant(p.installState)} className="text-[10px]">
                  {STATE_LABEL[p.installState]}
                </Badge>
              </td>
              <td className="px-3 py-2 text-xs">
                {p.enabled === true ? (
                  <span className="text-emerald-500">enabled</span>
                ) : p.enabled === false ? (
                  <span className="text-muted-foreground">disabled</span>
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
                    <RefreshCw className="mr-1 h-3 w-3" />
                    Update
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
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null);
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
          text: `Updated ${updatedNames.length} marketplace(s): ${updatedNames.join(", ")}`,
          ok: true,
        });
      } else if (errors.length > 0) {
        setBottomMsg({
          text: `${errors.length} check error(s): ${errors.slice(0, 3).join("; ")}`,
          ok: false,
        });
      } else if (results.length > 0) {
        setBottomMsg({ text: "All checked marketplaces are up to date.", ok: true });
      } else {
        setBottomMsg({
          text: "No installed marketplace with a GitHub repo to check.",
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
      if (!selected) throw new Error("Pick a marketplace");
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
      const verb = value ? "enabled" : "disabled";
      if (failures.length > 0) {
        setBottomMsg({
          text: `${count - failures.length}/${count} ${verb}; ${failures.slice(0, 3).join("; ")}`,
          ok: false,
        });
      } else {
        setBottomMsg({ text: `${count} plugin(s) ${verb}.`, ok: true });
      }
      qc.invalidateQueries({ queryKey: ["refresh"] });
    },
  });

  const updateOutdated = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Pick a marketplace");
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
          text: `No outdated plugins in '${selected?.name ?? ""}'.`,
          ok: true,
        });
      } else if (failures.length > 0) {
        setBottomMsg({
          text: `${count - failures.length}/${count} updated; ${failures.slice(0, 3).join("; ")}`,
          ok: false,
        });
      } else {
        setBottomMsg({
          text: `Updated ${count} plugin(s) in '${selected?.name ?? ""}'.`,
          ok: true,
        });
      }
      qc.invalidateQueries({ queryKey: ["refresh"] });
    },
  });

  const onSelect = (name: string) => {
    setSelectedName(name);
    setChecked(new Set());
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Manage marketplaces and plugins installed locally under{" "}
        <code>~/.claude/plugins/</code>. No pull requests are opened from this tab.
      </p>

      {/* Marketplaces section */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Marketplaces</h3>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAddOpen(true)}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add from URL
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
                Check updates
              </Button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-7"
              placeholder="Filter marketplaces…"
              value={mpFilter}
              onChange={(e) => setMpFilter(e.target.value)}
            />
          </div>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Install</th>
                  <th className="px-3 py-2 text-left">Freshness</th>
                  <th className="px-3 py-2 text-left">Source repo</th>
                  <th className="px-3 py-2 text-left">Auto-update</th>
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
                    selected={selected?.name === mp.name}
                    onSelect={() => onSelect(mp.name)}
                    onUninstallRequest={() => setUninstallTarget(mp.name)}
                    onCheckOne={() => checkAll.mutate(mp.name)}
                    status={updateStatus[mp.name] ?? "idle"}
                  />
                ))}
                {filteredMps.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-6 text-center text-xs text-muted-foreground"
                    >
                      No marketplaces. Click <em>Add from URL</em>.
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
              Plugins of{" "}
              <span className="text-primary">{selected?.name || "(none)"}</span>
            </h3>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEnabledBatch.mutate(true)}
                disabled={checked.size === 0 || setEnabledBatch.isPending}
              >
                <Check className="mr-1 h-3 w-3" />
                Enable selected
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEnabledBatch.mutate(false)}
                disabled={checked.size === 0 || setEnabledBatch.isPending}
              >
                <Eye className="mr-1 h-3 w-3" />
                Disable selected
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
                Update outdated
              </Button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-7"
              placeholder="Filter plugins…"
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
    </div>
  );
}

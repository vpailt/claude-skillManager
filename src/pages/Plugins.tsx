import { useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Package,
  Sparkles,
  Globe,
  Download,
  Trash2,
  Power,
  PowerOff,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useApp, type Selection } from "@/stores/app";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { InstallState, Marketplace, Plugin, Skill } from "@/lib/types";

const STATE_LABEL: Record<InstallState, string> = {
  not_installed: "not installed",
  installed: "installed",
  outdated: "update available",
  local_only: "local only",
  unknown: "unknown",
};

function stateVariant(s: InstallState) {
  if (s === "installed") return "success" as const;
  if (s === "outdated") return "warning" as const;
  if (s === "local_only") return "secondary" as const;
  return "outline" as const;
}

function PluginRow({ marketplace, plugin }: { marketplace: string; plugin: Plugin }) {
  const setSelection = useApp((s) => s.setSelection);
  const selection = useApp((s) => s.selection);
  const [open, setOpen] = useState(true);
  const isSelected =
    selection?.kind === "plugin" &&
    selection.marketplace === marketplace &&
    selection.plugin === plugin.name;

  return (
    <div className="ml-4">
      <div
        className={cn(
          "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
          isSelected && "bg-accent"
        )}
        onClick={() =>
          setSelection({ kind: "plugin", marketplace, plugin: plugin.name })
        }
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </Button>
        <Package className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{plugin.name}</span>
        <Badge variant={stateVariant(plugin.installState)}>
          {STATE_LABEL[plugin.installState]}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {plugin.installedVersion || plugin.latestVersion || ""}
        </span>
      </div>
      {open && plugin.skills.length > 0 && (
        <div className="ml-2 border-l border-border/60 pl-2">
          {plugin.skills.map((s) => (
            <SkillRow
              key={s.name}
              marketplace={marketplace}
              plugin={plugin.name}
              skill={s}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillRow({
  marketplace,
  plugin,
  skill,
}: {
  marketplace: string;
  plugin: string;
  skill: Skill;
}) {
  const setSelection = useApp((s) => s.setSelection);
  const selection = useApp((s) => s.selection);
  const isSelected =
    selection?.kind === "skill" &&
    selection.marketplace === marketplace &&
    selection.plugin === plugin &&
    selection.skill === skill.name;
  return (
    <div
      className={cn(
        "ml-3 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent",
        isSelected && "bg-accent"
      )}
      onClick={() =>
        setSelection({ kind: "skill", marketplace, plugin, skill: skill.name })
      }
    >
      <Sparkles className="h-3 w-3 text-muted-foreground" />
      <span className="truncate">{skill.name}</span>
      {!skill.folder && skill.remotePresent && (
        <Badge variant="outline" className="text-[10px]">
          remote
        </Badge>
      )}
    </div>
  );
}

function MarketplaceBlock({ marketplace }: { marketplace: Marketplace }) {
  const setSelection = useApp((s) => s.setSelection);
  const selection = useApp((s) => s.selection);
  const [open, setOpen] = useState(true);
  const isSelected =
    selection?.kind === "marketplace" && selection.marketplace === marketplace.name;
  return (
    <div className="px-2 py-1">
      <div
        className={cn(
          "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm font-medium hover:bg-accent",
          isSelected && "bg-accent"
        )}
        onClick={() =>
          setSelection({ kind: "marketplace", marketplace: marketplace.name })
        }
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </Button>
        <Globe className="h-4 w-4 text-muted-foreground" />
        <span>{marketplace.name}</span>
        {marketplace.installed && <Badge variant="success">installed</Badge>}
      </div>
      {open && (
        <div className="ml-2 border-l border-border/60 pl-2">
          {marketplace.plugins.map((p) => (
            <PluginRow key={p.name} marketplace={marketplace.name} plugin={p} />
          ))}
          {marketplace.plugins.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No plugins listed.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailPanel({ selection }: { selection: Selection }) {
  const findPlugin = useApp((s) => s.findPlugin);
  const findSkill = useApp((s) => s.findSkill);
  const findMarketplace = useApp((s) => s.findMarketplace);
  const qc = useQueryClient();

  const installMutation = useMutation({
    mutationFn: api.installPlugin,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["refresh"] }),
  });
  const uninstallMutation = useMutation({
    mutationFn: api.uninstallPlugin,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["refresh"] }),
  });
  const enableMutation = useMutation({
    mutationFn: ({
      plugin,
      marketplace,
      value,
    }: {
      plugin: string;
      marketplace: string;
      value: boolean;
    }) => api.setPluginEnabled(plugin, marketplace, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["refresh"] }),
  });

  if (!selection) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a marketplace, plugin or skill to see details.
      </div>
    );
  }

  if (selection.kind === "marketplace") {
    const m = findMarketplace(selection.marketplace);
    if (!m) return null;
    return (
      <Card className="m-4">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{m.name}</CardTitle>
            {m.installed && <Badge variant="success">installed</Badge>}
          </div>
          <CardDescription>{m.sourceRepo || m.sourcePath || m.sourceKind}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <span className="text-muted-foreground">Plugins:</span> {m.plugins.length}
          </div>
          <div>
            <span className="text-muted-foreground">Last updated:</span>{" "}
            {m.lastUpdated || "—"}
          </div>
          {m.installLocation && (
            <div className="break-all text-xs text-muted-foreground">
              {m.installLocation}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  if (selection.kind === "plugin") {
    const p = findPlugin(selection.marketplace, selection.plugin);
    if (!p) return null;
    return (
      <Card className="m-4">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{p.name}</CardTitle>
              <CardDescription>{p.description || "No description"}</CardDescription>
            </div>
            <Badge variant={stateVariant(p.installState)}>
              {STATE_LABEL[p.installState]}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex items-center gap-2">
            {(p.installState === "not_installed" || p.installState === "outdated") && (
              <Button
                size="sm"
                onClick={() => installMutation.mutate(p)}
                disabled={installMutation.isPending}
              >
                <Download className="mr-1 h-3 w-3" />
                {p.installState === "outdated" ? "Update" : "Install"}
              </Button>
            )}
            {(p.installState === "installed" ||
              p.installState === "outdated" ||
              p.installState === "local_only") && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => uninstallMutation.mutate(p)}
                disabled={uninstallMutation.isPending}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Uninstall
              </Button>
            )}
            {p.installState !== "not_installed" && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Enabled</span>
                <Switch
                  checked={!!p.enabled}
                  onCheckedChange={(v) =>
                    enableMutation.mutate({
                      plugin: p.name,
                      marketplace: p.marketplaceName,
                      value: v,
                    })
                  }
                />
                {p.enabled ? (
                  <Power className="h-3 w-3 text-emerald-500" />
                ) : (
                  <PowerOff className="h-3 w-3 text-muted-foreground" />
                )}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Installed version</div>
              <div>{p.installedVersion || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Latest version</div>
              <div>{p.latestVersion || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Marketplace</div>
              <div>{p.marketplaceName}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Source</div>
              <div className="truncate">
                {p.source?.repo || p.source?.url || p.source?.path || "—"}
              </div>
            </div>
          </div>
          {p.installPath && (
            <div className="break-all text-xs text-muted-foreground">
              {p.installPath}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  if (selection.kind === "skill") {
    const s = findSkill(selection.marketplace, selection.plugin, selection.skill);
    if (!s) return null;
    return (
      <Card className="m-4">
        <CardHeader>
          <CardTitle>{s.name}</CardTitle>
          <CardDescription>{s.description || "No description"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">Plugin:</span>{" "}
            {s.pluginName || "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Marketplace:</span>{" "}
            {s.marketplaceName || "—"}
          </div>
          {s.folder && (
            <div className="break-all text-xs text-muted-foreground">
              {s.folder.toString()}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }
  return null;
}

export function PluginsPage() {
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  const selection = useApp((s) => s.selection);

  const list = useMemo(() => {
    const out = [...marketplaces];
    if (localOnly && localOnly.plugins.length > 0) out.unshift(localOnly);
    return out;
  }, [marketplaces, localOnly]);

  return (
    <div className="grid h-full grid-cols-[360px_1fr] divide-x">
      <div className="flex h-full flex-col">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Marketplaces & plugins</h2>
        </div>
        <ScrollArea className="flex-1">
          <div className="py-2">
            {list.map((m) => (
              <MarketplaceBlock key={m.name} marketplace={m} />
            ))}
            {list.length === 0 && (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                Nothing here yet — add a marketplace from Settings.
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
      <ScrollArea className="h-full">
        <DetailPanel selection={selection} />
      </ScrollArea>
    </div>
  );
}

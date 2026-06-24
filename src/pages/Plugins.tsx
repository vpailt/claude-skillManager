import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronRight,
  ChevronDown,
  Package,
  Sparkles,
  BookOpen,
  Globe,
  Download,
  Trash2,
  Power,
  PowerOff,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useApp, type Selection } from "@/stores/app";
import { useNotifications } from "@/stores/notifications";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { ResizableSplit } from "@/components/ResizableSplit";
import { SkillMarkdown } from "@/components/SkillMarkdown";
import type { InstallState, Marketplace, Plugin, Skill } from "@/lib/types";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const STATE_LABEL: Record<InstallState, string> = {
  not_installed: "non installé",
  installed: "installé",
  outdated: "mise à jour disponible",
  local_only: "local uniquement",
  unknown: "inconnu",
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
        <Package className="h-4 w-4 shrink-0 text-amber-400/80" />
        <Badge
          variant={stateVariant(plugin.installState)}
          className="shrink-0"
        >
          {STATE_LABEL[plugin.installState]}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-medium">
          {plugin.name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
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
      <BookOpen className="h-3.5 w-3.5 shrink-0 text-violet-400/80" />
      {!skill.folder && skill.remotePresent && (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          distant
        </Badge>
      )}
      <span className="min-w-0 flex-1 truncate">{skill.name}</span>
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
        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
        {marketplace.installed && (
          <Badge variant="success" className="shrink-0">
            installé
          </Badge>
        )}
        <span className="min-w-0 flex-1 truncate">{marketplace.name}</span>
      </div>
      {open && (
        <div className="ml-2 border-l border-border/60 pl-2">
          {marketplace.plugins.map((p) => (
            <PluginRow key={p.name} marketplace={marketplace.name} plugin={p} />
          ))}
          {marketplace.plugins.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Aucun plugin listé.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Breadcrumb({ selection }: { selection: Selection }) {
  if (!selection) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <span>{selection.marketplace}</span>
      {"plugin" in selection && (
        <>
          <ChevronRight className="h-3 w-3" />
          <span>{selection.plugin}</span>
        </>
      )}
      {selection.kind === "skill" && (
        <>
          <ChevronRight className="h-3 w-3" />
          <span className="text-foreground">{selection.skill}</span>
        </>
      )}
    </div>
  );
}

function DetailPanel({ selection }: { selection: Selection }) {
  const findPlugin = useApp((s) => s.findPlugin);
  const findSkill = useApp((s) => s.findSkill);
  const findMarketplace = useApp((s) => s.findMarketplace);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const notify = useNotifications((s) => s.push);
  const installMutation = useMutation({
    mutationFn: api.installPlugin,
    onSuccess: (_, plugin) => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
      notify({ kind: "success", title: "Plugin installé", body: plugin.name });
    },
    onError: (e, plugin) =>
      notify({
        kind: "error",
        title: `Échec de l'installation : ${plugin.name}`,
        body: errMsg(e),
      }),
  });
  const uninstallMutation = useMutation({
    mutationFn: api.uninstallPlugin,
    onSuccess: (_, plugin) => {
      qc.invalidateQueries({ queryKey: ["refresh"] });
      notify({ kind: "success", title: "Plugin désinstallé", body: plugin.name });
    },
    onError: (e, plugin) =>
      notify({
        kind: "error",
        title: `Échec de la désinstallation : ${plugin.name}`,
        body: errMsg(e),
      }),
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
    onError: (e, vars) =>
      notify({
        kind: "error",
        title: `Échec du basculement : ${vars.plugin}`,
        body: errMsg(e),
      }),
  });

  const selectedSkill =
    selection?.kind === "skill"
      ? findSkill(selection.marketplace, selection.plugin, selection.skill)
      : null;
  const skillContent = useQuery({
    enabled: !!selectedSkill?.skillMdPath,
    queryKey: ["plugins-skill-md", selectedSkill?.skillMdPath],
    queryFn: () => api.readTextFile(selectedSkill!.skillMdPath as string),
  });

  if (!selection) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 py-20 text-center text-sm text-muted-foreground">
        <Package className="h-8 w-8 opacity-40" />
        <span>Sélectionne un marketplace, plugin ou skill pour voir les détails.</span>
      </div>
    );
  }

  if (selection.kind === "marketplace") {
    const m = findMarketplace(selection.marketplace);
    if (!m) return null;
    return (
      <Card className="m-4">
        <CardHeader>
          <Breadcrumb selection={selection} />
          <div className="flex items-center justify-between">
            <CardTitle>{m.name}</CardTitle>
            {m.installed && <Badge variant="success">installé</Badge>}
          </div>
          <CardDescription>{m.sourceRepo || m.sourcePath || m.sourceKind}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <span className="text-muted-foreground">Plugins :</span> {m.plugins.length}
          </div>
          <div>
            <span className="text-muted-foreground">Dernière mise à jour :</span>{" "}
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
          <Breadcrumb selection={selection} />
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{p.name}</CardTitle>
              <CardDescription>{p.description || "Aucune description"}</CardDescription>
            </div>
            <Badge variant={stateVariant(p.installState)}>
              {STATE_LABEL[p.installState]}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {(p.installState === "not_installed" || p.installState === "outdated") && (
              <Button
                size="sm"
                onClick={() => installMutation.mutate(p)}
                disabled={installMutation.isPending}
              >
                <Download className="mr-1 h-3 w-3" />
                {p.installState === "outdated" ? "Mettre à jour" : "Installer"}
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
                Désinstaller
              </Button>
            )}
            {p.skills.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                title={`Ouvrir l'onglet Skills filtré sur ${p.name}`}
                onClick={() =>
                  navigate(
                    `/skills?marketplace=${encodeURIComponent(
                      p.marketplaceName
                    )}&plugin=${encodeURIComponent(p.name)}`
                  )
                }
              >
                <Sparkles className="mr-1 h-3 w-3" />
                Voir les skills ({p.skills.length})
              </Button>
            )}
            {p.installState !== "not_installed" && (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Activé</span>
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
              <div className="text-xs text-muted-foreground">Version installée</div>
              <div>{p.installedVersion || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Dernière version</div>
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
    const s = selectedSkill;
    if (!s) return null;
    return (
      <Card className="m-4">
        <CardHeader>
          <Breadcrumb selection={selection} />
          <CardTitle>{s.name}</CardTitle>
          <CardDescription>{s.description || "Aucune description"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {s.folder && (
            <div className="break-all rounded-md bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
              {s.folder.toString()}
            </div>
          )}
          {s.skillMdPath && (
            <div className="rounded-md border bg-card p-4">
              {skillContent.isLoading ? (
                <div className="text-xs text-muted-foreground">Chargement…</div>
              ) : skillContent.data ? (
                <SkillMarkdown content={skillContent.data} />
              ) : (
                <div className="text-xs text-muted-foreground">
                  (échec de la lecture)
                </div>
              )}
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

  const left = (
    <>
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Marketplaces et plugins</h2>
      </div>
      <ScrollArea className="flex-1">
        <div className="py-2">
          {list.map((m) => (
            <MarketplaceBlock key={m.name} marketplace={m} />
          ))}
          {list.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
              <Globe className="h-6 w-6 opacity-40" />
              <span>Aucun marketplace pour l'instant. Ajoutes-en un depuis l'onglet Admin.</span>
            </div>
          )}
        </div>
      </ScrollArea>
    </>
  );

  const right = (
    <ScrollArea className="h-full">
      <DetailPanel selection={selection} />
    </ScrollArea>
  );

  return (
    <div className="h-full min-h-0 w-full min-w-0 flex-1">
      <ResizableSplit storageId="plugins" left={left} right={right} defaultLeftSize={28} />
    </div>
  );
}

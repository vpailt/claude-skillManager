// Changements — everything the sync watcher found waiting to be published.
//
// Replaces the old bulk-push modal. Three things it does that the modal did not:
// deletions travel in the same PR as the edits of their plugin, each group gets
// its own bump level and release notes, and publishing reports group by group so
// a failure half-way never hides the PRs that did open.
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FilePlus2,
  GitBranch,
  Loader2,
  Lock,
  Package,
  Pencil,
  Trash,
  UploadCloud,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScrollFade } from "@/components/ScrollFade";
import { Textarea } from "@/components/ui/textarea";
import { DiffViewToggle, FileDiff } from "@/components/FileDiff";
import { useBulkRunner, type BulkOp } from "@/hooks/useBulkRunner";
import { useProgress } from "@/stores/progress";
import { api } from "@/lib/api";
import { usePendingChanges, type ChangeGroup } from "@/lib/changes";
import { openExternal } from "@/lib/utils";
import { useSkillSync } from "@/stores/skillSync";
import type { AdminDraft, BumpLevel, SkillSyncStatus, UploadResult } from "@/lib/types";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const STATUS_META: Partial<
  Record<SkillSyncStatus, { label: string; className: string; Icon: typeof Pencil }>
> = {
  modified: {
    label: "modifié",
    className: "text-amber-600 dark:text-amber-400",
    Icon: Pencil,
  },
  new: {
    label: "nouveau",
    className: "text-emerald-600 dark:text-emerald-400",
    Icon: FilePlus2,
  },
  deleted: {
    label: "supprimé",
    className: "text-destructive",
    Icon: Trash,
  },
};

/** Per-group PR settings, edited before preparing. */
interface GroupSettings {
  bumpLevel: BumpLevel;
  notes: string;
}

const DEFAULT_SETTINGS: GroupSettings = { bumpLevel: "patch", notes: "" };

export function ChangesPage() {
  const location = useLocation();
  const groups = usePendingChanges();
  const setSyncOne = useSkillSync((s) => s.setOne);

  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<Record<string, GroupSettings>>({});
  const [drafts, setDrafts] = useState<Record<string, AdminDraft>>({});
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  // Which card has its diff expanded (only meaningful once prepared).
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [splitView, setSplitView] = useState(true);

  const publisher = useBulkRunner<UploadResult>({
    invalidate: [["refresh"], ["pending-prs"], ["pr-history"]],
    summaryTitle: "Publication",
    notify: true,
    taskKind: "publish",
  });

  // A single skill pushed from the Skills tab: scroll to it and mark it out.
  const focusFolder =
    (location.state as { focus?: string } | null)?.focus ?? null;
  const focusRef = useRef<HTMLDivElement | null>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusFolder || scrolledFor.current === location.key) return;
    if (!focusRef.current) return;
    scrolledFor.current = location.key;
    focusRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusFolder, location.key, groups]);

  // Seed the tick marks once per navigation: everything publishable, or just
  // what the Skills tab handed over when the user arrived through "Publier".
  // Once per navigation and not on every `groups` change, otherwise a
  // background refresh would silently re-tick what the user just unticked.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededFor.current === location.key) return;
    // The store may still be empty on first mount; seed when data lands.
    if (groups.length === 0) return;
    seededFor.current = location.key;
    const requested = (location.state as { folders?: string[] } | null)?.folders;
    const publishable = groups
      .filter((g) => g.editable)
      .flatMap((g) => g.items.map((i) => i.folder));
    const wanted = requested?.length ? new Set(requested) : null;
    setTicked(
      new Set(wanted ? publishable.filter((f) => wanted.has(f)) : publishable)
    );
  }, [groups, location.key, location.state]);

  const settingsFor = (key: string) => settings[key] ?? DEFAULT_SETTINGS;
  const patchSettings = (key: string, patch: Partial<GroupSettings>) =>
    setSettings((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? DEFAULT_SETTINGS), ...patch },
    }));

  const toggleItem = (folder: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  const toggleGroup = (g: ChangeGroup) => {
    const all = g.items.every((i) => ticked.has(i.folder));
    setTicked((prev) => {
      const next = new Set(prev);
      for (const i of g.items) {
        if (all) next.delete(i.folder);
        else next.add(i.folder);
      }
      return next;
    });
  };

  const selectedGroups = useMemo(
    () =>
      groups.filter(
        (g) => g.editable && g.items.some((i) => ticked.has(i.folder))
      ),
    [groups, ticked]
  );

  const tickedCount = useMemo(
    () =>
      groups.reduce(
        (n, g) => n + g.items.filter((i) => ticked.has(i.folder)).length,
        0
      ),
    [groups, ticked]
  );

  // Every group must carry release notes: they land in the PR body, and an
  // empty one makes the merged change unreadable a month later.
  const missingNotes = selectedGroups.filter(
    (g) => !settingsFor(g.key).notes.trim()
  );

  const ready = Object.keys(drafts).length > 0;

  const prepare = async () => {
    setPreparing(true);
    setPrepareError(null);
    // Preparing reads the plugin's whole remote tree once per group and diffs
    // every ticked skill against it — seconds per group over a VPN-gated Gitea,
    // with nothing on screen but a disabled button until now.
    const progress = useProgress.getState();
    const taskId = progress.begin({
      kind: "publish",
      label: "Préparation des PR",
      detail: `0/${selectedGroups.length}`,
      pct: 0,
    });
    try {
      const built: Record<string, AdminDraft> = {};
      for (const g of selectedGroups) {
        useProgress.getState().update(taskId, {
          detail: `${Object.keys(built).length + 1}/${selectedGroups.length} · ${g.plugin.name}`,
          pct: Math.round(
            (Object.keys(built).length / selectedGroups.length) * 100
          ),
        });
        const chosen = g.items.filter((i) => ticked.has(i.folder));
        const cfg = settingsFor(g.key);
        built[g.key] = await api.adminPrepareUploadSkills({
          marketplace: g.marketplace.name,
          pluginName: g.plugin.name,
          items: chosen
            .filter((i) => i.status !== "deleted")
            .map((i) => ({
              localFolder: i.folder,
              targetName: i.targetName,
            })),
          removals: chosen
            .filter((i) => i.status === "deleted")
            .map((i) => i.targetName),
          bumpLevel: cfg.bumpLevel,
          versionDescription: cfg.notes.trim(),
        });
      }
      setDrafts(built);
      setOpenDiff(selectedGroups[0]?.key ?? null);
    } catch (e) {
      setPrepareError(errMsg(e));
    } finally {
      useProgress.getState().end(taskId);
      setPreparing(false);
    }
  };

  const publish = () => {
    const ops: BulkOp<UploadResult>[] = selectedGroups
      .filter((g) => drafts[g.key])
      .map((g) => ({
        id: g.key,
        label: `${g.plugin.name} · ${g.marketplace.name}`,
        run: async () => {
          const res = await api.adminSubmitDraft(drafts[g.key]);
          // The PR is open: what is on disk now matches what was pushed, so
          // stop nudging. A deleted skill has no folder left — the backend
          // drops its reference instead of marking it.
          for (const i of g.items) {
            if (!ticked.has(i.folder)) continue;
            await api.skillMarkSynced(i.folder).catch(() => {});
            setSyncOne(i.folder, "synced");
          }
          return res;
        },
      }));
    // The runner already invalidates the refresh once the batch is done.
    void publisher.run(ops).then(() => setDrafts({}));
  };

  return (
    <div className="panel flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <UploadCloud className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          Changements en attente
        </h2>
        {ready && (
          <DiffViewToggle splitView={splitView} onChange={setSplitView} />
        )}
        {tickedCount > 0 && (
          <Badge variant="outline" className="shrink-0">
            {tickedCount} coché{tickedCount > 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      <ScrollFade className="flex-1" wraps>
        <ScrollArea className="h-full">
        <div className="space-y-4 p-4">
          {groups.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-16 text-center text-sm text-muted-foreground">
              <CheckCircle2 className="h-6 w-6 text-emerald-500/60" />
              <span>Aucun changement en attente.</span>
              <span className="text-xs">
                Modifiez, ajoutez ou supprimez une compétence d'un plugin
                installé et elle apparaîtra ici.
              </span>
            </div>
          )}

          {groups.map((g) => {
            const cfg = settingsFor(g.key);
            const groupTicked = g.items.filter((i) =>
              ticked.has(i.folder)
            ).length;
            const draft = drafts[g.key];
            const diffOpen = openDiff === g.key;
            return (
              <div key={g.key} className="overflow-hidden rounded-md border">
                <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
                  {g.editable ? (
                    <Checkbox
                      checked={groupTicked === g.items.length}
                      indeterminate={
                        groupTicked > 0 && groupTicked < g.items.length
                      }
                      // Drafts are built from the ticks: freeze them once
                      // prepared, or the PR would not match the preview.
                      disabled={ready}
                      aria-label={`Tout cocher pour ${g.plugin.name}`}
                      onChange={() => toggleGroup(g)}
                    />
                  ) : (
                    <Lock
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  )}
                  <Package className="h-4 w-4 shrink-0 text-amber-400/80" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {g.plugin.name}
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      · {g.marketplace.name}
                    </span>
                  </span>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {g.items.length} changement{g.items.length > 1 ? "s" : ""}
                  </Badge>
                  {draft && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 gap-1 px-2 text-xs"
                      onClick={() => setOpenDiff(diffOpen ? null : g.key)}
                    >
                      {diffOpen ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                      {diffOpen ? "Masquer le diff" : "Voir le diff"}
                    </Button>
                  )}
                </div>

                {!g.editable && (
                  <p className="border-b bg-muted/10 px-3 py-1.5 text-xs text-muted-foreground">
                    {g.marketplace.sourceRepo
                      ? "Pas de droit de push sur ce dépôt — les changements restent listés, mais aucune PR ne peut être ouverte d'ici."
                      : "Aucun dépôt source connu pour ce marketplace."}
                  </p>
                )}

                <div className="divide-y">
                  {g.items.map((i) => {
                    const meta = STATUS_META[i.status];
                    const Icon = meta?.Icon ?? Pencil;
                    return (
                      <div
                        key={i.folder}
                        ref={i.folder === focusFolder ? focusRef : undefined}
                        className={`flex items-center gap-3 border-l-2 px-3 py-2 text-sm transition-colors ${
                          ticked.has(i.folder)
                            ? "border-l-primary bg-primary/10"
                            : "border-l-transparent"
                        } ${
                          i.folder === focusFolder
                            ? "ring-1 ring-inset ring-primary/40"
                            : ""
                        }`}
                      >
                        <Checkbox
                          checked={ticked.has(i.folder)}
                          disabled={!g.editable || ready}
                          aria-label={`Publier ${i.skillName}`}
                          onChange={() => toggleItem(i.folder)}
                        />
                        <span
                          className={`inline-flex w-24 shrink-0 items-center gap-1 text-xs ${
                            meta?.className ?? ""
                          }`}
                        >
                          <Icon className="h-3 w-3 shrink-0" />
                          {meta?.label ?? i.status}
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate font-medium"
                          title={i.folder}
                        >
                          {i.skillName}
                        </span>
                        {/* Read-only: the repo path is the local folder name.
                            Renaming here would create a second copy upstream
                            instead of updating the existing skill. */}
                        <code
                          className="shrink-0 text-xs text-muted-foreground"
                          title="Chemin dans le dépôt"
                        >
                          skills/{i.targetName}
                        </code>
                      </div>
                    );
                  })}
                </div>

                {g.editable && groupTicked > 0 && (
                  <div className="flex flex-wrap items-start gap-3 border-t px-3 py-2">
                    <div className="flex items-center gap-1">
                      <span className="mr-1 text-xs text-muted-foreground">
                        Version
                      </span>
                      {(["patch", "minor", "major"] as const).map((lvl) => (
                        <Button
                          key={lvl}
                          type="button"
                          size="sm"
                          variant={cfg.bumpLevel === lvl ? "default" : "outline"}
                          className="h-7 px-3 text-xs"
                          disabled={ready}
                          onClick={() => patchSettings(g.key, { bumpLevel: lvl })}
                        >
                          {lvl}
                        </Button>
                      ))}
                    </div>
                    <Textarea
                      placeholder="Notes de version — apparaîtront dans la PR (obligatoire)"
                      value={cfg.notes}
                      onChange={(e) =>
                        patchSettings(g.key, { notes: e.target.value })
                      }
                      rows={2}
                      disabled={ready}
                      className="min-w-[16rem] flex-1 text-xs"
                    />
                  </div>
                )}

                {draft && (
                  <div className="border-t bg-muted/20">
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{draft.prTitle}</span>
                      <span className="text-muted-foreground">
                        <code>{draft.targetRepo}</code> → <code>{draft.branchName}</code>{" "}
                        sur <code>{draft.baseBranch}</code>
                      </span>
                      <Badge variant="outline">
                        {draft.changes.length} fichier(s)
                      </Badge>
                      {draft.deletions.length > 0 && (
                        <Badge variant="outline">
                          {draft.deletions.length} suppression(s)
                        </Badge>
                      )}
                    </div>

                    {draft.problems.length > 0 && (
                      <div className="mx-3 mb-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-600">
                        <div className="flex items-center gap-1 font-medium">
                          <AlertCircle className="h-3.5 w-3.5" />
                          Problèmes de validation
                        </div>
                        <ul className="ml-4 list-disc">
                          {draft.problems.map((p, i) => (
                            <li key={i}>{p}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {draft.conflicts.length > 0 && (
                      <div className="mx-3 mb-2 space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                        <div className="flex items-center gap-1 font-medium">
                          <AlertCircle className="h-3.5 w-3.5" />
                          PR ouvertes touchant les mêmes fichiers
                        </div>
                        <ul className="space-y-0.5">
                          {draft.conflicts.map((c) => (
                            <li key={c.prNumber} className="flex items-center gap-1">
                              <Badge variant="outline">#{c.prNumber}</Badge>
                              <span className="min-w-0 flex-1 truncate">
                                {c.title}
                              </span>
                              <button
                                type="button"
                                onClick={() => openExternal(c.url)}
                              >
                                <ExternalLink className="h-3 w-3" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {diffOpen && (
                      <div className="space-y-2 px-3 pb-3">
                        {draft.entries.map((e, i) => (
                          <FileDiff
                            key={`${e.path}-${i}`}
                            entry={e}
                            splitView={splitView}
                            defaultOpen={draft.entries.length <= 3}
                          />
                        ))}
                        <div>
                          <div className="mb-1 text-xs font-medium">
                            Corps de la PR
                          </div>
                          <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                            {draft.prBody}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </ScrollArea>
      </ScrollFade>

      <div className="space-y-2 border-t bg-card px-4 py-2">
        {prepareError && (
          <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <pre className="min-w-0 whitespace-pre-wrap">{prepareError}</pre>
          </div>
        )}

        {/* Outcome of the last run. It lives here, not on the group cards: a
            published group leaves the list (its skills are synced again), and
            the PR link has to survive that. */}
        {publisher.results.length > 0 && (
          <div className="space-y-1 rounded-md border p-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-xs font-medium">
                Publication — {publisher.results.filter((r) => r.ok).length}/
                {publisher.results.length}
              </span>
              {!publisher.running && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1 text-xs"
                  onClick={publisher.reset}
                >
                  Fermer
                </Button>
              )}
            </div>
            <ul className="max-h-32 space-y-0.5 overflow-auto text-xs">
              {publisher.results.map((r) => (
                <li
                  key={r.id}
                  className={`flex items-center gap-1.5 ${
                    r.ok
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-destructive"
                  }`}
                >
                  {r.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={r.ok ? r.label : r.error}
                  >
                    {r.label}
                    {r.ok ? ` — PR #${r.value?.prNumber}` : ` — ${r.error}`}
                  </span>
                  {r.ok && r.value && (
                    <button
                      type="button"
                      onClick={() => openExternal(r.value!.prUrl)}
                      title="Ouvrir la PR"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center gap-2">
          {missingNotes.length > 0 && !ready && (
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              Notes de version manquantes pour {missingNotes.length} groupe
              {missingNotes.length > 1 ? "s" : ""}.
            </p>
          )}
          {publisher.running ? (
            <>
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">
                {publisher.done}/{publisher.total}
                {publisher.current ? ` · ${publisher.current}` : ""}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 px-3 text-xs"
                onClick={publisher.cancel}
              >
                Annuler
              </Button>
            </>
          ) : ready ? (
            <>
              <span className="min-w-0 flex-1" />
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 px-3 text-xs"
                onClick={() => setDrafts({})}
              >
                Retour
              </Button>
              <Button
                size="sm"
                className="h-8 shrink-0 px-3 text-xs"
                onClick={publish}
              >
                <UploadCloud className="mr-1 h-3.5 w-3.5" />
                Publier {Object.keys(drafts).length} PR
              </Button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1" />
              <Button
                size="sm"
                className="h-8 shrink-0 px-3 text-xs"
                disabled={
                  selectedGroups.length === 0 ||
                  missingNotes.length > 0 ||
                  preparing
                }
                onClick={prepare}
              >
                {preparing && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                Préparer {selectedGroups.length} PR
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

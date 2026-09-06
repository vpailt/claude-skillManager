import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Package,
  Sparkles,
  Globe,
  ArrowRight,
  Settings as SettingsIcon,
} from "lucide-react";
import { useApp } from "@/stores/app";
import { useSettingsDialog } from "@/stores/settingsDialog";
import { useOrgSync } from "@/stores/orgSync";
import { cn } from "@/lib/utils";

// Typing this exact string and pressing Enter on an empty result list opens the
// Gitea → GitHub comparison. Deliberately not an `Item`: keeping it out of the
// list is what makes it undiscoverable, and Enter on no results was a no-op.
const HIDDEN_ORG_SYNC_QUERY = "sforge-labs";

/** How many results the panel will show. Past this, refine the query. */
const MAX_RESULTS = 60;

type Group = "nav" | "marketplace" | "plugin" | "skill";

const GROUP_LABEL: Record<Group, string> = {
  nav: "Aller à",
  marketplace: "Marketplaces",
  plugin: "Plugins",
  skill: "Skills",
};

/** Render order of the groups — most specific last, as the tree reads. */
const GROUP_ORDER: Group[] = ["nav", "marketplace", "plugin", "skill"];

interface Item {
  group: Group;
  /** What the user is looking for: a page name, a skill name. */
  label: string;
  /** Where it lives — "plugin · marketplace". Greyed, next to the label. */
  hint?: string;
  /**
   * Matched on but never shown — a skill's description, so looking for what a
   * skill *does* works, not only for what it is called. The Skills tree's own
   * search box did that, and this field is what lets this one replace it.
   */
  search?: string;
  run: (ctx: RunContext) => void;
}

interface RunContext {
  navigate: (path: string) => void;
  openSettings: (section: "general") => void;
  select: (sel: Parameters<ReturnType<typeof useApp.getState>["setSelection"]>[0]) => void;
}

function IconFor({ group }: { group: Group }) {
  const cls = "h-3.5 w-3.5 shrink-0 opacity-80";
  if (group === "marketplace") return <Globe className={cls} />;
  if (group === "plugin") return <Package className={cls} />;
  if (group === "skill") return <Sparkles className={cls} />;
  return <ArrowRight className={cls} />;
}

const PAGES: Item[] = [
  { group: "nav", label: "Dashboard", run: (c) => c.navigate("/") },
  { group: "nav", label: "Skills", run: (c) => c.navigate("/skills") },
  { group: "nav", label: "Changements", run: (c) => c.navigate("/changes") },
  {
    group: "nav",
    label: "Suivi marketplace",
    run: (c) => c.navigate("/tracking"),
  },
  {
    group: "nav",
    label: "Audit d'utilisation",
    run: (c) => c.navigate("/audit"),
  },
  { group: "nav", label: "Activités récentes", run: (c) => c.navigate("/activity") },
  { group: "nav", label: "Logs", run: (c) => c.navigate("/logs") },
  // Settings is a dialog, not a route, so it runs its own opener rather than
  // pretending to be a "/settings" path that does not exist.
  {
    group: "nav",
    label: "Paramètres",
    run: (c) => c.openSettings("general"),
  },
];

/**
 * The input the module-scoped [`focusSearch`] talks to. There is exactly one
 * search box in the app — it lives in the title bar — so a module-level handle
 * beats threading a ref through the tree or inventing a store for a single
 * imperative call. Mirrors how `hooks/useRefresh` exposes `forceRefresh`.
 */
let inputEl: HTMLInputElement | null = null;

/** Put the caret in the search field — Ctrl+K, and the Affichage menu. */
export function focusSearch() {
  inputEl?.focus();
  inputEl?.select();
}

/**
 * Search, as a field rather than a dialog: you type straight into the title bar
 * and the results drop underneath it, anchored to the field and the same width.
 *
 * The panel opens on focus, not on the first keystroke — an empty query lists
 * the pages, which is the fastest way to reach one and what makes the field
 * worth clicking at all.
 */
export function SearchBox() {
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  const setSelection = useApp((s) => s.setSelection);
  const openSettings = useSettingsDialog((s) => s.openTo);
  const openOrgSync = useOrgSync((s) => s.setOpen);
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Anything outside the field and its panel closes it — the panel overlays the
  // page, so leaving it up while the user works elsewhere would be in the way.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [...PAGES];
    const sources = [...marketplaces];
    if (localOnly) sources.push(localOnly);
    for (const m of sources) {
      all.push({
        group: "marketplace",
        label: m.name,
        run: (c) => {
          c.select({ kind: "marketplace", marketplace: m.name });
          c.navigate("/skills");
        },
      });
      for (const p of m.plugins) {
        all.push({
          group: "plugin",
          label: p.name,
          hint: m.name,
          run: (c) => {
            c.select({ kind: "plugin", marketplace: m.name, plugin: p.name });
            c.navigate("/skills");
          },
        });
        for (const s of p.skills) {
          all.push({
            group: "skill",
            label: s.name,
            hint: `${p.name} · ${m.name}`,
            search: s.description ?? undefined,
            run: (c) => {
              c.select({
                kind: "skill",
                marketplace: m.name,
                plugin: p.name,
                skill: s.name,
              });
              c.navigate("/skills");
            },
          });
        }
      }
    }
    return all;
  }, [marketplaces, localOnly]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // An empty query is not "everything": it is the pages, which is what a
    // freshly focused field should offer.
    if (!needle) return PAGES;
    return items
      .filter(
        (it) =>
          it.label.toLowerCase().includes(needle) ||
          it.hint?.toLowerCase().includes(needle) ||
          it.search?.toLowerCase().includes(needle)
      )
      .slice(0, MAX_RESULTS);
  }, [items, q]);

  // Grouped for display, but the cursor walks the flat list: arrowing through a
  // list must not have to know where a heading sits.
  const ordered = useMemo(() => {
    const out: Item[] = [];
    for (const g of GROUP_ORDER) out.push(...filtered.filter((i) => i.group === g));
    return out;
  }, [filtered]);

  useEffect(() => {
    if (cursor >= ordered.length) setCursor(0);
  }, [cursor, ordered.length]);

  // Keep the highlighted row in view when the cursor is driven by the keyboard.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const close = () => {
    setOpen(false);
    setQ("");
    setCursor(0);
  };

  const run = (it: Item) => {
    it.run({ navigate, openSettings, select: setSelection });
    close();
    inputEl?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setCursor((c) => Math.min(c + 1, ordered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (ordered[cursor]) {
        run(ordered[cursor]);
      } else if (q.trim().toLowerCase() === HIDDEN_ORG_SYNC_QUERY) {
        openOrgSync(true);
        close();
        inputEl?.blur();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      inputEl?.blur();
    }
  };

  // Flat index as we render group by group, so `data-idx` matches `cursor`.
  let idx = -1;

  return (
    <div ref={rootRef} className="relative w-full max-w-[34rem]">
      <div
        className={cn(
          "flex h-7 items-center gap-2 rounded-md border px-2 text-xs transition-colors",
          open
            ? "border-primary/60 bg-background"
            : "border-border/70 bg-background/60 hover:border-border hover:bg-background"
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={(el) => {
            inputEl = el;
          }}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Rechercher une page, un marketplace, un plugin, un skill…"
          aria-label="Rechercher"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
        {!open && (
          <kbd className="shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground">
            Ctrl+K
          </kbd>
        )}
      </div>

      {open && (
        <div
          ref={listRef}
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-md border bg-card py-1 text-card-foreground shadow-xl"
        >
          {ordered.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              Aucun résultat pour « {q.trim()} »
            </div>
          )}
          {GROUP_ORDER.map((g) => {
            const rows = filtered.filter((i) => i.group === g);
            if (rows.length === 0) return null;
            return (
              <div key={g}>
                <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  {GROUP_LABEL[g]}
                </div>
                {rows.map((it) => {
                  idx += 1;
                  const here = idx;
                  return (
                    <button
                      key={`${g}-${it.label}-${it.hint ?? ""}-${here}`}
                      type="button"
                      data-idx={here}
                      // `onMouseDown` prevented: the field must keep the focus,
                      // or the outside-click handler closes the panel before the
                      // click that opened a row ever lands.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setCursor(here)}
                      onClick={() => run(it)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                        here === cursor
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-accent"
                      )}
                    >
                      <IconFor group={g} />
                      <span className="truncate">{it.label}</span>
                      {it.hint && (
                        <span
                          className={cn(
                            "truncate text-xs",
                            here === cursor
                              ? "text-primary-foreground/70"
                              : "text-muted-foreground"
                          )}
                        >
                          {it.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useApp } from "@/stores/app";
import { useSettingsDialog } from "@/stores/settingsDialog";
import { cn } from "@/lib/utils";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Item =
  | { kind: "page"; label: string; path: string }
  | { kind: "settings"; label: string }
  | {
      kind: "marketplace";
      label: string;
      marketplace: string;
    }
  | {
      kind: "plugin";
      label: string;
      marketplace: string;
      plugin: string;
    }
  | {
      kind: "skill";
      label: string;
      marketplace: string;
      plugin: string;
      skill: string;
    };

// Settings is a dialog, not a route, so it's modeled as its own item kind
// rather than overloading a (now non-existent) "/settings" route path.
const PAGES: Item[] = [
  { kind: "page", label: "Dashboard", path: "/" },
  { kind: "page", label: "Skills", path: "/skills" },
  { kind: "page", label: "Administration", path: "/admin" },
  { kind: "settings", label: "Paramètres" },
];

function IconFor({ item }: { item: Item }) {
  if (item.kind === "page") return <ArrowRight className="h-3.5 w-3.5" />;
  if (item.kind === "settings") return <SettingsIcon className="h-3.5 w-3.5" />;
  if (item.kind === "marketplace") return <Globe className="h-3.5 w-3.5" />;
  if (item.kind === "plugin") return <Package className="h-3.5 w-3.5" />;
  return <Sparkles className="h-3.5 w-3.5" />;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const marketplaces = useApp((s) => s.marketplaces);
  const localOnly = useApp((s) => s.localOnly);
  const setSelection = useApp((s) => s.setSelection);
  const openSettings = useSettingsDialog((s) => s.openTo);
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [...PAGES];
    const sources = [...marketplaces];
    if (localOnly) sources.push(localOnly);
    for (const m of sources) {
      all.push({
        kind: "marketplace",
        label: m.name,
        marketplace: m.name,
      });
      for (const p of m.plugins) {
        all.push({
          kind: "plugin",
          label: `${p.name} · ${m.name}`,
          marketplace: m.name,
          plugin: p.name,
        });
        for (const s of p.skills) {
          all.push({
            kind: "skill",
            label: `${s.name} · ${p.name} · ${m.name}`,
            marketplace: m.name,
            plugin: p.name,
            skill: s.name,
          });
        }
      }
    }
    return all;
  }, [marketplaces, localOnly]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items.slice(0, 30);
    return items
      .filter((it) => it.label.toLowerCase().includes(needle))
      .slice(0, 50);
  }, [items, q]);

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(0);
  }, [cursor, filtered.length]);

  const run = (it: Item) => {
    if (it.kind === "settings") {
      // Settings is a dialog, not a route — pop it on its default section.
      openSettings("general");
    } else if (it.kind === "page") {
      navigate(it.path);
    } else if (it.kind === "marketplace") {
      setSelection({ kind: "marketplace", marketplace: it.marketplace });
      navigate("/skills");
    } else if (it.kind === "plugin") {
      setSelection({
        kind: "plugin",
        marketplace: it.marketplace,
        plugin: it.plugin,
      });
      navigate("/skills");
    } else if (it.kind === "skill") {
      setSelection({
        kind: "skill",
        marketplace: it.marketplace,
        plugin: it.plugin,
        skill: it.skill,
      });
      navigate("/skills");
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 p-0">
        <DialogTitle className="sr-only">Palette de commandes</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            placeholder="Accédez à une page, un marketplace, un plugin ou un skill…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (filtered[cursor]) run(filtered[cursor]);
              } else if (e.key === "Escape") {
                onOpenChange(false);
              }
            }}
            className="border-none px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              Aucun résultat
            </div>
          )}
          {filtered.map((it, idx) => (
            <button
              key={`${it.kind}-${it.label}-${idx}`}
              type="button"
              onMouseEnter={() => setCursor(idx)}
              onClick={() => run(it)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                idx === cursor ? "bg-accent" : "hover:bg-accent/50"
              )}
            >
              <IconFor item={it} />
              <span className="truncate">{it.label}</span>
              <span className="ml-auto text-xs uppercase tracking-wide text-muted-foreground">
                {it.kind}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

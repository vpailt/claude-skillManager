// The bell at the right end of the status bar, and the panel behind it.
//
// Toasts expire after eight seconds. That is right for a toast and wrong for
// the information in it: an install that failed while the user was on another
// tab, or a PR whose link they meant to click, used to be gone with no way
// back. `stores/notifications` now keeps every notification in a `history` the
// toast timer does not touch, and this is where that list is read.
//
// Hand-rolled rather than a `DropdownMenu`: every row here carries its own ×,
// and a menu closes on any item activation — dismissing one notification would
// shut the panel each time.
import { useEffect, useRef } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Info,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNotifications } from "@/stores/notifications";

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const TONES = {
  info: "text-sky-500",
  success: "text-emerald-500",
  warning: "text-amber-500",
  error: "text-destructive",
};

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "à l'instant";
  if (diff < 3_600_000) return `il y a ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `il y a ${Math.floor(diff / 3_600_000)} h`;
  return `il y a ${Math.floor(diff / 86_400_000)} j`;
}

export function NotificationCenter({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const history = useNotifications((s) => s.history);
  const unread = useNotifications((s) => s.unread);
  const dismissHistory = useNotifications((s) => s.dismissHistory);
  const clearHistory = useNotifications((s) => s.clearHistory);
  const markRead = useNotifications((s) => s.markRead);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Opening is what marks the badge read — not rendering, so a panel left open
  // still counts what arrives behind it until the next time it is opened.
  useEffect(() => {
    if (open) markRead();
  }, [open, markRead]);

  // Click outside and Escape both close. `mousedown`, not `click`: a row's ×
  // removes itself from the DOM before `click` resolves, and the listener would
  // then see the event as landing outside the panel and close it too.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={wrapRef} className="relative flex items-stretch">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        title={
          history.length === 0
            ? "Notifications — aucune"
            : `Notifications — ${history.length} en mémoire${unread > 0 ? `, ${unread} nouvelle(s)` : ""}`
        }
        aria-label="Notifications"
        aria-expanded={open}
        // `my-1` + `rounded-md`, like the status bar's segments: the fill is a
        // pill inside the bar, not a block spanning its full height.
        className={cn(
          "my-1 flex items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
          open && "bg-accent text-accent-foreground"
        )}
      >
        <span className="relative">
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary ring-2 ring-card" />
          )}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Dernières notifications"
          // Anchored to the bar's bottom-right corner and growing upwards —
          // it is the last thing in the window, so there is nowhere else to go.
          className="absolute bottom-full right-0 z-50 mb-1 w-96 overflow-hidden rounded-md border bg-card shadow-lg"
        >
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span className="flex-1 text-xs font-semibold text-foreground">
              Notifications
            </span>
            {history.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Tout effacer
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Fermer le panneau"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {history.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Aucune notification
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {history.map((n) => {
                const Icon = ICONS[n.kind];
                return (
                  <li
                    key={n.id}
                    className="group flex items-start gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-accent/40"
                  >
                    <Icon
                      className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", TONES[n.kind])}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                          {n.title}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {relativeTime(n.createdAt)}
                        </span>
                      </div>
                      {n.body && (
                        <div className="mt-0.5 break-words text-[11px] text-muted-foreground">
                          {n.body}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => dismissHistory(n.id)}
                      aria-label={`Supprimer la notification : ${n.title}`}
                      className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

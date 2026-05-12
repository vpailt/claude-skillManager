import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useNotifications } from "@/stores/notifications";
import { cn } from "@/lib/utils";

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const TONES = {
  info: "border-sky-500/30 bg-sky-500/5 text-sky-600 dark:text-sky-300",
  success:
    "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300",
  warning:
    "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-300",
  error: "border-destructive/40 bg-destructive/5 text-destructive",
};

export function NotificationStack() {
  const items = useNotifications((s) => s.items);
  const dismiss = useNotifications((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {items.map((n) => {
        const Icon = ICONS[n.kind];
        return (
          <div
            key={n.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-md border bg-card/75 p-3 text-sm shadow-lg backdrop-blur-md supports-[backdrop-filter]:bg-card/60",
              TONES[n.kind]
            )}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-foreground">{n.title}</div>
              {n.body && (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {n.body}
                </div>
              )}
            </div>
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => dismiss(n.id)}
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

import { Download } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UpdateProgress } from "@/lib/types";

const PHASE_LABEL = {
  downloading: "Téléchargement",
  verifying: "Vérification de la signature",
  installing: "Installation",
} as const;

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

interface Props {
  progress: UpdateProgress | null;
  /** Inline (banner) or stacked (Settings card). */
  layout: "row" | "stacked";
}

/**
 * The one rendering of "an update is being installed", shared by the top banner
 * and the Settings card — they show the same three fields of the same store
 * slice, and keeping two copies is how they drifted (one gated the percentage
 * on the download phase, the other labelled "Vérification… 100 %").
 *
 * Accessibility: the container is **not** an `aria-live` region. Progress ticks
 * arrive every 120 ms, and a live region would have a screen reader read the
 * whole bar out continuously for the length of the download. The named
 * `role="progressbar"` is what carries the value, and `aria-valuetext` is what
 * makes it say something useful when the size is unknown.
 */
export function UpdateProgressBar({ progress, layout }: Props) {
  const phase = progress?.phase ?? "downloading";
  const total = progress?.total ?? 0;
  const done = progress?.downloaded ?? 0;
  // Unknown size (a CDN that sends no Content-Length): an indeterminate sliver
  // beats a bar pinned at 0 % for the whole transfer.
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  const downloading = phase === "downloading";
  const label = `${PHASE_LABEL[phase]}${downloading && pct !== null ? ` ${pct} %` : "…"}`;
  const counter = downloading && total > 0 ? `${mb(done)} / ${mb(total)}` : null;

  const bar = (
    <div
      className={cn(
        "h-1.5 overflow-hidden rounded-full bg-emerald-500/20",
        layout === "row" ? "min-w-0 flex-1" : "w-full"
      )}
      role="progressbar"
      aria-label="Progression de l'installation de la mise à jour"
      aria-valuenow={pct ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={pct === null ? "Progression inconnue" : `${pct} %`}
    >
      <div
        className={
          pct === null
            ? "h-full w-1/3 animate-pulse rounded-full bg-emerald-600"
            : "h-full rounded-full bg-emerald-600 transition-[width] duration-200"
        }
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );

  if (layout === "row") {
    return (
      <>
        <Download className="h-4 w-4 shrink-0 animate-pulse" />
        <span className="shrink-0">{label}</span>
        {bar}
        {counter && (
          <span className="shrink-0 text-xs tabular-nums opacity-80">{counter}</span>
        )}
      </>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span>{label}</span>
        {counter && <span className="tabular-nums opacity-80">{counter}</span>}
      </div>
      {bar}
    </div>
  );
}

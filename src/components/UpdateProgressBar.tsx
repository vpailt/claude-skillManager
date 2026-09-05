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
}

/**
 * The Settings card's rendering of "an update is being installed".
 *
 * It used to be shared with the top banner in an inline variant; the banner no
 * longer draws the download at all (the status bar does), so only the stacked
 * form survives. The status bar deliberately does not reuse this one: it is a
 * 24 px strip with its own type scale and a slot it shares with every other
 * running task, not a card.
 *
 * Accessibility: the container is **not** an `aria-live` region. Progress ticks
 * arrive every 120 ms, and a live region would have a screen reader read the
 * whole bar out continuously for the length of the download. The named
 * `role="progressbar"` is what carries the value, and `aria-valuetext` is what
 * makes it say something useful when the size is unknown.
 */
export function UpdateProgressBar({ progress }: Props) {
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
      className="h-1.5 w-full overflow-hidden rounded-full bg-emerald-500/20"
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

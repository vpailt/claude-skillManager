import { cn } from "@/lib/utils";

/**
 * One headline number with its label — the Logs page's API counters, and the
 * Audit page's totals.
 *
 * No plot, so no legend and no tooltip: the label *is* the explanation. The
 * value wears text ink rather than a series colour, and `tone` only ever marks
 * a state (a failure count that is not zero), never identity.
 */
export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "danger" | "muted";
}) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div
        className={cn(
          "text-xl font-semibold tabular-nums",
          tone === "danger" && "text-destructive",
          tone === "muted" && "text-muted-foreground"
        )}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint && <div className="text-[11px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}

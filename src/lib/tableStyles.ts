/**
 * The one table header style, shared by every page that lists rows read from
 * disk: Logs, Activités récentes, Audit d'utilisation.
 *
 * Sticky, because a header that scrolls away names the columns only for the
 * first screenful — and `z-20` so it sits *above* a `ScrollFade`'s top gradient
 * rather than being faded out by it.
 *
 * The bottom rule is an inset shadow, not a `border`: with `border-collapse`, a
 * sticky header's own border is left behind by the scroll and the row underneath
 * shows through where the rule should be.
 */
export const TH_ROW =
  "sticky top-0 z-20 bg-background font-sans text-[11px] uppercase tracking-wide text-muted-foreground";

export const TH =
  "px-3 py-1.5 text-left font-medium shadow-[inset_0_-1px_0_hsl(var(--border))]";

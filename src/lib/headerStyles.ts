/**
 * The one page-header bar, shared by every top-level tab: Dashboard, Skills,
 * Changements, Suivi marketplace, Audit d'utilisation, Activité, Logs.
 *
 * `min-h-12` rather than padding alone is what makes them the same height: a
 * bar carrying only a title would otherwise come out a dozen pixels shorter
 * than one carrying a button, which read as three different chromes when
 * tabbing between them.
 *
 * The vertical padding is `py-1`, not `py-2`, and that is the whole of it: the
 * box is `border-box`, so a `h-8` button under `py-2` measures 8 + 32 + 8 + 1
 * of bottom rule = 49 px and *overshoots* the 48 px floor — a one-pixel step
 * every time a header happened to carry a button. At `py-1` the tallest content
 * still clears the floor, so every bar is 48 px exactly and `flex-wrap` keeps
 * its room to grow on a narrow window.
 *
 * 48 px is also what the sidebar's Rafraîchir block is sized against, so its
 * separator lands on the same line as this bar's bottom rule.
 */
export const PAGE_HEADER =
  "flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1";

/**
 * The counterpart at the other end: the action bar closing a page (Changements'
 * Préparer / Publier row today).
 *
 * Its rule lines up with the one above the sidebar's Paramètres row, and the
 * arithmetic is that row's: a 36 px button under `py-2` is 52 px, plus the 1 px
 * separator above it = 53 px off the bottom of the window. The page column is
 * held off that bottom by the gutter, so this bar owns 53 px minus the gutter
 * and its own top rule falls exactly on the separator's line.
 */
export const PAGE_FOOTER =
  "flex min-h-[calc(53px-var(--gutter))] shrink-0 flex-col justify-center gap-2 border-t px-4 py-1";

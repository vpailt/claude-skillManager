/**
 * The one page-header bar, shared by every top-level tab: Dashboard, Skills,
 * Changements, Suivi marketplace, Audit d'utilisation, Activité, Logs.
 *
 * `min-h-12` rather than padding alone is what makes them the same height. The
 * pages carrying a button (`h-8` + `py-2` = 48 px) set the tallness, and the
 * ones carrying only a title used to come out a dozen pixels shorter — which
 * read as three different chromes when tabbing between them. The floor holds
 * them level; `flex-wrap` still lets a crowded bar grow on a narrow window
 * rather than clipping.
 *
 * 48 px is also what the sidebar's Rafraîchir block is sized against, so its
 * separator lands on the same line as this bar's bottom rule.
 */
export const PAGE_HEADER =
  "flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2";

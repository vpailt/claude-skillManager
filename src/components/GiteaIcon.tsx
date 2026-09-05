/**
 * Gitea mark, drawn in the lucide idiom (24×24 viewbox, `currentColor` stroke,
 * 2px width) so it sits next to `Github` in the status bar without looking
 * pasted in from another set.
 *
 * Deliberately a stroke drawing rather than the official filled logo: the bar
 * colours these icons to carry the connection state (green / red), and a
 * multi-colour brand asset cannot do that.
 */
export function GiteaIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* The cup — Gitea, "a cup of tea". */}
      <path d="M4 9h11v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" />
      <path d="M15 11h1.5a2.5 2.5 0 0 1 0 5H15" />
      {/* The git graph steeping in it: two commits and a branch. */}
      <circle cx="8" cy="12.5" r="1" />
      <circle cx="11.5" cy="15.5" r="1" />
      <path d="m8.7 13.2 2.1 1.6" />
      {/* Steam. */}
      <path d="M8 5.5V4" />
      <path d="M11.5 5.5V4" />
    </svg>
  );
}

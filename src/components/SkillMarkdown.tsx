// Lazy boundary around the actual renderer.
//
// `SkillMarkdownView` drags in react-markdown, remark-gfm, rehype-highlight and
// (through lowlight) highlight.js — together the heaviest thing the frontend
// depends on, and needed only once you open a skill. Keeping the import behind
// `React.lazy` keeps all of it out of the entry chunk; the module is fetched the
// first time a skill body is displayed and cached from then on.
//
// The public API is unchanged, so call sites don't know the difference.
import { lazy, Suspense } from "react";
import type { SkillMarkdownProps } from "./SkillMarkdownView";

const SkillMarkdownView = lazy(() => import("./SkillMarkdownView"));

export function SkillMarkdown(props: SkillMarkdownProps) {
  return (
    <Suspense
      fallback={
        <p className="px-1 py-2 text-sm text-muted-foreground">Chargement…</p>
      }
    >
      <SkillMarkdownView {...props} />
    </Suspense>
  );
}

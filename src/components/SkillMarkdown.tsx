import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";

interface SkillMarkdownProps {
  content: string;
  className?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitFrontmatter(raw: string): { body: string; frontmatter: string | null } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { body: raw, frontmatter: null };
  return { body: raw.slice(m[0].length), frontmatter: m[1] };
}

export function SkillMarkdown({ content, className }: SkillMarkdownProps) {
  const { body, frontmatter } = useMemo(() => splitFrontmatter(content), [content]);
  return (
    <div className={cn("prose-skill", className)}>
      {frontmatter && (
        <details className="mb-4 rounded-md border border-dashed border-border bg-muted/30">
          <summary className="cursor-pointer select-none px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Frontmatter
          </summary>
          <pre className="m-0 max-w-full overflow-x-auto rounded-none border-0 border-t border-border bg-transparent px-3 py-2 text-xs leading-relaxed text-foreground/80">
            <code className="bg-transparent p-0 text-xs">{frontmatter}</code>
          </pre>
        </details>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

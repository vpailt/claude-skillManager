import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface SkillMarkdownProps {
  content: string;
  className?: string;
}

export function SkillMarkdown({ content, className }: SkillMarkdownProps) {
  return (
    <div className={cn("prose-skill", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

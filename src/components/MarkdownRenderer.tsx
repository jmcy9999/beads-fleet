"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownRendererProps {
  content: string;
  accentColor?: "blue" | "purple";
}

const ACCENT_COLORS = {
  blue: "prose-blockquote:border-blue-500/50",
  purple: "prose-blockquote:border-purple-500/50",
} as const;

export function MarkdownRenderer({ content, accentColor = "blue" }: MarkdownRendererProps) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none
      prose-headings:text-gray-200 prose-headings:font-semibold
      prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
      prose-p:text-gray-300 prose-p:leading-relaxed
      prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
      prose-strong:text-gray-200
      prose-code:text-amber-300 prose-code:bg-surface-2 prose-code:rounded prose-code:px-1
      prose-pre:bg-surface-0 prose-pre:border prose-pre:border-border-default
      prose-table:text-sm
      prose-th:text-gray-400 prose-th:border-border-default
      prose-td:border-border-default
      prose-li:text-gray-300
      ${ACCENT_COLORS[accentColor]} prose-blockquote:text-gray-400
      prose-hr:border-border-default`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

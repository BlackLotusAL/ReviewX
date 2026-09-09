import ReactMarkdown from "react-markdown";
import { memo } from "react";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { safeMarkdownUrl } from "@/src/shared/markdown";

const markdownElements = [
  "p", "br", "strong", "em", "del", "blockquote", "ul", "ol", "li", "pre", "code", "span",
  "h1", "h2", "h3", "h4", "h5", "h6", "a", "img", "hr", "table", "thead", "tbody", "tr", "th", "td",
];

export const Markdown = memo(function Markdown({ children, className = "markdown" }: { children: string; className?: string }) {
  return <div className={className}><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeSanitize, [rehypeHighlight, { detect: false, plainText: ["text", "txt", "plaintext"] }]]} allowedElements={markdownElements} urlTransform={safeMarkdownUrl}
    components={{
      a: ({ href, children: contents }) => href
        ? <a href={href} target="_blank" rel="noreferrer noopener">{contents}</a>
        : <span className="blocked-resource">[链接已拦截] {contents}</span>,
      img: ({ src, alt }) => typeof src === "string" && src
        ? <a className="image-link" href={src} target="_blank" rel="noreferrer noopener">[图片链接] {alt || src}</a>
        : <span className="blocked-resource">[图片已拦截] {alt}</span>,
      table: ({ children: contents }) => <div className="markdown-table" role="region" aria-label="报告表格" tabIndex={0}><table>{contents}</table></div>,
    }}>{children}</ReactMarkdown></div>;
});

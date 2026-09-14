import { memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { createLowlight, common } from "lowlight";
import { Button } from "../button/button";
import { cn } from "../utils";

export interface ChatWorkItemReference {
  identifier: string;
  href: string;
  title?: string;
}

export interface ChatMarkdownProps {
  content: string;
  workItems?: ChatWorkItemReference[];
  labels?: {
    copyCode: string;
    copied: string;
    copyFailed: string;
    code: string;
    openImage: string;
  };
  className?: string;
}

const defaultLabels = {
  copyCode: "Copy code",
  copied: "Copied",
  copyFailed: "Copy failed",
  code: "Code",
  openImage: "Open image",
};

// Never inherit the sanitizer's broader default HTML surface. Inputs are only
// disabled GFM task checkboxes; model supplied forms and interactive controls vanish.
const schema = {
  tagNames: [
    "p",
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "input",
    "li",
    "ol",
    "pre",
    "s",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
    "details",
    "summary",
    "kbd",
    "sup",
    "sub",
    "mark",
    "b",
    "i",
  ],
  attributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    code: [["className", /^language-[\w-]+$/]],
    input: [["type", "checkbox"], "checked", "disabled"],
    ol: ["start"],
    li: [["className", "task-list-item"]],
    ul: [["className", "contains-task-list"]],
    td: ["align"],
    th: ["align"],
    details: ["open"],
  },
  required: { input: { type: "checkbox", disabled: true } },
  protocols: { href: ["http", "https", "mailto"], src: ["http", "https"] },
  strip: [
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "button",
    "textarea",
    "select",
    "svg",
    "math",
    "template",
    "noscript",
  ],
};

export function safeChatUrl(value: string, image = false): string | undefined {
  const url = value.trim();
  // Reject controls deliberately: browsers normalize some into executable URL schemes.
  // eslint-disable-next-line no-control-regex
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url)) return undefined;
  const protocol = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (protocol && !["http", "https", ...(image ? [] : ["mailto"])].includes(protocol)) return undefined;
  return url;
}

interface TreeNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
}

function referencePlugin(references: ChatWorkItemReference[]) {
  const items = new Map(
    references.filter((item) => item.identifier && safeChatUrl(item.href)).map((item) => [item.identifier, item])
  );
  const escaped = [...items.keys()]
    // eslint-disable-next-line unicorn/no-array-sort -- sort a fresh array; browser fixtures target pre-ES2023
    .sort((a, b) => b.length - a.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = escaped.length
    ? new RegExp(`(?<![\\p{L}\\p{N}_-])(${escaped.join("|")})(?![\\p{L}\\p{N}_-])`, "gu")
    : undefined;
  return () => (tree: TreeNode) => {
    if (!pattern) return;
    function visit(node: TreeNode) {
      if (["a", "code", "pre", "kbd"].includes(node.tagName ?? "") || !node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const value = child.value;
        const result: TreeNode[] = [];
        let offset = 0;
        for (const match of value.matchAll(pattern!)) {
          const item = items.get(match[0])!;
          if (match.index > offset) result.push({ type: "text", value: value.slice(offset, match.index) });
          result.push({
            type: "element",
            tagName: "a",
            properties: { href: item.href, ...(item.title ? { title: item.title } : {}) },
            children: [{ type: "text", value: match[0] }],
          });
          offset = match.index + match[0].length;
        }
        if (offset === 0) return [child];
        if (offset < value.length) result.push({ type: "text", value: value.slice(offset) });
        return result;
      });
    }
    visit(tree);
  };
}

const lowlight = createLowlight(common);
const MAX_HIGHLIGHT_LENGTH = 20_000;

function highlightedNodes(nodes: TreeNode[]): ReactNode {
  return nodes.map((node, index) =>
    node.type === "text" ? (
      node.value
    ) : (
      <span
        // Highlight spans are stateless, immutable output recreated for each code value.
        // eslint-disable-next-line react/no-array-index-key
        key={index}
        className={Array.isArray(node.properties?.className) ? node.properties.className.join(" ") : undefined}
      >
        {highlightedNodes(node.children ?? [])}
      </span>
    )
  );
}

const CodeBlock = memo(function CodeBlock({
  code,
  language,
  labels,
}: {
  code: string;
  language?: string;
  labels: typeof defaultLabels;
}) {
  const [status, setStatus] = useState<{ code: string; value: "copied" | "failed" }>();
  const highlighted = useMemo(() => {
    if (!language || code.length > MAX_HIGHLIGHT_LENGTH || !lowlight.registered(language)) return code;
    try {
      return highlightedNodes(lowlight.highlight(language, code).children as TreeNode[]);
    } catch {
      return code;
    }
  }, [code, language]);
  const state = status?.code === code ? status.value : undefined;
  async function copy() {
    try {
      // The shared utility silently succeeds when its legacy fallback fails.
      // Use the Clipboard API directly so the user receives an honest error state.
      await navigator.clipboard.writeText(code);
      setStatus({ code, value: "copied" });
    } catch {
      setStatus({ code, value: "failed" });
    }
  }
  return (
    <div className="chat-markdown-code">
      <div className="chat-markdown-code-header">
        <span>{language || labels.code}</span>
        <Button variant="neutral-primary" size="sm" onClick={() => void copy()} aria-label={labels.copyCode}>
          {state === "copied" ? labels.copied : state === "failed" ? labels.copyFailed : labels.copyCode}
        </Button>
        <span className="chat-markdown-sr-only" role="status">
          {state === "copied" ? labels.copied : state === "failed" ? labels.copyFailed : ""}
        </span>
      </div>
      <pre tabIndex={0} aria-label={language || labels.code}>
        <code className={language ? `language-${language}` : undefined}>{highlighted}</code>
      </pre>
    </div>
  );
});

function textContent(node: TreeNode): string {
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textContent).join("");
}

/** Store/router independent assistant Markdown. Import @plane/ui/styles/chat-markdown.css once. */
export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  workItems = [],
  labels = defaultLabels,
  className,
}: ChatMarkdownProps) {
  const references = useMemo(() => referencePlugin(workItems), [workItems]);
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, title }) => {
        const safeHref = href ? safeChatUrl(href) : undefined;
        if (!safeHref) return <span>{children}</span>;
        const external = /^(https?:|\/\/)/i.test(safeHref);
        return (
          <a
            href={safeHref}
            title={title}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
          >
            {children}
          </a>
        );
      },
      img: ({ src, alt, title }) => {
        const safeSrc = typeof src === "string" ? safeChatUrl(src, true) : undefined;
        if (!safeSrc) return alt ? <span>{alt}</span> : null;
        return (
          <a
            href={safeSrc}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${labels.openImage}${alt ? `: ${alt}` : ""}`}
          >
            <img
              src={safeSrc}
              alt={alt ?? ""}
              title={title}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
            />
          </a>
        );
      },
      input: ({ checked }) => (
        <input
          type="checkbox"
          checked={Boolean(checked)}
          disabled
          aria-label={checked ? "Completed task" : "Incomplete task"}
        />
      ),
      pre: ({ node }) => {
        const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
        const language =
          code?.type === "element"
            ? String(code.properties.className ?? "").match(/language-([\w-]+)/)?.[1]
            : undefined;
        return <CodeBlock code={node ? textContent(node as TreeNode) : ""} language={language} labels={labels} />;
      },
      table: ({ children }) => (
        <div className="chat-markdown-table" tabIndex={0}>
          <table>{children}</table>
        </div>
      ),
    }),
    [labels]
  );
  return (
    <div className={cn("chat-markdown", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema], references]}
        components={components}
        urlTransform={(url, key) => safeChatUrl(url, key === "src") ?? ""}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

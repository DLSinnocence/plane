# ChatMarkdown

A store- and router-independent renderer for assistant messages. Import the stylesheet once in the consuming application:

```tsx
import { ChatMarkdown, type ChatWorkItemReference } from "@plane/ui";
import "@plane/ui/styles/chat-markdown.css";

const workItems: ChatWorkItemReference[] = [
  { identifier: "ENG-42", href: "/workspace/projects/project/work-items/issue", title: "Improve chat" },
];

<ChatMarkdown content={streamingContent} workItems={workItems} />;
```

`content` is required. `workItems`, `className`, and `labels` are optional. Supply all five translated labels when overriding English defaults: `copyCode`, `copied`, `copyFailed`, `code`, and `openImage`. Memoize reference and label objects in streaming consumers when practical.

Only identifiers supplied through `workItems` become links. Matching is case-sensitive, respects identifier boundaries, preserves surrounding emphasis, and skips existing links and code. The renderer does not infer application routes.

GFM tables, task lists, strikethrough, CommonMark, and explicitly allowed HTML (including details/summary, kbd, sup/sub, and mark) are supported. Raw HTML is parsed and sanitized before React rendering; scripts, styles, forms, embedded documents, executable protocols, model-controlled classes/styles, and event handlers are removed. Highlighting constructs React spans from lowlight output and never injects HTML. Unknown languages and blocks longer than 20,000 characters remain plain text. Highlighting is memoized by code and language.

Images load lazily with no referrer, stay within the chat width, and link to the original image in a protected new tab. They may make remote requests when visible. Copy uses the Clipboard API and reports failures visibly and through a live status region; insecure contexts or denied clipboard permissions show the translated failure state.

Run `pnpm --filter @plane/ui test:chat-markdown` for the Node SSR security/semantics suite, `pnpm --filter @plane/ui check:types` for type checks, and inspect the `Chat/Markdown` Storybook stories for themes, overflow, images, unsafe HTML, and partial fences. The consuming application should verify clipboard interactions and layout in its browser integration tests.

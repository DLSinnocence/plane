import type { Meta, StoryObj } from "@storybook/react";
import { ChatMarkdown } from "./chat-markdown";
// Styles are a deliberate side-effect import for isolated stories.
// eslint-disable-next-line import/no-unassigned-import
import "../../styles/chat-markdown.css";

const meta: Meta<typeof ChatMarkdown> = {
  title: "Chat/Markdown",
  component: ChatMarkdown,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, padding: 20 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ChatMarkdown>;

export const RichResponse: Story = {
  args: {
    workItems: [{ identifier: "ENG-42", href: "/work-items/42", title: "Improve chat rendering" }],
    content: `## Release plan

Review **ENG-42** and ~~the previous draft~~.

- [x] Add Markdown rendering
- [ ] Verify accessibility
  - Test keyboard navigation

> Keep the message readable while it streams.

| Work item | Owner | Status |
| --- | --- | --- |
| ENG-42 | Morgan | In progress |
| ENG-43 | Sam | Planned |

\`\`\`typescript
const greeting: string = "Hello, Plane";
console.log(greeting);
\`\`\`

<details><summary>Implementation notes</summary><p>Press <kbd>Enter</kbd> to expand. Supports H<sub>2</sub>O and x<sup>2</sup>.</p></details>

[Documentation](https://plane.so) · [Contact](mailto:hello@example.com)
`,
  },
};

export const StreamingFence: Story = {
  args: { content: "Here is the implementation:\n\n```typescript\nfunction updateIssue(id: string) {\n  return" },
};
export const EmptyFence: Story = { args: { content: "```" } };
export const UnknownLanguage: Story = { args: { content: "```custom-dsl\nworkflow <safe> & readable\n```" } };
export const Overflow: Story = {
  args: {
    content: `\`\`\`json\n{"longValue":"${"wide-content-".repeat(60)}"}\n\`\`\`\n\n| ${Array.from({ length: 12 }, (_, i) => `Column ${i + 1}`).join(" | ")} |\n| ${"--- | ".repeat(12)}\n| ${"Long table value | ".repeat(12)}`,
  },
};
export const Images: Story = {
  args: {
    content:
      "![Plane logo](https://plane.so/favicon.ico)\n\n![Broken image with descriptive alternative](https://example.invalid/missing.png)",
  },
};
export const UnsafeHtml: Story = {
  args: {
    content:
      '<script>alert("removed")</script><style>body { display:none }</style><iframe src="https://example.com">hidden</iframe>\n\n<a href="javascript:alert(1)" onclick="alert(1)">Unsafe link</a>\n\n<mark>Safe HTML remains</mark><custom-tag>Plain text remains</custom-tag>',
  },
};
export const Dark: Story = {
  ...RichResponse,
  decorators: [
    (Story) => (
      <div
        data-theme="dark"
        style={{
          background: "var(--background-color-surface-1, #191b20)",
          color: "var(--text-color-primary, #eee)",
          padding: 20,
        }}
      >
        <Story />
      </div>
    ),
  ],
};

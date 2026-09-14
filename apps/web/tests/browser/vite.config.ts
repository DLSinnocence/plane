/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import applicationRoutes from "../../app/routes";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: path("./fixtures/"),
  cacheDir: path("../../node_modules/.vite-browser-components"),
  define: { "process.env": JSON.stringify({ NODE_ENV: "test" }) },
  plugins: [
    {
      name: "application-route-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === "virtual:attachment-peek-handler") return "\0virtual:attachment-peek-handler";
        if (
          importer?.endsWith("issue-detail-widgets/action-buttons.tsx") &&
          ["./links", "./relations", "./sub-issues"].includes(id)
        )
          return "\0virtual:hidden-widgets";
        if (id === "virtual:application-routes") return "\0virtual:application-routes";
      },
      load(id) {
        if (id === "\0virtual:hidden-widgets")
          return "export const IssueLinksActionButton = () => null; export const RelationActionButton = () => null; export const SubIssuesActionButton = () => null;";
        if (id === "\0virtual:attachment-peek-handler") {
          // Execute the production handler; do not maintain a copied Escape implementation.
          const source = ts.createSourceFile(
            "view.tsx",
            readFileSync(path("../../core/components/issues/peek-overview/view.tsx"), "utf8"),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TSX
          );
          let handler: string | undefined;
          const visit = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown" && node.initializer)
              handler = node.initializer.getText(source);
            ts.forEachChild(node, visit);
          };
          visit(source);
          if (!handler) throw new Error("Production peek Escape handler was not found");
          return ts.transpileModule(
            `export const createPeekEscapeHandler = (removeRoutePeekId: () => void) => {
            const isAnyModalOpen = false, isAnyEpicModalOpen = false, isAnyLocalModalOpen = false;
            const editorRef = { current: { isAnyDropbarOpen: () => false } }, issueId = 'issue';
            return ${handler};
          };`,
            { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
          ).outputText;
        }
        if (id === "\0virtual:application-routes") return `export default ${JSON.stringify(applicationRoutes)};`;
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^(?:.*\/)?archive-issue-modal$/, replacement: path("./fixtures/work-item-modals.tsx") },
      { find: /^(?:.*\/)?delete-issue-modal$/, replacement: path("./fixtures/work-item-modals.tsx") },
      { find: /^(?:.*\/)?issue-modal\/modal$/, replacement: path("./fixtures/work-item-modals.tsx") },
      { find: "@/hooks/store/use-command-palette", replacement: path("./fixtures/ai-state.ts") },
      { find: "@/hooks/store/use-issues", replacement: path("./fixtures/mocks.tsx") },
      { find: "@/hooks/store/use-issue-detail", replacement: path("./fixtures/attachment-state.ts") },
      { find: "@/hooks/use-file-size", replacement: path("./fixtures/attachment-state.ts") },
      { find: "@/hooks/use-platform-os", replacement: path("./fixtures/attachment-state.ts") },
      { find: "@/services/issue/attachment-template.service", replacement: path("./fixtures/attachment-state.ts") },
      { find: "@/hooks/store/use-member", replacement: path("./fixtures/mocks.tsx") },
      { find: "@/hooks/store/use-project", replacement: path("./fixtures/mocks.tsx") },
      { find: "@/hooks/store/use-project-state", replacement: path("./fixtures/mocks.tsx") },
      { find: "@/hooks/store/use-workspace", replacement: path("./fixtures/mocks.tsx") },
      { find: "@/hooks/use-app-router", replacement: path("./fixtures/mocks.tsx") },
      { find: "@/app", replacement: path("../../app") },
      { find: "@/helpers", replacement: path("../../helpers") },
      { find: "@/hooks/store/user", replacement: path("./fixtures/mocks.tsx") },
      { find: "@/components/workflow", replacement: path("./fixtures/mocks.tsx") },
      { find: "next/navigation", replacement: path("./fixtures/mocks.tsx") },
      { find: "next/link", replacement: path("./fixtures/mocks.tsx") },
      { find: "@plane/i18n", replacement: path("./fixtures/mocks.tsx") },
      {
        find: "@plane/ui/styles/chat-markdown.css",
        replacement: path("../../../../packages/ui/styles/chat-markdown.css"),
      },
      { find: "@plane/ui", replacement: path("./fixtures/ui.tsx") },
      { find: "@", replacement: path("../../core") },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: { fs: { allow: [path("../../../../")] } },
});

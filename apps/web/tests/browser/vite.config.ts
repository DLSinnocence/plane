/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import applicationRoutes from "../../app/routes";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: path("./fixtures/"),
  define: { "process.env": JSON.stringify({ NODE_ENV: "test" }) },
  plugins: [
    {
      name: "application-route-fixture",
      resolveId(id) {
        if (id === "virtual:application-routes") return "\0virtual:application-routes";
      },
      load(id) {
        if (id === "\0virtual:application-routes") return `export default ${JSON.stringify(applicationRoutes)};`;
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^(?:.*\/)?archive-issue-modal$/, replacement: path("./fixtures/work-item-modals.tsx") },
      { find: /^(?:.*\/)?delete-issue-modal$/, replacement: path("./fixtures/work-item-modals.tsx") },
      { find: /^(?:.*\/)?issue-modal\/modal$/, replacement: path("./fixtures/work-item-modals.tsx") },
      { find: "@/hooks/store/use-issues", replacement: path("./fixtures/mocks.tsx") },
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
      { find: "@plane/ui", replacement: path("./fixtures/ui.tsx") },
      { find: "@", replacement: path("../../core") },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: { fs: { allow: [path("../../../../")] } },
});

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// Isolated from the existing route fixture: root/list/card/create/activity renderers,
// localStorage/hash hooks, menus and the external Propel Collapsible are real.
export default defineConfig({
  root: path("./activity-fixtures/"),
  cacheDir: path("../../node_modules/.vite-browser-activity"),
  define: { "process.env": JSON.stringify({ NODE_ENV: "test" }) },
  plugins: [
    {
      name: "activity-operation-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === "./helper" && importer?.endsWith("/issue-activity/root.tsx"))
          return path("./activity-fixtures/state.ts");
      },
    },
  ],
  resolve: {
    alias: [
      {
        find: /^@\/hooks\/store\/(use-issue-detail|use-project|use-member|use-workspace|use-label|user)$/,
        replacement: path("./activity-fixtures/state.ts"),
      },
      { find: "@/hooks/use-platform-os", replacement: path("./activity-fixtures/state.ts") },
      { find: "@/components/relations", replacement: path("./activity-fixtures/state.ts") },
      { find: "@/services/file.service", replacement: path("./activity-fixtures/state.ts") },
      { find: "@/components/editor/lite-text", replacement: path("./activity-fixtures/editor.tsx") },
      { find: "@plane/i18n", replacement: path("./activity-fixtures/state.ts") },
      { find: /^@plane\/ui$/, replacement: path("./activity-fixtures/ui.ts") },
      { find: "next/navigation", replacement: path("./activity-fixtures/navigation.tsx") },
      { find: "next/link", replacement: path("./activity-fixtures/navigation.tsx") },
      { find: "@/helpers", replacement: path("../../helpers") },
      { find: "@", replacement: path("../../core") },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: { fs: { allow: [path("../../../../")] } },
});

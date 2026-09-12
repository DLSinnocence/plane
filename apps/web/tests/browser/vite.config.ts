/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  root: path("./fixtures/"),
  define: { "process.env": JSON.stringify({ NODE_ENV: "test" }) },
  resolve: {
    alias: [
      { find: "@/hooks/store/use-member", replacement: path("./fixtures/mocks.tsx") },
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

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import baseConfig from "./vite.config";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const baseAliases = Array.isArray(baseConfig.resolve?.alias) ? baseConfig.resolve.alias : [];

// This fixture uses the real translation singleton/resources and actual auth UI.
// The other fixture deliberately replaces translations with keys for route tests.
export default defineConfig({
  ...baseConfig,
  root: path("./language-fixtures/"),
  cacheDir: path("../../node_modules/.vite-browser-language"),
  resolve: {
    ...baseConfig.resolve,
    alias: [
      { find: "@/hooks/store/use-instance", replacement: path("./language-fixtures/instance.ts") },
      { find: "@plane/i18n", replacement: path("../../../../packages/i18n/src/index.ts") },
      { find: "@plane/ui", replacement: path("../../../../packages/ui/src/index.ts") },
      ...baseAliases.filter((entry) => entry.find !== "@plane/i18n" && entry.find !== "@plane/ui"),
    ],
  },
});

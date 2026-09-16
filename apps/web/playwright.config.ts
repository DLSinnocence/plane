/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  use: { baseURL: "http://127.0.0.1:4179", headless: true, viewport: { width: 1440, height: 1000 } },
  webServer: [
    {
      command: "pnpm exec vite --config tests/browser/vite.config.ts --host 127.0.0.1 --port 4179 --strictPort",
      url: "http://127.0.0.1:4179",
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        "pnpm exec vite --config tests/browser/language.vite.config.ts --host 127.0.0.1 --port 4180 --strictPort",
      url: "http://127.0.0.1:4180",
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        "pnpm exec vite --config tests/browser/activity.vite.config.ts --host 127.0.0.1 --port 4181 --strictPort",
      url: "http://127.0.0.1:4181",
      reuseExistingServer: !process.env.CI,
    },
  ],
});

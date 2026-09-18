/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test } from "@playwright/test";

test("a 6 MiB GIF is accepted by the shared page and comment editor configuration", async ({ page }) => {
  await page.goto("/?editor-file-size");
  await page.getByRole("button", { name: "Validate 6 MiB GIF" }).click();

  await expect(page.getByTestId("editor-file-size-result")).toHaveText(
    JSON.stringify({ accepted: true, maxFileSize: 10 * 1024 * 1024 })
  );
});

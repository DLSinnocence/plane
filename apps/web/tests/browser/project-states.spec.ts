/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test } from "@playwright/test";

test("project state definitions remain visible with no customization controls", async ({ page }) => {
  await page.goto("/?stage-assignees&read-only-states");
  await expect(page.getByRole("heading", { name: "Renamed testing stage", exact: true })).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(6);
  await page.getByRole("listitem").first().hover();
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.locator("input, select, textarea, [draggable=true]")).toHaveCount(0);
});

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test } from "@playwright/test";

test("workspace admins can find integrations alongside Webhooks", async ({ page }) => {
  await page.goto("/?settings&role=admin");
  const webhooks = page.getByRole("link", { name: "workspace_settings.settings.webhooks.title" });
  const integrations = page.getByRole("link", { name: "integrations.integrations" });
  await expect(webhooks).toBeVisible();
  await expect(integrations).toBeVisible();
  await expect(webhooks.locator("..").getByRole("link", { name: "integrations.integrations" })).toBeVisible();
  await expect(integrations).toHaveAttribute("href", "/workspace/settings/integrations");
});

test("workspace members do not receive administrator integration controls", async ({ page }) => {
  await page.goto("/?settings&role=member");
  await expect(page.getByRole("link", { name: "workspace_settings.settings.general.title" })).toBeVisible();
  await expect(page.getByRole("link", { name: "integrations.integrations" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "workspace_settings.settings.webhooks.title" })).toHaveCount(0);
});

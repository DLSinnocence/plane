/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { expect, test } from "@playwright/test";

const provider = {
  id: "provider-id",
  name: "Shared OpenAI",
  provider: "openai",
  base_url: "https://api.openai.com/v1",
  has_api_key: true,
  is_enabled: true,
  models: [],
};

test("selects a discovered model without reloading the workspace AI settings page", async ({ page }) => {
  await page.route("**/auth/get-csrf-token/", (route) => route.fulfill({ json: { csrf_token: "fixture-csrf" } }));
  await page.route("**/api/workspaces/workspace/ai-settings/**", async (route) => {
    const request = route.request();
    if (request.url().endsWith("/models/") && request.method() === "POST") {
      await route.fulfill({
        json: { models: [{ id: "gpt-4o-mini", name: "GPT-4o mini", vision: true }], truncated: false },
      });
      return;
    }
    await route.fulfill({ json: { providers: [provider] } });
  });

  await page.goto("/?workspace-ai-settings");
  await expect(page.getByRole("heading", { name: "workspace_settings.settings.ai.title" })).toBeVisible();
  await page.getByRole("button", { name: "workspace_settings.settings.ai.discover_models" }).click();

  const modelSelect = page.getByLabel("workspace_settings.settings.ai.discovery_results");
  await expect(modelSelect).toBeVisible();
  await modelSelect.selectOption("gpt-4o-mini");
  await expect(page.getByLabel("workspace_settings.settings.ai.manual_model")).toHaveValue("gpt-4o-mini");
  await expect(page).toHaveURL(/workspace-ai-settings/);
});

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test, type Page } from "@playwright/test";
import { matchRoutes, type RouteObject } from "react-router";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { WORKSPACE_SETTINGS } from "@plane/constants";
import applicationRoutes from "../../app/routes";

function matchableRoute(entry: RouteConfigEntry): RouteObject {
  const common = { id: entry.file };
  return entry.index
    ? { ...common, index: true }
    : { ...common, path: entry.path, children: entry.children?.map(matchableRoute) };
}

async function mockFeishuReads(page: Page) {
  const requests: string[] = [];
  await page.route("**/api/workspaces/workspace/integrations/feishu/**", async (route) => {
    expect(route.request().method()).toBe("GET");
    requests.push(route.request().url());
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      json: pathname.endsWith("/feishu/") ? { id: null, app_id: "", enabled: false, has_app_secret: false } : [],
    });
  });
  return requests;
}

async function expectConfigurationPage(page: Page) {
  await expect(page.getByRole("heading", { name: "feishu_integration.name", exact: true })).toBeVisible();
  await expect(page.getByLabel("feishu_integration.app_id", { exact: true })).toBeVisible();
  await expect(page.getByLabel("feishu_integration.app_secret", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "feishu_integration.save", exact: true })).toBeVisible();
  await expect(page.getByText("Oops! Something went wrong.", { exact: true })).toHaveCount(0);
}

test("every workspace settings link matches a registered page instead of the catch-all", () => {
  const graph = applicationRoutes.map(matchableRoute);
  for (const setting of Object.values(WORKSPACE_SETTINGS)) {
    const matches = matchRoutes(graph, `/workspace${setting.href}/`);
    expect(matches?.at(-1)?.route.path, setting.href).not.toBe("*");
    expect(
      matches?.map((match) => match.route.id),
      setting.href
    ).toContain("./(all)/[workspaceSlug]/(settings)/settings/(workspace)/layout.tsx");
  }
  expect(matchRoutes(graph, "/workspace/settings/integrations")?.at(-1)?.route.id).toBe(
    "./(all)/[workspaceSlug]/(settings)/settings/(workspace)/integrations/page.tsx"
  );
});

test("clicking integrations opens the real Feishu configuration page", async ({ page }) => {
  const requests = await mockFeishuReads(page);
  await page.goto("/workspace/settings");
  await page.getByRole("link", { name: "integrations.integrations", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/settings\/integrations\/?$/);
  await expectConfigurationPage(page);
  expect(requests.some((url) => url.endsWith("/feishu/"))).toBe(true);
  await page.reload();
  await expectConfigurationPage(page);
});

for (const suffix of ["", "/"]) {
  test(`integration URL supports direct navigation${suffix ? " with trailing slash" : ""}`, async ({ page }) => {
    await mockFeishuReads(page);
    await page.goto(`/workspace/settings/integrations${suffix}`);
    await expectConfigurationPage(page);
  });
}

test("direct integration navigation retains the workspace admin restriction", async ({ page }) => {
  const requests = await mockFeishuReads(page);
  await page.goto("/workspace/settings/integrations?role=member");
  await expect(page.getByRole("heading", { name: "Oops! You are not authorized to view this page" })).toBeVisible();
  await expect(page.getByLabel("feishu_integration.app_id", { exact: true })).toHaveCount(0);
  expect(requests).toEqual([]);
});

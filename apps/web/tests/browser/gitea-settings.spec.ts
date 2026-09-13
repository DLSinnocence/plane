/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* eslint-disable no-await-in-loop -- Clipboard, downloads and navigation share one browser page and must run sequentially. */
import { expect, test, type Page } from "@playwright/test";
import { config, expectNoStoredSecret, generatedHooks, mockGiteaApi } from "./fixtures/gitea-api";

const label = (key: string) => `gitea_integration.${key}`;
const button = (page: Page, key: string) => page.getByRole("button", { name: label(key), exact: true });
const repositoryUrl = "https://gitea.example.test/team/repo";
async function generate(page: Page) {
  await page.getByLabel(label("repository_url"), { exact: true }).fill(repositoryUrl);
  await button(page, "get_hooks").click();
  await expect(page.locator("textarea")).toHaveCount(2);
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("first enable sends only workspace enabled and generating sends only an unsaved repository URL", async ({
  page,
}) => {
  const requests = await mockGiteaApi(page, { ...config, enabled: false, has_secret: false });
  await page.goto("/?gitea-settings");
  await expect(button(page, "get_hooks")).toBeDisabled();
  await expect(page.locator('select, input[type="password"], textarea')).toHaveCount(0);
  await button(page, "enable").click();
  await expect(button(page, "get_hooks")).toBeEnabled();
  expect(requests.filter((request) => request.method === "PATCH").map((request) => request.body)).toEqual([
    { enabled: true },
  ]);
  expect(requests.some((request) => request.pathname.endsWith("/hooks/"))).toBe(false);
  await generate(page);
  expect(requests.filter((request) => request.method === "POST")).toEqual([
    {
      method: "POST",
      pathname: "/api/workspaces/workspace/integrations/gitea/hooks/",
      body: { repository_url: repositoryUrl },
    },
  ]);
  await expectNoStoredSecret(page, repositoryUrl);
  await expectNoStoredSecret(page, "fixture-hook-secret");
  await page.reload();
  await expect(page.getByLabel(label("repository_url"), { exact: true })).toHaveValue("");
  await expect(page.locator("textarea")).toHaveCount(0);
});

test("all four workspace endpoints are read-only and copyable without fetching secrets", async ({ page }) => {
  const requests = await mockGiteaApi(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?gitea-settings");
  for (const field of ["validation_url", "commits_url", "lookup_url", "issue_url_template"] as const) {
    const input = page.getByLabel(label(field), { exact: true });
    await expect(input).toHaveValue(config[field]);
    await expect(input).toHaveJSProperty("readOnly", true);
    await button(page, `copy_${field}`).click();
    await expect(page.getByRole("status")).toHaveText(label("url_copied"));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(config[field]);
  }
  for (const key of [
    "repository_url_help",
    "hook_requirements",
    "hook_installation",
    "hook_existing",
    "hook_rejection",
    "post_receive_help",
    "work_item_links",
    "commit_format",
  ]) {
    await expect(page.getByText(label(key), { exact: true })).toBeVisible();
  }
  expect(requests).toEqual([{ method: "GET", pathname: "/api/workspaces/workspace/integrations/gitea/", body: null }]);
  expect(await page.content()).not.toContain("fixture-hook-secret");
});

test("both generated scripts copy and download exact contents under correct filenames", async ({ page }) => {
  const requests = await mockGiteaApi(page);
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?gitea-settings");
  await generate(page);
  for (const field of ["pre_receive", "post_receive"] as const) {
    await expect(page.getByLabel(label(`${field}_content`))).toHaveValue(generatedHooks[field].content);
    await button(page, `copy_${field}`).click();
    await expect(page.getByRole("status")).toHaveText(label("copied"));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(generatedHooks[field].content);
    const pendingDownload = page.waitForEvent("download");
    await button(page, `download_${field}`).click();
    const download = await pendingDownload;
    expect(download.suggestedFilename()).toBe(generatedHooks[field].filename);
    const stream = await download.createReadStream();
    if (!stream) throw new Error("Missing hook download stream");
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe(generatedHooks[field].content);
  }
  expect(requests.filter((request) => request.pathname.endsWith("/hooks/"))).toHaveLength(1);
  expect(logs.join("\n")).not.toContain("fixture-hook-secret");
  await expectNoStoredSecret(page, "fixture-hook-secret");
  await button(page, "hide_hooks").click();
  await expect(page.locator("textarea")).toHaveCount(0);
  await generate(page);
  await button(page, "reset").click();
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.getByLabel(label("repository_url"), { exact: true })).toHaveValue("");
});

test("workspace switches clear URL and scripts even when returning to a cached workspace", async ({ page }) => {
  const requests = await mockGiteaApi(page);
  await page.goto("/?gitea-settings");
  await generate(page);
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await expect(page.getByLabel(label("repository_url"), { exact: true })).toHaveValue("");
    await expect(page.locator("textarea")).toHaveCount(0);
  }
  expect(requests.filter((request) => request.pathname.endsWith("/hooks/"))).toHaveLength(1);
  await expectNoStoredSecret(page, repositoryUrl);
  await expectNoStoredSecret(page, "fixture-hook-secret");
});

test("reset discards an in-flight hook response", async ({ page }) => {
  await mockGiteaApi(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/integrations/gitea/hooks/", async (route) => {
    await hold;
    await route.fulfill({ json: generatedHooks });
  });
  await page.goto("/?gitea-settings");
  await page.getByLabel(label("repository_url"), { exact: true }).fill(repositoryUrl);
  const pending = page.waitForRequest("**/integrations/gitea/hooks/");
  await button(page, "get_hooks").click();
  await pending;
  await button(page, "reset").click();
  release();
  await expect(button(page, "get_hooks")).toBeEnabled();
  await expect(page.locator("textarea")).toHaveCount(0);
});

for (const action of ["rotate", "disable"] as const) {
  test(`${action} clears scripts before confirmation, cancellation sends nothing, confirmation uses workspace API`, async ({
    page,
  }) => {
    const requests = await mockGiteaApi(page);
    await page.goto("/?gitea-settings");
    await generate(page);
    await button(page, action).click();
    await expect(page.locator("textarea")).toHaveCount(0);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(label(`${action}_warning`), { exact: true })).toBeVisible();
    await dialog.getByRole("button").first().click();
    await expect(dialog).toHaveCount(0);
    expect(requests.filter((request) => request.method !== "GET" && !request.pathname.endsWith("/hooks/"))).toEqual([]);
    await button(page, action).click();
    await dialog.getByRole("button").last().click();
    await expect(page.getByRole("status")).toHaveText(label(action === "rotate" ? "rotated" : "disabled_notice"));
    const mutations = requests.filter((request) => request.method !== "GET" && !request.pathname.endsWith("/hooks/"));
    expect(mutations).toEqual([
      action === "rotate"
        ? { method: "POST", pathname: "/api/workspaces/workspace/integrations/gitea/rotate-token/", body: {} }
        : { method: "PATCH", pathname: "/api/workspaces/workspace/integrations/gitea/", body: { enabled: false } },
    ]);
    await expect(page.locator("textarea")).toHaveCount(0);
    if (action === "disable") {
      await expect(button(page, "get_hooks")).toBeDisabled();
      await button(page, "enable").click();
      await expect(button(page, "get_hooks")).toBeEnabled();
    }
  });
}

test("failed generation displays generic error and never exposes response secrets", async ({ page }) => {
  await mockGiteaApi(page);
  await page.route("**/integrations/gitea/hooks/", async (route) => {
    await route.fulfill({ status: 500, json: { error: "response-secret-must-not-leak" } });
  });
  await page.goto("/?gitea-settings");
  await page.getByLabel(label("repository_url"), { exact: true }).fill(repositoryUrl);
  await button(page, "get_hooks").click();
  await expect(page.getByRole("alert")).toHaveText(label("action_error"));
  await expect(button(page, "get_hooks")).toBeEnabled();
  expect(await page.content()).not.toContain("response-secret-must-not-leak");
  await expect(page.locator("textarea")).toHaveCount(0);
  await expectNoStoredSecret(page, "response-secret-must-not-leak");
});

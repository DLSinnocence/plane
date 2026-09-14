/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/* eslint-disable no-await-in-loop -- Clipboard and navigation share one browser page and must run sequentially. */
import { expect, test, type Page } from "@playwright/test";
import { config, expectNoStoredSecret, generatedHooks, mockGiteaApi } from "./fixtures/gitea-api";

const label = (key: string) => `gitea_integration.${key}`;
const button = (page: Page, key: string) => page.getByRole("button", { name: label(key), exact: true });
async function generate(page: Page) {
  await button(page, "get_hooks").click();
  await expect(page.locator("textarea")).toHaveCount(2);
}

async function expectSimpleUi(page: Page) {
  await expect(page.locator("input, select, details, summary, a[download]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /export|download|install|zip/i })).toHaveCount(0);
  for (const field of ["validation_url", "commits_url", "lookup_url", "issue_url_template"] as const) {
    await expect(page.getByLabel(label(field), { exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain(config[field]);
  }
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("first enable generates both hooks directly with an empty body and no secret prefetch or persistence", async ({
  page,
}) => {
  const requests = await mockGiteaApi(page, { ...config, enabled: false, has_secret: false });
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await page.goto("/?gitea-settings");
  await expect(button(page, "get_hooks")).toBeDisabled();
  await expectSimpleUi(page);
  await expect(page.locator("textarea")).toHaveCount(0);
  expect(requests).toEqual([{ method: "GET", pathname: "/api/workspaces/workspace/integrations/gitea/", body: null }]);
  expect(await page.content()).not.toContain("fixture-hook-secret");
  await button(page, "enable").click();
  await expect(button(page, "get_hooks")).toBeEnabled();
  expect(requests.filter((request) => request.method === "PATCH").map((request) => request.body)).toEqual([
    { enabled: true },
  ]);
  expect(requests.some((request) => request.method === "POST")).toBe(false);
  const storageBefore = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  await generate(page);
  expect(requests.filter((request) => request.method === "POST")).toEqual([
    { method: "POST", pathname: "/api/workspaces/workspace/integrations/gitea/hooks/", body: {} },
  ]);
  await expect(page.getByRole("status")).toHaveText(label("hook_ready"));
  await expectSimpleUi(page);
  for (const key of [
    "generation_help",
    "hook_installation",
    "hook_requirements",
    "pre_receive_help",
    "post_receive_help",
  ]) {
    await expect(page.getByText(label(key), { exact: true })).toBeVisible();
  }
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual(
    storageBefore
  );
  await expectNoStoredSecret(page, "fixture-hook-secret");
  expect(logs.join("\n")).not.toContain("fixture-hook-secret");
  await page.reload();
  await expect(button(page, "get_hooks")).toBeEnabled();
  await expect(page.locator("textarea")).toHaveCount(0);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("configuration permission failure hides generation and allows a safe retry", async ({ page }) => {
  await mockGiteaApi(page);
  let attempts = 0;
  await page.route("**/workspaces/workspace/integrations/gitea/", async (route) => {
    attempts += 1;
    if (attempts === 1) await route.fulfill({ status: 403, json: { error: "response-secret-must-not-leak" } });
    else await route.fulfill({ json: config });
  });
  await page.goto("/?gitea-settings");
  await expect(page.getByRole("alert")).toContainText(label("load_error"));
  await expect(button(page, "get_hooks")).toHaveCount(0);
  expect(await page.content()).not.toContain("response-secret-must-not-leak");
  await button(page, "retry").click();
  await expect(button(page, "get_hooks")).toBeEnabled();
  expect(attempts).toBe(2);
});

for (const initial of [
  { ...config, enabled: false },
  { ...config, has_secret: false },
]) {
  test(`generation requires enabled plus secret: ${JSON.stringify(initial)}`, async ({ page }) => {
    const requests = await mockGiteaApi(page, initial);
    await page.goto("/?gitea-settings");
    await expect(button(page, "get_hooks")).toBeDisabled();
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });
}

test("both read-only scripts copy exact contents and clear together", async ({ page }) => {
  const requests = await mockGiteaApi(page);
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?gitea-settings");
  await generate(page);
  for (const field of ["pre_receive", "post_receive"] as const) {
    const code = page.getByLabel(label(`${field}_content`));
    await expect(code).toHaveValue(generatedHooks[field].content);
    await expect(code).toHaveAttribute("readonly", "");
    await expect(page.getByRole("heading", { name: generatedHooks[field].filename, exact: true })).toBeVisible();
    await button(page, `copy_${field}`).click();
    await expect(page.getByRole("status")).toHaveText(label("copied"));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(generatedHooks[field].content);
  }
  expect(requests.filter((request) => request.pathname.endsWith("/hooks/"))).toEqual([
    { method: "POST", pathname: "/api/workspaces/workspace/integrations/gitea/hooks/", body: {} },
  ]);
  expect(logs.join("\n")).not.toContain("fixture-hook-secret");
  await expectNoStoredSecret(page, "fixture-hook-secret");
  await button(page, "reset").click();
  await expect(page.locator("textarea")).toHaveCount(0);
});

test("workspace switches clear scripts, including cached workspaces, and generation uses the current workspace", async ({
  page,
}) => {
  const requests = await mockGiteaApi(page);
  await page.goto("/?gitea-settings");
  await generate(page);
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(button(page, "get_hooks")).toBeEnabled();
  await generate(page);
  expect(requests.filter((request) => request.method === "POST")).toEqual([
    { method: "POST", pathname: "/api/workspaces/workspace/integrations/gitea/hooks/", body: {} },
    { method: "POST", pathname: "/api/workspaces/other/integrations/gitea/hooks/", body: {} },
  ]);
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await expect(button(page, "get_hooks")).toBeEnabled();
  await expect(page.locator("textarea")).toHaveCount(0);
  await expectNoStoredSecret(page, "fixture-hook-secret");
});

for (const action of ["reset", "switch"] as const) {
  test(`${action} invalidates in-flight generation while conflicting actions stay locked`, async ({ page }) => {
    await mockGiteaApi(page);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/workspaces/workspace/integrations/gitea/hooks/", async (route) => {
      await hold;
      await route.fulfill({ json: generatedHooks });
    });
    await page.goto("/?gitea-settings");
    const pending = page.waitForRequest("**/workspaces/workspace/integrations/gitea/hooks/");
    await button(page, "get_hooks").click();
    await pending;
    await expect(button(page, "get_hooks")).toBeDisabled();
    await expect(button(page, "rotate")).toBeDisabled();
    await expect(button(page, "disable")).toBeDisabled();
    if (action === "reset") await button(page, "reset").click();
    else await page.getByRole("button", { name: "Switch workspace" }).click();
    const response = page.waitForResponse("**/workspaces/workspace/integrations/gitea/hooks/");
    release();
    await (await response).finished();
    await page.waitForLoadState("networkidle");
    await expect(button(page, "get_hooks")).toBeEnabled();
    await expect(page.locator("textarea")).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expectNoStoredSecret(page, "fixture-hook-secret");
    await generate(page);
  });
}

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
    }
    await expect(button(page, "get_hooks")).toBeEnabled();
  });
}

for (const suffix of ["hooks/", "rotate-token/", ""] as const) {
  test(`failed ${suffix || "disable"} never exposes response secrets`, async ({ page }) => {
    await mockGiteaApi(page);
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));
    await page.route(`**/workspaces/workspace/integrations/gitea/${suffix}`, async (route) => {
      if (route.request().method() === "GET") await route.fallback();
      else await route.fulfill({ status: 500, json: { error: "response-secret-must-not-leak" } });
    });
    await page.goto("/?gitea-settings");
    const key = suffix === "hooks/" ? "get_hooks" : suffix === "rotate-token/" ? "rotate" : "disable";
    await button(page, key).click();
    if (key !== "get_hooks") await page.getByRole("dialog").getByRole("button").last().click();
    await expect(page.getByRole("alert")).toHaveText(label("action_error"));
    await expect(button(page, key).first()).toBeEnabled();
    expect(await page.content()).not.toContain("response-secret-must-not-leak");
    expect(logs.join("\n")).not.toContain("response-secret-must-not-leak");
    await expect(page.locator("textarea")).toHaveCount(0);
    await expectNoStoredSecret(page, "response-secret-must-not-leak");
  });
}

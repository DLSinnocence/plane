/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:4180", locale: "en-US" });

const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/auth/email-check/", (route) =>
    route.fulfill({
      json: { existing: false, status: "CREDENTIAL" },
    })
  );
  await page.route("**/auth/get-csrf-token/", (route) => route.fulfill({ json: { csrf_token: "fixture-csrf" } }));
  await page.route("**/api/**", (route) => route.abort());
});
test.afterEach(() => expect(pageErrors).toEqual([]));

async function expectNeutralBranding(page: import("@playwright/test").Page) {
  await expect(page.locator("body")).not.toContainText(
    /Welcome back to Plane|Work in all dimensions|10,000|欢迎回到 Plane|面面俱到|首次使用 Plane/
  );
  await expect(page.locator('a[href*="plane.so"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/Accenture|Zerodha|Dolby|Sony/);
}

test("a fresh browser renders actual login controls in Chinese without upstream branding", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("登录", { exact: true })).toBeVisible();
  await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "创建账号", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "使用 Google 登录", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page).toHaveTitle("登录");
  await expectNeutralBranding(page);
});

test("a new account sees Chinese signup and password controls before any profile exists", async ({ page }) => {
  await page.goto("/sign-up");
  await expect(page.getByText("创建账号", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "登录", exact: true })).toBeVisible();
  await page.getByLabel("邮箱", { exact: true }).fill("new.account@example.test");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.getByRole("button", { name: "创建账号", exact: true })).toBeVisible();
  await expect(page.locator('input[type="password"]').first()).toBeVisible();
  await expect(page).toHaveTitle("创建账号");
  await expectNeutralBranding(page);
});

test("switching normal login and signup keeps the private invitation return path", async ({ page }) => {
  const invitation = "/workspace-invitations/?invitation_id=invite&slug=workspace&token=private-token";
  await page.goto(`/?next_path=${encodeURIComponent(invitation)}`);
  await page.getByRole("link", { name: "创建账号", exact: true }).click();
  expect(new URL(page.url()).pathname).toBe("/sign-up");
  expect(new URL(page.url()).searchParams.get("next_path")).toBe(invitation);
  await page.getByRole("link", { name: "登录", exact: true }).click();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).searchParams.get("next_path")).toBe(invitation);
});

test("editing an email keeps the invitation in the password form and return URL", async ({ page }) => {
  const invitation = "/workspace-invitations/?invitation_id=invite&slug=workspace&token=private-token";
  await page.goto(`/?next_path=${encodeURIComponent(invitation)}`);
  await page.getByLabel("邮箱", { exact: true }).fill("new.account@example.test");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.locator('input[name="next_path"]')).toHaveValue(invitation);
  await page.getByRole("button", { name: "清除邮箱", exact: true }).click();
  await expect(page.getByLabel("邮箱", { exact: true })).toBeEditable();
  expect(new URL(page.url()).searchParams.get("next_path")).toBe(invitation);
});

test("an explicit English choice remains available and survives reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("登录", { exact: true })).toBeVisible();
  await page.getByTestId("choose-english").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Log in");
  await page.reload();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expectNeutralBranding(page);
});

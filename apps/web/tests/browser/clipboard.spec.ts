/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("normal paste retains the work item number and name while plain-text paste retains the URL", async ({ page }) => {
  await page.goto("/clipboard.html");
  const url = new URL("/meowalive/browse/WITCHFARM-10/", page.url()).href;
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied");

  const editor = page.getByRole("textbox", { name: "Rich text editor" });
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(editor.getByRole("link")).toHaveText("WITCHFARM-10 修复农场显示");
  await expect(editor.getByRole("link")).toHaveAttribute("href", url);

  const plain = page.getByRole("textbox", { name: "Plain text" });
  await plain.focus();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(plain).toHaveValue(url);
});

test("renamed issues paste the updated literal title without introducing HTML", async ({ page }) => {
  await page.goto("/clipboard.html");
  const name = `中文 <img src=x onerror="alert(1)"> & '引号'`;
  await page.getByRole("textbox", { name: "Work item name" }).fill(name);
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied");

  const editor = page.getByRole("textbox", { name: "Rich text editor" });
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(editor.getByRole("link")).toHaveText(`WITCHFARM-10 ${name}`);
  await expect(editor.locator("img, script")).toHaveCount(0);
});

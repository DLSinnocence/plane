/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test, type Locator } from "@playwright/test";

async function expectAdjacent(trigger: Locator, menu: Locator) {
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("data-popper-placement", /^(top|bottom)/);
  await expect
    .poll(
      async () => {
        const [buttonBox, menuBox] = await Promise.all([trigger.boundingBox(), menu.boundingBox()]);
        if (!buttonBox || !menuBox) return false;
        const horizontalGap = Math.min(
          Math.abs(menuBox.x - buttonBox.x),
          Math.abs(menuBox.x + menuBox.width - buttonBox.x - buttonBox.width)
        );
        const verticalGap = Math.min(
          Math.abs(menuBox.y - buttonBox.y - buttonBox.height),
          Math.abs(menuBox.y + menuBox.height - buttonBox.y)
        );
        return horizontalGap < 20 && verticalGap < 20;
      },
      { timeout: 5000 }
    )
    .toBe(true);
}

for (const id of ["member", "state", "priority", "date", "timezone"]) {
  test(`${id} dropdown follows its trigger and remains interactive`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(id === "timezone" ? "/" : "/?modal");
    if (id !== "timezone") await page.getByRole("button", { name: "Open modal" }).click();
    const trigger = page.getByTestId(id).locator("button").first();
    await trigger.click();
    const menu = page.getByRole("listbox");
    await expectAdjacent(trigger, menu);
    if (id === "date") {
      await expect(menu.getByRole("grid")).toBeVisible();
      await menu.getByRole("button", { name: /15/ }).first().click();
    } else {
      await menu.getByRole("option").last().click();
    }
    if (id === "timezone") await expect(page.getByTestId("selected")).toContainText("Asia/Shanghai");
    if (id === "member") await expect(page.getByTestId("selected")).toContainText("reviewer");
    if (id !== "timezone") {
      await expect(page.getByRole("dialog")).toBeAttached();
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.locator("button button")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("timezone supports search, selection and reopening", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByTestId("timezone").locator("button").first();
  await trigger.click();
  await page.getByRole("combobox").fill("Shanghai");
  await page.getByRole("option", { name: "Asia/Shanghai" }).click();
  await expect(page.getByTestId("selected")).toContainText("Asia/Shanghai");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await trigger.click();
  await expectAdjacent(trigger, page.getByRole("listbox"));
  await page.getByRole("combobox").press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("timezone supports keyboard selection and selecting its current value", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByTestId("timezone").locator("button").first();
  await trigger.click();
  await page.getByRole("option", { name: "UTC", exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await trigger.click();
  const search = page.getByRole("combobox");
  await search.fill("Shanghai");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page.getByTestId("selected")).toContainText("Asia/Shanghai");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("member popup stays anchored on modal scroll and viewport resize", async ({ page }) => {
  await page.goto("/?modal");
  await page.getByRole("button", { name: "Open modal" }).click();
  const trigger = page.getByTestId("member").locator("button").first();
  await trigger.click();
  await expectAdjacent(trigger, page.getByRole("listbox"));
  await page.setViewportSize({ width: 1280, height: 760 });
  await expectAdjacent(trigger, page.getByRole("listbox"));
  await page.locator('[role="dialog"] .overflow-y-auto').evaluate((element) => {
    const panel = element.querySelector(".panel") as HTMLElement;
    panel.style.paddingBottom = "600px";
    element.scrollTop = 120;
  });
  await expectAdjacent(trigger, page.getByRole("listbox"));
  await page.getByRole("option", { name: /Reviewer/ }).click();
  await expect(page.getByTestId("selected")).toContainText("reviewer");
});

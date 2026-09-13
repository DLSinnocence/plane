/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test, type Page } from "@playwright/test";

const commitsLabel = "gitea_integration.commits";
const trigger = (page: Page) => page.getByTestId("detail-actions").locator('button[aria-haspopup="menu"]');
const commitsItem = (page: Page) => page.getByRole("menuitem", { name: commitsLabel, exact: true });

async function interceptCommits(page: Page) {
  const requests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe("GET");
    expect(url.pathname).toMatch(
      /^\/api\/workspaces\/workspace\/projects\/project\/issues\/(issue|other)\/git-commits\/$/
    );
    expect(url.search).toBe("?page=1");
    requests.push(url.pathname);
    const issue = url.pathname.includes("/other/") ? "other" : "issue";
    await route.fulfill({
      json: {
        count: 1,
        next_page: null,
        results: [
          {
            id: issue,
            sha: "1234567890",
            short_sha: "1234567",
            title: `Commit for ${issue}`,
            author_name: "Ada",
            committed_at: null,
            repository_name: "demo/repo",
            branch: "main",
            url: "https://git.example.test/demo/repo/commit/1234567890",
          },
        ],
      },
    });
  });
  return requests;
}

async function openCommits(page: Page) {
  await trigger(page).click();
  await commitsItem(page).click();
  await expect(
    page
      .getByRole("dialog", { name: commitsLabel, exact: true })
      .getByRole("heading", { name: commitsLabel, exact: true })
  ).toBeVisible();
}

test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

for (const mode of ["", "&role=viewer", "&readonly", "&archived&role=viewer", "&peek&role=viewer"]) {
  test(`commits load only after selecting the menu action ${mode || "editor"}`, async ({ page }) => {
    const requests = await interceptCommits(page);
    await page.goto(`/?git-commits-menu${mode}`);
    await expect(page.getByRole("heading", { name: "Detail issue" })).toBeVisible();
    await expect(page.getByText("Commit for issue", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(requests).toEqual([]);
    await trigger(page).click();
    await expect(commitsItem(page)).toBeVisible();
    expect(requests).toEqual([]);
    await commitsItem(page).click();
    const dialog = page.getByRole("dialog", { name: commitsLabel, exact: true });
    await expect(dialog.getByRole("link", { name: "1234567 Commit for issue" })).toBeVisible();
    expect(requests).toEqual(["/api/workspaces/workspace/projects/project/issues/issue/git-commits/"]);
    await dialog.getByRole("button", { name: "close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("1234567 Commit for issue")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Detail issue" })).toBeVisible();
  });
}

for (const dismissal of ["Escape", "outside"] as const) {
  test(`${dismissal} dismisses commits and the menu remains usable`, async ({ page }) => {
    await interceptCommits(page);
    await page.goto("/?git-commits-menu");
    await openCommits(page);
    await expect(page.getByRole("link", { name: "1234567 Commit for issue" })).toBeVisible();
    if (dismissal === "Escape") await page.keyboard.press("Escape");
    else await page.mouse.click(5, 5);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openCommits(page);
    await expect(page.getByRole("link", { name: "1234567 Commit for issue" })).toBeVisible();
  });
}

test("changing issue while the dialog is open closes it without fetching the new issue", async ({ page }) => {
  const requests = await interceptCommits(page);
  await page.goto("/?git-commits-menu");
  await openCommits(page);
  await expect(page.getByRole("link", { name: "1234567 Commit for issue" })).toBeVisible();
  // Simulate route navigation initiated elsewhere while the modal makes the page inert.
  await page
    .getByRole("button", { name: "Next work item", includeHidden: true })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.getByRole("heading", { name: "Detail other" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("1234567 Commit for issue")).toHaveCount(0);
  expect(requests).toHaveLength(1);
  await openCommits(page);
  await expect(page.getByRole("link", { name: "1234567 Commit for other" })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("/issues/other/");
});

test("draft work items do not offer linked commits", async ({ page }) => {
  const requests = await interceptCommits(page);
  await page.goto("/?git-commits-menu&draft");
  await trigger(page).click();
  await expect(page.getByRole("menuitem", { name: "common.actions.open_in_new_tab", exact: true })).toBeVisible();
  await expect(commitsItem(page)).toHaveCount(0);
  expect(requests).toEqual([]);
});

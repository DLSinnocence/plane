/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ baseURL: "http://127.0.0.1:4181" });

const comments = (page: Page) => page.getByRole("region", { name: "common.comments", exact: true });
const activities = (page: Page) => page.getByRole("region", { name: "common.activity", exact: true });
const toggle = (page: Page) => activities(page).getByRole("button", { name: "common.activity", exact: true });
const draft = (page: Page) => comments(page).getByRole("textbox", { name: "Comment draft" });
const sort = (page: Page) =>
  comments(page).getByRole("button", { name: /^common\.sort\.created_on: common\.sort\.(asc|desc)$/ });
const body = (page: Page, issue = "A", sequence = 1) => page.getByTestId(`comment-body-${issue}-comment-${sequence}`);
const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function seedPreferences(page: Page, filters: unknown, order?: unknown) {
  await page.addInitScript(
    ({ initialFilters, initialOrder }) => {
      localStorage.setItem("issue_activity_filters", JSON.stringify(initialFilters));
      if (initialOrder !== undefined) localStorage.setItem("activity_sort_order", JSON.stringify(initialOrder));
    },
    { initialFilters: filters, initialOrder: order }
  );
}

async function expectBefore(first: Locator, second: Locator) {
  const secondElement = await second.elementHandle();
  expect(
    await first.evaluate(
      (element, next) => !!next && Boolean(element.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING),
      secondElement
    )
  ).toBe(true);
}

async function expectComments(page: Page, issue = "A") {
  await expect(body(page, issue, 1)).toHaveText(`${issue} comment 1`);
  await expect(body(page, issue, 2)).toHaveText(`${issue} comment 2`);
  await expect(body(page, issue, 1)).toBeVisible();
  await expect(body(page, issue, 2)).toBeVisible();
  await expect(activities(page).getByTestId(/^comment-body-/)).toHaveCount(0);
}

async function expectFullActivity(page: Page, issue = "A") {
  const region = activities(page);
  await expect(region.getByText("created the work item.", { exact: true })).toBeVisible();
  await expect(region.getByText(`set the name to ${issue} renamed title.`, { exact: true })).toBeVisible();
  await expect(region.getByText(`${issue} developing`, { exact: true })).toBeVisible();
  await expect(region.getByRole("link", { name: `${issue} owner` })).toBeVisible();
  await expect(region.getByText("high", { exact: true })).toBeVisible();
  // Five real renderers, including the DEFAULT creation record, appear once.
  await expect(region.getByRole("link", { name: "Alice", exact: true })).toHaveCount(5);
}

test("comments precede the initially collapsed activity and mouse expansion exposes every record", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(comments(page).getByRole("heading", { level: 3, name: "common.comments" })).toBeVisible();
  await expectComments(page);
  await expect(draft(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(activities(page).getByText("A developing", { exact: true })).not.toBeVisible();
  await expectBefore(comments(page), activities(page));
  await expectBefore(body(page, "A", 2), draft(page));
  await page.getByTestId("activity-root").screenshot({ path: testInfo.outputPath("activity-collapsed.png") });

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expectFullActivity(page);
  await expectComments(page);
  const commentsBox = await comments(page).boundingBox();
  const activitiesBox = await activities(page).boundingBox();
  expect(commentsBox).not.toBeNull();
  expect(activitiesBox).not.toBeNull();
  expect(commentsBox!.y + commentsBox!.height).toBeLessThanOrEqual(activitiesBox!.y);
  await page.getByTestId("activity-root").screenshot({ path: testInfo.outputPath("activity-expanded.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectFullActivity(page);
  await page.getByTestId("activity-root").screenshot({ path: testInfo.outputPath("activity-expanded-mobile.png") });

  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(activities(page).getByText("A developing", { exact: true })).not.toBeVisible();
  await expectComments(page);
});

test("the real disclosure supports Enter, Space, focus and expanded semantics", async ({ page }) => {
  await page.goto("/");
  await toggle(page).focus();
  await expect(toggle(page)).toBeFocused();
  await toggle(page).press("Enter");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expectFullActivity(page);
  await expect(toggle(page)).toBeFocused();
  await toggle(page).press("Space");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(activities(page).getByText("A developing", { exact: true })).not.toBeVisible();
  await expect(toggle(page)).toBeFocused();
  await toggle(page).press("Space");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expectFullActivity(page);
});

test("A to B to A, project/workspace changes and remounting each reset only the activity disclosure", async ({
  page,
}) => {
  await page.goto("/");
  // Each transition starts from the previous mounted root; parallelizing would skip the lifecycle under test.
  /* oxlint-disable no-await-in-loop */
  for (const [control, issue] of [
    ["Open B", "B"],
    ["Open A", "A"],
    ["Change project", "A"],
    ["Change workspace", "A"],
  ]) {
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: control, exact: true }).click();
    await expectComments(page, issue);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  }
  /* oxlint-enable no-await-in-loop */
  await toggle(page).click();
  await page.getByRole("button", { name: "Close detail", exact: true }).click();
  await expect(comments(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen detail", exact: true }).click();
  await expectComments(page);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
});

test("activity filters leave comments, drafts and disclosure state intact", async ({ page }) => {
  await page.goto("/");
  await draft(page).fill("Keep this discussion draft");
  await toggle(page).click();
  await activities(page).getByRole("button", { name: "common.filters", exact: true }).click();
  await expect(activities(page).locator("button button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "common.comments", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "common.updates", exact: true }).click();
  await expect(page.getByRole("button", { name: "common.updates", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  await expect(activities(page).getByText("high", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "common.state", exact: true }).click();
  await expect(page.getByRole("button", { name: "common.assignee", exact: true })).toBeDisabled();
  await expect(activities(page).getByText("A developing", { exact: true })).toHaveCount(0);
  await expect(activities(page).getByText("created the work item.", { exact: true })).toBeVisible();
  await expect(activities(page).getByRole("link", { name: "A owner" })).toBeVisible();
  await expectComments(page);
  await expect(draft(page)).toHaveValue("Keep this discussion draft");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "common.updates", exact: true }).click();
  await page.getByRole("button", { name: "common.state", exact: true }).click();
  await page.keyboard.press("Escape");
  await expectFullActivity(page);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
});

for (const [label, filters] of [
  ["only COMMENT", ["COMMENT"]],
  ["empty", []],
  ["unknown entry", ["UNKNOWN"]],
  ["invalid value", "invalid"],
  ["all activity categories without COMMENT", ["ACTIVITY", "STATE", "ASSIGNEE"]],
] as const) {
  test(`legacy filters (${label}) still display comments and all activities`, async ({ page }) => {
    await seedPreferences(page, filters);
    await page.goto("/");
    await expectComments(page);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await toggle(page).click();
    await expectFullActivity(page);
  });
}

for (const filters of [["STATE"], ["COMMENT", "STATE"]]) {
  test(`legacy ${JSON.stringify(filters)} retains its activity category without filtering comments`, async ({
    page,
  }) => {
    await seedPreferences(page, filters);
    await page.goto("/");
    await expectComments(page);
    await toggle(page).click();
    await expect(activities(page).getByText("A developing", { exact: true })).toBeVisible();
    await expect(activities(page).getByText("created the work item.", { exact: true })).toBeVisible();
    await expect(activities(page).getByText("high", { exact: true })).toHaveCount(0);
    await expect(activities(page).getByRole("link", { name: "A owner" })).toHaveCount(0);
    await expectComments(page);
  });
}

test("comments load independently while activities are pending, including updates while expanded", async ({ page }) => {
  await page.goto("/?activities-loading");
  await expectComments(page);
  await expect(comments(page).getByRole("status")).toHaveCount(0);
  await draft(page).fill("Draft while loading activities");
  await toggle(page).click();
  await expect(activities(page).getByRole("status")).toBeVisible();
  await page.getByRole("button", { name: "Load activities", exact: true }).click();
  await expectFullActivity(page);
  await expect(activities(page).getByRole("status")).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(draft(page)).toHaveValue("Draft while loading activities");
});

test("activities load independently while comments are pending", async ({ page }) => {
  await page.goto("/?comments-loading");
  await expect(comments(page).getByRole("status")).toBeVisible();
  await expect(draft(page)).toBeVisible();
  await toggle(page).click();
  await expectFullActivity(page);
  await page.getByRole("button", { name: "Load comments", exact: true }).click();
  await expectComments(page);
  await expect(comments(page).getByRole("status")).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
});

test("loaded empty lists have distinct empty states and retain the comment form", async ({ page }) => {
  await page.goto("/?empty");
  await expect(comments(page).getByText("activity_empty_state.no_comments", { exact: true })).toBeVisible();
  await expect(comments(page).getByRole("status")).toHaveCount(0);
  await expect(draft(page)).toBeVisible();
  await toggle(page).click();
  await expect(activities(page).getByText("activity_empty_state.no_activity", { exact: true })).toBeVisible();
  await expect(activities(page).getByRole("status")).toHaveCount(0);
});

test("all activity filters remain reachable with an empty panel on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/?empty");
  const filters = activities(page).getByRole("button", { name: "common.filters", exact: true });
  await expect(filters).toHaveCount(0);
  await toggle(page).click();
  await filters.click();
  // These clicks share menu state and must run sequentially.
  /* oxlint-disable no-await-in-loop */
  for (const name of ["common.updates", "common.state", "common.assignee"]) {
    const option = activities(page).getByRole("button", { name, exact: true });
    // Native clicks also verify hit testing: overflow-clipped menu rows cannot be clicked.
    await option.click();
    await expect(option).toHaveAttribute("aria-pressed", "false");
    await option.click();
    await expect(option).toHaveAttribute("aria-pressed", "true");
  }
  /* oxlint-enable no-await-in-loop */
  await page.keyboard.press("Escape");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(draft(page)).toBeVisible();
});

test("ASC and DESC order each region and keep the same draft when its position changes", async ({ page }) => {
  await page.goto("/");
  await draft(page).fill("Draft survives sort and collapse");
  await expectBefore(body(page, "A", 1), body(page, "A", 2));
  await expectBefore(body(page, "A", 2), draft(page));
  await toggle(page).click();
  const creation = activities(page).getByText("created the work item.", { exact: true });
  const priority = activities(page).getByText("high", { exact: true });
  await expectBefore(creation, priority);
  await expect(sort(page)).toHaveAccessibleName("common.sort.created_on: common.sort.desc");
  await expect(sort(page)).toHaveAttribute("title", "common.sort.created_on: common.sort.desc");
  await sort(page).click();
  await expect(sort(page)).toHaveAccessibleName("common.sort.created_on: common.sort.asc");
  await expect(sort(page)).toHaveAttribute("title", "common.sort.created_on: common.sort.asc");
  await expectBefore(body(page, "A", 2), body(page, "A", 1));
  await expectBefore(draft(page), body(page, "A", 2));
  await expectBefore(priority, creation);
  await expectBefore(comments(page), activities(page));
  await expect(draft(page)).toHaveValue("Draft survives sort and collapse");
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await toggle(page).click();
  await expect(draft(page)).toHaveValue("Draft survives sort and collapse");
  await toggle(page).click();
  await sort(page).click();
  await expectBefore(body(page, "A", 2), draft(page));
  await expect(draft(page)).toHaveValue("Draft survives sort and collapse");
  // Submission runs real CommentCreate/react-hook-form; the fixture only records
  // the operation, exposing stale form values that an editor-only check misses.
  await draft(page).press("Enter");
  await expect(page.getByTestId("submitted")).toHaveText(
    JSON.stringify([{ issueId: "A", html: "<p>Draft survives sort and collapse</p>" }])
  );
});

for (const [order, descending] of [
  ["desc", true],
  ["invalid", false],
] as const) {
  test(`stored sort ${order} gives matching comment, activity and editor order`, async ({ page }) => {
    await seedPreferences(page, ["COMMENT"], order);
    await page.goto("/");
    await expectComments(page);
    await toggle(page).click();
    await expectFullActivity(page);
    await expectBefore(body(page, "A", descending ? 2 : 1), body(page, "A", descending ? 1 : 2));
    await expectBefore(descending ? draft(page) : body(page, "A", 2), descending ? body(page, "A", 2) : draft(page));
    const creation = activities(page).getByText("created the work item.", { exact: true });
    const priority = activities(page).getByText("high", { exact: true });
    await expectBefore(descending ? priority : creation, descending ? creation : priority);
  });
}

test("switching work items cannot submit another work item's draft", async ({ page }) => {
  await page.goto("/");
  await draft(page).fill("A private draft");
  await toggle(page).click();
  await page.getByRole("button", { name: "Open B", exact: true }).click();
  await expectComments(page, "B");
  await expect(draft(page)).toHaveValue("");
  await draft(page).fill("B discussion");
  await draft(page).press("Enter");
  await expect(page.getByTestId("submitted")).toHaveText(
    JSON.stringify([{ issueId: "B", html: "<p>B discussion</p>" }])
  );
  await page.getByRole("button", { name: "Open A", exact: true }).click();
  await expectComments(page);
  await expect(draft(page)).not.toHaveValue("B discussion");
  await expect(comments(page)).not.toContainText("B discussion");
});

test("disabled details retain readable comments and expandable activity without comment actions", async ({ page }) => {
  await page.goto("/?disabled");
  await expectComments(page);
  await expect(draft(page)).toHaveCount(0);
  await expect(page.locator('[id="comment-A-comment-1"]').getByRole("button")).toHaveCount(0);
  await expect(page.locator('[id="comment-A-comment-2"]').getByRole("button")).toHaveCount(0);
  await toggle(page).click();
  await expectFullActivity(page);
  await sort(page).click();
  await expectBefore(body(page, "A", 2), body(page, "A", 1));
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
});

test("the real comment display preserves hash navigation through async loading and same-page hash changes", async ({
  page,
}) => {
  await seedPreferences(page, ["STATE"]);
  await page.goto("/?comments-loading&deep-link#comment-A-comment-2");
  await page.getByRole("button", { name: "Load comments", exact: true }).click();
  await expectComments(page);
  await expect(body(page, "A", 2)).toHaveClass(/border-accent-strong/);
  await expect(body(page, "A", 2)).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    window.location.hash = "comment-A-comment-1";
  });
  await expect(body(page, "A", 1)).toHaveClass(/border-accent-strong/);
  await expect(body(page, "A", 1)).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
});

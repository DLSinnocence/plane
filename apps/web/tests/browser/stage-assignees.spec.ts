/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test, type Page } from "@playwright/test";

const defaults = {
  backlog: ["developer"],
  todo: ["developer"],
  started: ["developer"],
  done: ["developer"],
  cancelled: ["developer"],
};
const card = (page: Page, name: string) =>
  page.getByTestId("stage-fields").getByText(name, { exact: true }).locator("..").locator("..");
const mapping = async (page: Page, id = "assignments") =>
  JSON.parse((await page.getByTestId(id).textContent()) || "null");
const closeMembers = async (page: Page) => {
  await page.getByRole("heading", { name: "Stage assignees", exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
};

test("only unstarted and started stages are configurable and every stage defaults to the creator", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?stage-assignees&legacy");
  const fields = page.getByTestId("stage-fields");
  await expect(fields.getByText("Planning", { exact: true })).toBeVisible();
  await expect(fields.getByText("Developing", { exact: true })).toBeVisible();
  await Promise.all(
    ["Backlog", "Done", "Cancelled"].map((name) => expect(fields.getByText(name, { exact: true })).toHaveCount(0))
  );
  await expect(fields.getByRole("button")).toHaveCount(2);
  await expect(card(page, "Planning").getByRole("button")).toContainText("Developer");
  await expect(card(page, "Developing").getByRole("button")).toContainText("Developer");
  await expect(card(page, "Planning")).toContainText("workflows.state_assignees.current");
  await expect.poll(() => mapping(page)).toEqual(defaults);
  await page.getByRole("button", { name: "Submit workflow" }).click();
  await expect
    .poll(() => mapping(page, "submitted"))
    .toEqual({
      name: "Workflow work item",
      state_id: "todo",
      state_assignees: defaults,
    });
  expect(errors).toEqual([]);
});

test("stage selection, clearing, and submission remain independent without reset buttons", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?stage-assignees");
  const planning = card(page, "Planning");
  const developing = card(page, "Developing");
  await planning.getByRole("button").first().click();
  await page.getByRole("option", { name: /you$/ }).click();
  await page.getByRole("option", { name: /Reviewer/ }).click();
  await closeMembers(page);
  await expect.poll(() => mapping(page)).toEqual({ ...defaults, todo: ["reviewer"] });
  await expect(developing.getByRole("button").first()).toContainText("Developer");

  await developing.getByRole("button").first().click();
  await page.getByRole("option", { name: /you$/ }).click();
  await closeMembers(page);
  await expect.poll(() => mapping(page)).toEqual({ ...defaults, todo: ["reviewer"], started: [] });
  await expect(developing.getByRole("button").first()).toContainText("workflows.state_assignees.unassigned");
  await expect(developing.getByRole("button")).toHaveCount(1);
  await developing.getByRole("button").click();
  await page.getByRole("option", { name: /you$/ }).click();
  await closeMembers(page);
  await expect.poll(() => mapping(page)).toEqual({ ...defaults, todo: ["reviewer"] });
  await expect(planning.getByRole("button").first()).toContainText("Reviewer");

  await page.getByRole("button", { name: "Submit workflow" }).click();
  await expect
    .poll(() => mapping(page, "submitted"))
    .toEqual({
      name: "Workflow work item",
      state_id: "todo",
      state_assignees: { ...defaults, todo: ["reviewer"] },
    });
  await planning.getByRole("button").first().click();
  await page.getByRole("option", { name: /Reviewer/ }).click();
  await closeMembers(page);
  await page.getByRole("button", { name: "Submit workflow" }).click();
  await expect
    .poll(() => mapping(page, "submitted"))
    .toEqual({
      name: "Workflow work item",
      state_id: "todo",
      state_assignees: { ...defaults, todo: [] },
    });
  await expect(planning.getByRole("button")).toHaveCount(1);
  await planning.getByRole("button").click();
  await page.getByRole("option", { name: /you$/ }).click();
  await closeMembers(page);
  await expect.poll(() => mapping(page)).toEqual(defaults);
  expect(errors).toEqual([]);
});

test("disabled stage configuration retains visible creators without interactive selection", async ({ page }) => {
  await page.goto("/?stage-assignees&disabled");
  await Promise.all(
    ["Planning", "Developing"].flatMap((name) => [
      expect(card(page, name).getByRole("button")).toBeDisabled(),
      expect(card(page, name).getByRole("button")).toContainText("Developer"),
    ])
  );
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect.poll(() => mapping(page)).toEqual(defaults);
});

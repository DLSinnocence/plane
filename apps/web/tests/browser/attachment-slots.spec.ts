/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test, type Page } from "@playwright/test";

const action = (page: Page, name: string) =>
  page.getByRole("button", { name: `attachment.slots.${name}`, exact: true });
const dialog = (page: Page) => page.getByRole("dialog").last();
const state = async (page: Page) => JSON.parse((await page.getByTestId("attachment-state").textContent()) || "{}");
const slotRow = (page: Page, name: string) =>
  page
    .locator('[data-testid^="attachment-slot-"]:has(> [data-testid^="attachment-slot-label-"])')
    .filter({ has: page.getByRole("button", { name, exact: true }) });
const menuItem = (page: Page, name: string) =>
  page.getByRole("menuitem", { name: `attachment.slots.${name}`, exact: true });
const downloadMenuItem = (page: Page) =>
  page.getByRole("menuitem", { name: "attachment.preview.download", exact: true });
const openSlotMenu = async (page: Page, id = "design") => {
  await page.getByTestId(`attachment-slot-actions-${id}`).locator('button[aria-haspopup="menu"]').click();
};
const addEmpty = (page: Page) => page.getByTestId("add-empty-attachment");
const library = (page: Page) => page.getByTestId("attachment-template-library-button");
const nameInput = (page: Page) => page.locator('[data-testid^="attachment-slot-name-input-"]');
const upload = { name: "replacement.txt", mimeType: "text/plain", buffer: Buffer.from("new") };

const zip39KiB = Buffer.alloc(39 * 1024);
// Valid empty ZIP archive padded by its ZIP comment to exactly 39 KiB.
zip39KiB.writeUInt32LE(0x06054b50, 0);
zip39KiB.writeUInt16LE(zip39KiB.length - 22, 20);
for (const role of ["admin", "member", "guest"]) {
  test(`${role} uploads the same 39KiB ZIP through Attach into one named row at a 5MiB limit`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/?attachment-slots&empty&limit-5mb&role=${role}`);
    const uploadButton = page
      .getByTestId("top-attachment-actions")
      .getByRole("button", { name: "common.attach", exact: true });
    await expect(uploadButton).toBeEnabled();
    const chooserPromise = page.waitForEvent("filechooser");
    await uploadButton.click();
    await (await chooserPromise).setFiles({ name: "same-39kb.zip", mimeType: "application/zip", buffer: zip39KiB });
    const row = page.getByTestId("attachment-slot-slot-1");
    await expect(row.getByRole("link")).toHaveText("same-39kb.zip");
    await expect(page.getByTestId("attachment-slot-name-slot-1")).toHaveText("附件");
    await expect(page.getByTestId("slots").getByRole("link", { name: "same-39kb.zip", exact: true })).toHaveCount(1);
    await expect(page.getByTestId("slots").getByRole("button", { name: /common.attachments/ })).toContainText("1");
    await expect
      .poll(async () =>
        (await state(page)).files.map((item: { attributes: { name: string; size: number } }) => item.attributes)
      )
      .toEqual([{ name: "same-39kb.zip", size: 39 * 1024 }]);
    await expect
      .poll(async () => (await state(page)).slots.map((item: { name: string }) => item.name))
      .toEqual(["附件"]);
    await expect
      .poll(async () => (await state(page)).calls.filter((item: string) => item.startsWith("upload:")))
      .toEqual(["upload:same-39kb.zip:auto"]);
    if (role === "guest") {
      await expect(page.getByTestId("attachment-slot-name-slot-1")).toBeDisabled();
      await row.locator('button[aria-haspopup="menu"]').click();
      await expect(downloadMenuItem(page)).toBeVisible();
      await expect(page.getByRole("menuitem")).toHaveCount(1);
      await Promise.all(
        ["replace", "delete_slot", "delete_file"].map((name) => expect(menuItem(page, name)).toHaveCount(0))
      );
    }
    expect(errors).toEqual([]);
  });
}

test("member fills an empty row and direct Attach provisions a second unique named row", async ({ page }) => {
  await page.goto("/?attachment-slots&empty&role=member");
  await addEmpty(page).click();
  await nameInput(page).press("Escape");
  await page.getByTestId("attachment-slot-slot-1").locator('input[type="file"]').setInputFiles(upload);
  await expect(page.getByTestId("attachment-slot-file-slot-1")).toHaveText("replacement.txt");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("top-attachment-actions").getByRole("button", { name: "common.attach", exact: true }).click();
  await (await chooserPromise).setFiles({ ...upload, name: "second.txt" });
  await expect
    .poll(async () => (await state(page)).slots.map((slot: { name: string }) => slot.name))
    .toEqual(["附件", "附件2"]);
  await expect(page.getByTestId("slots").getByRole("link")).toHaveCount(2);
  await expect(page.getByTestId("slots").getByRole("button", { name: /common.attachments/ })).toContainText("2");
  await expect.poll(async () => (await state(page)).files.length).toBe(2);
});

test("unified content renders a pending upload once and counts only its loaded row", async ({ page }) => {
  await page.goto("/?attachment-slots&empty-slot&uploading");
  const section = page.getByTestId("slots");
  await expect(section.getByText("pending.txt", { exact: true })).toHaveCount(1);
  await expect(section.getByText("25% done", { exact: true })).toHaveCount(1);
  await expect(section.getByRole("button", { name: /common.attachments/ })).toContainText("1");
  await expect(page.getByTestId("attachment-slot-design")).toBeVisible();
  await expect.poll(async () => (await state(page)).files).toEqual([]);
});

for (const entry of ["slots"]) {
  test(`${entry} shows HTTP 403 and the actual permission reason, then provider reason without size misclassification`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?attachment-slots&role=member&own-file&limit-5mb");
    const section = page.getByTestId(entry);
    const picker = (entry === "slots" ? slotRow(page, "Design") : section).locator('input[type="file"]');
    await picker.setInputFiles({ ...upload, name: "forbidden.txt" });
    await expect(section.getByRole("alert")).toContainText("attachment.permission_denied");
    await expect(section.getByRole("alert")).toContainText("HTTP 403: Uploads denied by project policy");
    await expect(section.getByRole("alert")).toContainText("size=3; limit=5242880");
    await expect(section.getByRole("alert")).not.toContainText("attachment.file_size_limit");
    await picker.setInputFiles({ ...upload, name: "provider.txt" });
    await expect(section.getByRole("alert")).toContainText(
      "HTTP 502: StorageUnavailable; Bucket temporarily unavailable"
    );
    await expect(section.getByRole("alert")).not.toContainText("attachment.file_size_limit");
    await expect(section.getByRole("alert")).not.toContainText("private-request-id");
    await expect(slotRow(page, "Design").getByRole("link")).toContainText("old.txt");
    await expect.poll(async () => (await state(page)).files.length).toBe(1);
    expect(errors).toEqual([]);
  });
  test(`${entry} shows actual selected bytes and limit when the file is too large`, async ({ page }) => {
    await page.goto("/?attachment-slots&limit-5mb");
    const section = page.getByTestId(entry);
    await (entry === "slots" ? slotRow(page, "Design") : section)
      .locator('input[type="file"]')
      .setInputFiles({ name: "large.zip", mimeType: "application/zip", buffer: Buffer.alloc(5 * 1024 ** 2 + 1) });
    await expect(section.getByRole("alert")).toContainText("attachment.file_size_limit");
    await expect(section.getByRole("alert")).toContainText("size=5242881; limit=5242880");
    await expect(section.getByRole("alert")).toContainText("file-too-large");
    await expect
      .poll(async () => (await state(page)).calls.filter((item: string) => item.startsWith("upload:")))
      .toEqual([]);
  });
}

test("slot fetch failure displays HTTP status and API reason", async ({ page }) => {
  await page.goto("/?attachment-slots&fetch-forbidden");
  await expect(page.getByTestId("slots").getByRole("alert")).toContainText(
    "HTTP 403: Slot access denied by project policy"
  );
  await expect(action(page, "retry")).toBeEnabled();
});

test("adds slots, saves a template, and applies missing names idempotently", async ({ page }) => {
  await page.goto("/?attachment-slots&empty&role=member");
  await addEmpty(page).click();
  await nameInput(page).fill("Design");
  await nameInput(page).press("Enter");
  await expect(slotRow(page, "Design")).toBeVisible();
  await library(page).click();
  await action(page, "save_template").click();
  await dialog(page).getByRole("textbox").first().fill("Current slots");
  await dialog(page).getByRole("button", { name: "attachment.slots.save", exact: true }).click();
  await expect(page.getByText("Current slots", { exact: true })).toBeVisible();
  await expect
    .poll(
      async () => (await state(page)).templates.find((item: { name: string }) => item.name === "Current slots")?.slots
    )
    .toEqual(["Design"]);
  const review = page.getByText("Review template", { exact: true }).locator("..");
  await review.getByRole("button", { name: "attachment.slots.apply", exact: true }).click();
  await expect(slotRow(page, "Approval")).toBeVisible();
  await library(page).click();
  await review.getByRole("button", { name: "attachment.slots.apply", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).slots.map((item: { name: string }) => item.name))
    .toEqual(["Design", "Approval"]);
  await expect
    .poll(async () => (await state(page)).slots.every((slot: { attachment: unknown }) => slot.attachment === null))
    .toBe(true);
  await expect.poll(async () => (await state(page)).files).toEqual([]);
  await expect(page.getByTestId("slots").getByRole("button", { name: /common.attachments/ })).toContainText("2");
  await expect
    .poll(async () => (await state(page)).calls.filter((item: string) => item === "applyTemplate").length)
    .toBe(2);
});

test("replacement failure retains the old file and success leaves only the new file", async ({ page }) => {
  await page.goto("/?attachment-slots");
  const design = slotRow(page, "Design");
  await expect(design.getByRole("link")).toContainText("old.txt");
  await design.locator('input[type="file"]').setInputFiles({ ...upload, name: "fail.txt" });
  await expect(page.getByTestId("slots").getByRole("alert")).toContainText("Upload rejected");
  await expect(design.getByRole("link")).toContainText("old.txt");
  await expect.poll(async () => (await state(page)).files.map((item: { id: string }) => item.id)).toEqual(["old"]);
  await design.locator('input[type="file"]').setInputFiles(upload);
  await expect(design.getByRole("link")).toContainText("replacement.txt");
  await expect(page.getByTestId("slots").getByRole("link")).toHaveCount(1);
  await expect(page.getByTestId("slots")).not.toContainText("old.txt");
  await expect
    .poll(async () => (await state(page)).files.map((item: { attributes: { name: string } }) => item.attributes.name))
    .toEqual(["replacement.txt"]);
});

test("deleting a row confirms file deletion while cancellation preserves both", async ({ page }) => {
  await page.goto("/?attachment-slots");
  await openSlotMenu(page);
  await menuItem(page, "delete_slot").click();
  await expect(dialog(page)).toContainText("Design");
  await expect(dialog(page)).not.toContainText(/ordinary|普通/i);
  await dialog(page).getByRole("button", { name: "attachment.slots.close", exact: true }).click();
  await expect(slotRow(page, "Design").getByRole("link")).toHaveText("old.txt");
  await expect.poll(async () => [(await state(page)).slots.length, (await state(page)).files.length]).toEqual([1, 1]);
  await openSlotMenu(page);
  await menuItem(page, "delete_slot").click();
  await dialog(page).getByRole("button", { name: "attachment.slots.confirm_delete", exact: true }).click();
  await expect(page.getByTestId("attachment-slot-design")).toHaveCount(0);
  await expect.poll(async () => [(await state(page)).slots.length, (await state(page)).files.length]).toEqual([0, 0]);
});

test("rename failure keeps the inline input and Escape cancels without closing peek", async ({ page }) => {
  await page.goto("/?attachment-slots");
  await page.getByTestId("attachment-slot-name-design").click();
  await nameInput(page).fill("reject");
  await nameInput(page).press("Enter");
  await expect(page.getByTestId("slots").getByRole("alert")).toBeVisible();
  await expect(nameInput(page)).toHaveValue("reject");
  await nameInput(page).press("Escape");
  await expect(slotRow(page, "Design")).toBeVisible();
  await expect(page.getByTestId("attachment-peek")).toBeVisible();
});

test("only file owners or admins can replace files or delete populated rows", async ({ page }) => {
  await page.goto("/?attachment-slots&role=member");
  await expect(slotRow(page, "Design")).toBeVisible();
  await expect(slotRow(page, "Design").locator('input[type="file"]')).toHaveCount(0);
  const trigger = page.getByTestId("attachment-slot-actions-design").locator('button[aria-haspopup="menu"]');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("menuitem")).toHaveText(["attachment.preview.download"]);
  await Promise.all(
    ["delete_file", "delete_slot", "replace"].map((name) => expect(menuItem(page, name)).toHaveCount(0))
  );
  await trigger.click();
  await page.getByTestId("attachment-slot-name-design").click();
  await nameInput(page).fill("Member renamed");
  await nameInput(page).press("Enter");
  await expect(slotRow(page, "Member renamed")).toBeVisible();
  await Promise.all(
    ["delete_file", "delete_slot", "replace"].map((name) => expect(menuItem(page, name)).toHaveCount(0))
  );
});

for (const query of ["role=member&own-file", "role=admin"]) {
  test(`${query} can replace a file and delete its whole row`, async ({ page }) => {
    await page.goto(`/?attachment-slots&${query}`);
    await openSlotMenu(page);
    await Promise.all(["delete_slot", "replace"].map((name) => expect(menuItem(page, name)).toBeVisible()));
    await expect(menuItem(page, "delete_file")).toHaveCount(0);
    await expect(page.getByRole("menuitem")).toHaveText([
      "attachment.preview.download",
      "attachment.slots.replace",
      "attachment.slots.delete_slot",
    ]);
    await menuItem(page, "delete_slot").click();
    await dialog(page).getByRole("button", { name: "attachment.slots.confirm_delete", exact: true }).click();
    await expect(page.getByTestId("attachment-slot-design")).toHaveCount(0);
    await expect.poll(async () => [(await state(page)).slots.length, (await state(page)).files.length]).toEqual([0, 0]);
    await expect(page.getByTestId("slots").getByRole("button", { name: /common.attachments/ })).toContainText("0");
  });
}

test("guest sees slot files but cannot configure slots or templates", async ({ page }) => {
  await page.goto("/?attachment-slots&role=guest");
  await expect(slotRow(page, "Design").getByRole("link")).toContainText("old.txt");
  await expect(page.getByTestId("attachment-slot-name-design")).toBeDisabled();
  await expect(addEmpty(page)).toHaveCount(0);
  await expect(library(page)).toHaveCount(0);
  await expect(action(page, "replace")).toHaveCount(0);
  await expect.poll(async () => (await state(page)).calls.every((call: string) => call === "fetchSlots")).toBe(true);
});

test("disabled issue allows workspace template browsing but prevents issue modifications", async ({ page }) => {
  await page.goto("/?attachment-slots&disabled&role=member");
  await expect(slotRow(page, "Design").getByRole("link")).toBeVisible();
  await expect(action(page, "add")).toHaveCount(0);
  await expect(action(page, "replace")).toHaveCount(0);
  await expect(action(page, "delete_slot")).toHaveCount(0);
  await library(page).click();
  await expect(action(page, "apply")).toBeDisabled();
  await expect(action(page, "new_template")).toBeEnabled();
  await dialog(page).getByRole("button", { name: "attachment.slots.close", exact: true }).click();
  await expect.poll(async () => [...new Set((await state(page)).calls)]).toEqual(["fetchSlots", "fetchTemplates"]);
});

for (const collapsed of [false, true]) {
  test(`plus directly creates a persistent empty attachment and focuses its inline name (${collapsed ? "collapsed" : "open"})`, async ({
    page,
  }) => {
    await page.goto(`/?attachment-slots&empty${collapsed ? "&collapsed" : ""}`);
    let choosers = 0;
    page.on("filechooser", () => choosers++);
    const trigger = page.getByTestId("slots").getByRole("button", { name: /common.attachments/ });
    await expect(trigger).toHaveAttribute("aria-expanded", String(!collapsed));
    await expect(library(page)).toBeVisible();
    await addEmpty(page).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(nameInput(page)).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toContainText("1");
    const initial = await nameInput(page).inputValue();
    expect(initial).toBe("附件");
    await expect
      .poll(async () =>
        (await state(page)).slots.map((slot: { name: string; attachment: unknown }) => ({
          name: slot.name,
          attachment: slot.attachment,
        }))
      )
      .toEqual([{ name: initial, attachment: null }]);
    expect(
      await nameInput(page).evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])
    ).toEqual([0, initial.length]);
    await nameInput(page).pressSequentially("Research");
    await expect(nameInput(page)).toHaveValue("Research");
    await expect(nameInput(page)).toBeFocused();
    await nameInput(page).press("Enter");
    await expect(slotRow(page, "Research")).toBeVisible();
    await expect.poll(async () => (await state(page)).slots[0].name).toBe("Research");
    await trigger.click();
    await expect(library(page)).toBeVisible();
    await trigger.click();
    await expect(slotRow(page, "Research")).toBeVisible();
    expect(choosers).toBe(0);
  });
}

test("inline names save on blur and duplicate errors preserve typed input", async ({ page }) => {
  await page.goto("/?attachment-slots");
  await page.getByTestId("attachment-slot-name-design").click();
  await nameInput(page).fill("Updated design");
  await page.getByRole("heading").click();
  await expect(slotRow(page, "Updated design")).toBeVisible();
  await addEmpty(page).click();
  await nameInput(page).fill("updated DESIGN");
  await nameInput(page).press("Enter");
  await expect(nameInput(page)).toHaveValue("updated DESIGN");
  await expect(page.getByTestId("slots").getByRole("alert")).toContainText("attachment.slots.duplicate");
  await nameInput(page).press("Escape");
  await expect(nameInput(page)).toHaveCount(0);
  await expect(page.getByTestId("attachment-peek")).toBeVisible();
  await expect.poll(async () => (await state(page)).slots.length).toBe(2);
});

test("failed empty creation leaves no phantom attachment or naming dialog", async ({ page }) => {
  await page.goto("/?attachment-slots&empty&create-fail");
  await addEmpty(page).click();
  await expect(page.getByTestId("slots").getByRole("alert")).toBeVisible();
  await expect(addEmpty(page)).toBeEnabled();
  await expect(nameInput(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => (await state(page)).slots).toEqual([]);
});

test("template library follows Attach only in top actions and modal input keeps the real peek open", async ({
  page,
}) => {
  await page.goto("/?attachment-slots&collapsed");
  const top = page.getByTestId("top-attachment-actions");
  await expect(top.locator("button:not(:has(button))")).toHaveCount(2);
  await expect(top.locator("button:not(:has(button))").nth(0)).toHaveText("common.attach");
  await expect(top.locator("button:not(:has(button))").nth(1)).toHaveAttribute(
    "data-testid",
    "attachment-template-library-button"
  );
  await expect(page.getByTestId("slots").getByTestId("attachment-template-library-button")).toHaveCount(0);
  await library(page).click();
  await action(page, "new_template").click();
  const input = dialog(page).getByRole("textbox").first();
  await input.click();
  await input.pressSequentially("Portal template");
  await expect(input).toHaveValue("Portal template");
  await expect(input).toBeFocused();
  await expect(page.getByTestId("attachment-peek")).toBeVisible();
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(page.getByTestId("attachment-peek")).toBeVisible();
  await dialog(page).getByRole("button", { name: "attachment.slots.close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByTestId("outside-peek").click();
  await expect(page.getByTestId("peek-closed")).toBeVisible();
});

test("template add and edit preserve independent slot input rows inside peek", async ({ page }) => {
  await page.goto("/?attachment-slots");
  await library(page).click();
  await action(page, "new_template").click();
  await dialog(page).getByRole("textbox").nth(0).fill("Created template");
  await dialog(page).getByRole("textbox").nth(1).fill("Spec");
  await dialog(page).getByRole("button", { name: "attachment.slots.add", exact: true }).click();
  await dialog(page).getByRole("textbox").nth(2).fill("Evidence");
  await expect(dialog(page).getByRole("textbox")).toHaveCount(3);
  await dialog(page).getByRole("button", { name: "attachment.slots.save", exact: true }).click();
  const created = page.getByText("Created template", { exact: true }).locator("..");
  await expect(created).toContainText("Spec · Evidence");
  await created.getByRole("button", { name: "attachment.slots.edit", exact: true }).click();
  await dialog(page).getByRole("textbox").nth(0).fill("Edited template");
  await dialog(page).getByRole("button", { name: "attachment.slots.remove", exact: true }).first().click();
  await expect(dialog(page).getByRole("textbox").nth(1)).toHaveValue("Evidence");
  await dialog(page).getByRole("textbox").nth(1).fill("Final evidence");
  await dialog(page).getByRole("button", { name: "attachment.slots.save", exact: true }).click();
  await expect(page.getByText("Edited template", { exact: true })).toBeVisible();
  await expect
    .poll(
      async () => (await state(page)).templates.find((item: { name: string }) => item.name === "Edited template")?.slots
    )
    .toEqual(["Final evidence"]);
  await expect(page.getByTestId("attachment-peek")).toBeVisible();
});

test("new empty attachment uploads directly while its unchanged default name is still editing", async ({ page }) => {
  await page.goto("/?attachment-slots&empty");
  await addEmpty(page).click();
  await expect(nameInput(page)).toBeFocused();
  const defaultName = await nameInput(page).inputValue();
  const center = page.getByTestId("attachment-slot-file-slot-1");
  await expect(center).toBeEnabled();
  const chooserPromise = page.waitForEvent("filechooser");
  await center.click();
  await (await chooserPromise).setFiles(upload);
  await expect(center).toHaveText("replacement.txt");
  await expect(center).toHaveAttribute("href", "/files/replacement.txt");
  await expect(nameInput(page)).toHaveCount(0);
  await expect(page.getByTestId("attachment-slot-name-slot-1")).toHaveText(defaultName);
  await expect.poll(async () => (await state(page)).slots[0].name).toBe(defaultName);
  await expect
    .poll(async () => (await state(page)).calls.filter((call: string) => call.startsWith("upload:")))
    .toEqual(["upload:replacement.txt:slot-1"]);
  await expect(page.getByTestId("attachment-peek")).toBeVisible();
});

test("empty center uploads with the native picker while the left label only edits", async ({ page }) => {
  await page.goto("/?attachment-slots&empty");
  let choosers = 0;
  page.on("filechooser", () => choosers++);
  await addEmpty(page).click();
  await nameInput(page).press("Escape");
  const label = page.getByTestId("attachment-slot-name-slot-1");
  await label.click();
  await nameInput(page).fill("Evidence");
  await nameInput(page).press("Enter");
  await expect(label).toHaveText("Evidence");
  expect(choosers).toBe(0);
  const center = page.getByTestId("attachment-slot-file-slot-1");
  await expect(center).toHaveText("attachment.slots.empty_slot");
  await expect(center).toHaveJSProperty("tagName", "BUTTON");
  const chooserPromise = page.waitForEvent("filechooser");
  await center.click();
  await (await chooserPromise).setFiles(upload);
  await expect(center).toHaveJSProperty("tagName", "A");
  await expect(center).toHaveAttribute("href", "/files/replacement.txt");
  await expect(center).toHaveText("replacement.txt");
  expect(choosers).toBe(1);
  await expect
    .poll(async () => (await state(page)).calls.filter((call: string) => call.startsWith("upload:")))
    .toEqual(["upload:replacement.txt:slot-1"]);
});

test("compact row hides actions until the real menu opens and replacement uses its picker", async ({ page }) => {
  await page.goto("/?attachment-slots");
  const row = page.getByTestId("attachment-slot-design");
  const center = page.getByTestId("attachment-slot-file-design");
  await expect(center).toHaveAttribute("href", "/files/old.txt");
  await expect(center).toHaveText("old.txt");
  await expect(row.getByRole("link")).toHaveCount(1);
  await expect(downloadMenuItem(page)).not.toBeVisible();
  await Promise.all(
    ["replace", "delete_file", "delete_slot"].flatMap((name) => [
      expect(action(page, name)).toHaveCount(0),
      expect(menuItem(page, name)).not.toBeVisible(),
    ])
  );
  await openSlotMenu(page);
  await expect(page.getByRole("menuitem").first()).toHaveText("attachment.preview.download");
  await Promise.all(["replace", "delete_slot"].map((name) => expect(menuItem(page, name)).toBeVisible()));
  await expect(menuItem(page, "delete_file")).toHaveCount(0);
  await openSlotMenu(page);
  await expect(menuItem(page, "replace")).not.toBeVisible();
  await expect(page.getByTestId("attachment-peek")).toBeVisible();
  await openSlotMenu(page);
  const chooserPromise = page.waitForEvent("filechooser");
  await menuItem(page, "replace").click();
  await (await chooserPromise).setFiles(upload);
  await expect(center).toHaveText("replacement.txt");
  await expect(page.getByTestId("slots")).not.toContainText("old.txt");
  await expect.poll(async () => (await state(page)).files.length).toBe(1);
  await expect(menuItem(page, "replace")).not.toBeVisible();
});

for (const readonly of ["role=guest", "role=viewer", "disabled&role=member"]) {
  for (const empty of [false, true]) {
    test(`${readonly} cannot edit or upload to ${empty ? "empty" : "populated"} slots`, async ({ page }) => {
      await page.goto(`/?attachment-slots&${readonly}${empty ? "&empty-slot" : ""}`);
      const row = page.getByTestId("attachment-slot-design");
      await expect(row).toBeVisible();
      await expect(page.getByTestId("attachment-slot-name-design")).toBeDisabled();
      await expect(row.locator('input[type="file"]')).toHaveCount(0);
      if (empty) {
        await expect(row.locator('button[aria-haspopup="menu"]')).toHaveCount(0);
        await expect(page.getByTestId("attachment-slot-file-design")).toBeDisabled();
        await expect(downloadMenuItem(page)).toHaveCount(0);
      } else {
        await expect(row.getByRole("link")).toHaveAttribute("href", "/files/old.txt");
        await openSlotMenu(page);
        await expect(page.getByRole("menuitem")).toHaveText(["attachment.preview.download"]);
      }
      await Promise.all(
        ["replace", "delete_file", "delete_slot"].map((name) => expect(menuItem(page, name)).not.toBeVisible())
      );
      await expect.poll(async () => [...new Set((await state(page)).calls)]).toEqual(["fetchSlots"]);
    });
  }
}

test("an editable empty slot offers Delete without Download or Replace", async ({ page }) => {
  await page.goto("/?attachment-slots&empty-slot");
  await openSlotMenu(page);
  await expect(page.getByRole("menuitem")).toHaveText(["attachment.slots.delete_slot"]);
  await expect(downloadMenuItem(page)).toHaveCount(0);
  await expect(menuItem(page, "replace")).toHaveCount(0);
});

for (const width of [1280, 375]) {
  test(`attachment row keeps left label, centered file and right actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?attachment-slots&long-names");
    const row = page.getByTestId("attachment-slot-design");
    await expect(row).toBeVisible();
    const bounds = async (id: string) => {
      const box = await page.getByTestId(id).boundingBox();
      expect(box).not.toBeNull();
      return box!;
    };
    const r = await bounds("attachment-slot-design");
    const left = await bounds("attachment-slot-label-design");
    const center = await bounds("attachment-slot-content-design");
    const right = await bounds("attachment-slot-actions-design");
    const file = await bounds("attachment-slot-file-design");
    expect(r.height).toBeGreaterThanOrEqual(44);
    expect(r.height).toBeLessThan(64);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(width);
    expect(left.x).toBeLessThan(center.x);
    expect(left.x + left.width).toBeLessThanOrEqual(center.x + 1);
    expect(center.x + center.width).toBeLessThanOrEqual(right.x + 1);
    expect(Math.abs(center.x + center.width / 2 - (r.x + r.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(file.x + file.width / 2 - (r.x + r.width / 2))).toBeLessThanOrEqual(2);
    expect(right.x + right.width).toBeLessThanOrEqual(r.x + r.width);
    const rowStyle = await row.evaluate((el) => ({
      border: getComputedStyle(el).borderTopWidth,
      radius: getComputedStyle(el).borderTopLeftRadius,
      overflows: el.scrollWidth > el.clientWidth,
    }));
    expect(rowStyle).toEqual({ border: "0px", radius: "0px", overflows: false });
    await Promise.all(
      ["attachment-slot-name-design", "attachment-slot-file-design"].map(async (id) => {
        const truncation = await page.getByTestId(id).evaluate((el) => {
          const text = el.matches(".truncate") ? el : el.querySelector(".truncate")!;
          return { ellipsis: getComputedStyle(text).textOverflow, clipped: text.scrollWidth > text.clientWidth };
        });
        expect(truncation.ellipsis).toBe("ellipsis");
        if (width === 375) expect(truncation.clipped).toBe(true);
      })
    );
  });
}

test("Escape closes the peek when no modal or inline input owns it", async ({ page }) => {
  await page.goto("/?attachment-slots");
  await page.getByRole("heading").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("peek-closed")).toBeVisible();
});

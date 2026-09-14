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
const slotCard = (page: Page, name: string) =>
  page
    .locator('[data-testid^="attachment-slot-"]')
    .filter({ has: page.getByRole("button", { name, exact: true }) })
    .filter({ has: page.locator('[data-testid^="attachment-slot-name-"]') });
const addEmpty = (page: Page) => page.getByTestId("add-empty-attachment");
const library = (page: Page) => page.getByTestId("attachment-template-library-button");
const nameInput = (page: Page) => page.locator('[data-testid^="attachment-slot-name-input-"]');
const upload = { name: "replacement.txt", mimeType: "text/plain", buffer: Buffer.from("new") };

const zip39KiB = Buffer.alloc(39 * 1024);
// Valid empty ZIP archive padded by its ZIP comment to exactly 39 KiB.
zip39KiB.writeUInt32LE(0x06054b50, 0);
zip39KiB.writeUInt16LE(zip39KiB.length - 22, 20);
for (const role of ["admin", "member"]) {
  test(`${role} uploads the same 39KiB ZIP through the real ordinary quick action at a 5MiB limit`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/?attachment-slots&empty&limit-5mb&role=${role}`);
    const quickUpload = page.getByTestId("ordinary-quick-upload");
    const uploadButton = quickUpload.getByRole("button", { name: /Upload ordinary/ });
    await expect(uploadButton).toBeEnabled();
    const chooserPromise = page.waitForEvent("filechooser");
    await uploadButton.click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "same-39kb.zip", mimeType: "application/zip", buffer: zip39KiB });
    await expect(page.getByTestId("ordinary")).toContainText("same-39kb.zip");
    await expect
      .poll(async () =>
        (await state(page)).files.map((item: { attributes: { name: string; size: number } }) => item.attributes)
      )
      .toEqual([{ name: "same-39kb.zip", size: 39 * 1024 }]);
    await expect
      .poll(async () => (await state(page)).calls.filter((item: string) => item.startsWith("upload:")))
      .toEqual(["upload:same-39kb.zip:ordinary"]);
    await expect.poll(async () => (await state(page)).slots).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const entry of ["slots", "ordinary-upload-dropzone"]) {
  test(`${entry} shows HTTP 403 and the actual permission reason, then provider reason without size misclassification`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?attachment-slots&role=member&limit-5mb");
    const section = page.getByTestId(entry);
    const picker = (entry === "slots" ? slotCard(page, "Design") : section).locator('input[type="file"]');
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
    await expect(slotCard(page, "Design").getByRole("link")).toContainText("old.txt");
    await expect.poll(async () => (await state(page)).files.length).toBe(1);
    expect(errors).toEqual([]);
  });
  test(`${entry} shows actual selected bytes and limit when the file is too large`, async ({ page }) => {
    await page.goto("/?attachment-slots&limit-5mb");
    const section = page.getByTestId(entry);
    await (entry === "slots" ? slotCard(page, "Design") : section)
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
  await expect(slotCard(page, "Design")).toBeVisible();
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
  await expect(slotCard(page, "Approval")).toBeVisible();
  await library(page).click();
  await review.getByRole("button", { name: "attachment.slots.apply", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).slots.map((item: { name: string }) => item.name))
    .toEqual(["Design", "Approval"]);
  await expect
    .poll(async () => (await state(page)).calls.filter((item: string) => item === "applyTemplate").length)
    .toBe(2);
});

test("replacement failure retains the old file, success releases it to ordinary attachments", async ({ page }) => {
  await page.goto("/?attachment-slots");
  const design = slotCard(page, "Design");
  await expect(design.getByRole("link")).toContainText("old.txt");
  await expect(page.getByTestId("ordinary")).not.toContainText("old.txt");
  await design.locator('input[type="file"]').setInputFiles({ ...upload, name: "fail.txt" });
  await expect(page.getByTestId("slots").getByRole("alert")).toContainText("Upload rejected");
  await expect(design.getByRole("link")).toContainText("old.txt");
  await expect(page.getByTestId("ordinary")).not.toContainText("old.txt");
  await design.locator('input[type="file"]').setInputFiles(upload);
  await expect(design.getByRole("link")).toContainText("replacement.txt");
  await expect(page.getByTestId("ordinary")).toContainText("old.txt");
  await expect(page.getByTestId("ordinary")).not.toContainText("replacement.txt");
});

test("deleting a slot requires confirmation and keeps its file in the ordinary list", async ({ page }) => {
  await page.goto("/?attachment-slots");
  await action(page, "delete_slot").click();
  await expect(dialog(page)).toContainText("attachment.slots.delete_slot_help");
  await dialog(page).getByRole("button", { name: "attachment.slots.close", exact: true }).click();
  await expect(slotCard(page, "Design")).toBeVisible();
  await action(page, "delete_slot").click();
  await dialog(page).getByRole("button", { name: "attachment.slots.confirm_delete", exact: true }).click();
  await expect(page.getByTestId("attachment-slot-design")).toHaveCount(0);
  await expect(page.getByTestId("ordinary")).toContainText("old.txt");
  await expect.poll(async () => (await state(page)).slots).toEqual([]);
});

test("rename failure keeps the inline input and Escape cancels without closing peek", async ({ page }) => {
  await page.goto("/?attachment-slots");
  await page.getByTestId("attachment-slot-name-design").click();
  await nameInput(page).fill("reject");
  await nameInput(page).press("Enter");
  await expect(page.getByTestId("slots").getByRole("alert")).toBeVisible();
  await expect(nameInput(page)).toHaveValue("reject");
  await nameInput(page).press("Escape");
  await expect(slotCard(page, "Design")).toBeVisible();
  await expect(page.getByTestId("attachment-peek")).toBeVisible();
});

test("members can replace another member's file but only owner or admin can delete it", async ({ page }) => {
  await page.goto("/?attachment-slots&role=member");
  await expect(slotCard(page, "Design")).toBeVisible();
  await expect(action(page, "delete_file")).toHaveCount(0);
  await expect(action(page, "replace")).toBeEnabled();
  await page.goto("/?attachment-slots&role=member&own-file");
  await expect(action(page, "delete_file")).toBeVisible();
  await action(page, "delete_file").click();
  await dialog(page).getByRole("button", { name: "attachment.slots.confirm_delete", exact: true }).click();
  await expect(slotCard(page, "Design").getByRole("link")).toHaveCount(0);
  await page.goto("/?attachment-slots");
  await expect(action(page, "delete_file")).toBeVisible();
});

test("guest sees slot files but cannot configure slots or templates", async ({ page }) => {
  await page.goto("/?attachment-slots&role=guest");
  await expect(slotCard(page, "Design").getByRole("link")).toContainText("old.txt");
  await expect(page.getByTestId("attachment-slot-name-design")).toBeDisabled();
  await expect(addEmpty(page)).toHaveCount(0);
  await expect(library(page)).toHaveCount(0);
  await expect(action(page, "replace")).toHaveCount(0);
  await expect.poll(async () => (await state(page)).calls.every((call: string) => call === "fetchSlots")).toBe(true);
});

test("disabled issue allows workspace template browsing but prevents issue modifications", async ({ page }) => {
  await page.goto("/?attachment-slots&disabled&role=member");
  await expect(slotCard(page, "Design").getByRole("link")).toBeVisible();
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
    expect(initial).toMatch(/ 1$/);
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
    await expect(slotCard(page, "Research")).toBeVisible();
    await expect.poll(async () => (await state(page)).slots[0].name).toBe("Research");
    await trigger.click();
    await expect(library(page)).toBeVisible();
    await trigger.click();
    await expect(slotCard(page, "Research")).toBeVisible();
    expect(choosers).toBe(0);
  });
}

test("inline names save on blur and duplicate errors preserve typed input", async ({ page }) => {
  await page.goto("/?attachment-slots");
  await page.getByTestId("attachment-slot-name-design").click();
  await nameInput(page).fill("Updated design");
  await page.getByRole("heading").click();
  await expect(slotCard(page, "Updated design")).toBeVisible();
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

test("Escape closes the peek when no modal or inline input owns it", async ({ page }) => {
  await page.goto("/?attachment-slots");
  await page.getByRole("heading").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("peek-closed")).toBeVisible();
});

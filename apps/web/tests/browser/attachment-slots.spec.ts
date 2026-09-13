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
  page.getByTestId("slots").getByText(name, { exact: true }).locator("..").locator("..");
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
    const picker = section.locator('input[type="file"]');
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
    await section
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
  await action(page, "add").click();
  await dialog(page).getByRole("textbox").fill("Design");
  await dialog(page).getByRole("button", { name: "attachment.slots.save", exact: true }).click();
  await expect(slotCard(page, "Design")).toBeVisible();
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
  await action(page, "library").click();
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
  await expect(page.getByTestId("slots")).not.toContainText("old.txt");
  await expect(page.getByTestId("ordinary")).toContainText("old.txt");
  await expect.poll(async () => (await state(page)).slots).toEqual([]);
});

test("rename failure keeps the entered name and the dialog remains closable", async ({ page }) => {
  await page.goto("/?attachment-slots");
  await action(page, "rename").click();
  await dialog(page).getByRole("textbox").fill("reject");
  await dialog(page).getByRole("button", { name: "attachment.slots.save", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toBeVisible();
  await expect(dialog(page).getByRole("textbox")).toHaveValue("reject");
  await dialog(page).getByRole("button", { name: "attachment.slots.close", exact: true }).click();
  await expect(slotCard(page, "Design")).toBeVisible();
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
  await expect(slotCard(page, "Design")).toContainText("attachment.slots.empty_slot");
  await page.goto("/?attachment-slots");
  await expect(action(page, "delete_file")).toBeVisible();
});

test("guest sees slot files but cannot configure slots or templates", async ({ page }) => {
  await page.goto("/?attachment-slots&role=guest");
  await expect(slotCard(page, "Design").getByRole("link")).toContainText("old.txt");
  await expect(page.getByTestId("slots").getByRole("button")).toHaveCount(0);
  await expect.poll(async () => (await state(page)).calls).toEqual(["fetchSlots"]);
});

test("disabled issue allows workspace template browsing but prevents issue modifications", async ({ page }) => {
  await page.goto("/?attachment-slots&disabled&role=member");
  await expect(slotCard(page, "Design").getByRole("link")).toBeVisible();
  await expect(action(page, "add")).toHaveCount(0);
  await expect(action(page, "replace")).toHaveCount(0);
  await expect(action(page, "delete_slot")).toHaveCount(0);
  await action(page, "library").click();
  await expect(action(page, "apply")).toBeDisabled();
  await expect(action(page, "new_template")).toBeEnabled();
  await dialog(page).getByRole("button", { name: "attachment.slots.close", exact: true }).click();
  await expect.poll(async () => (await state(page)).calls).toEqual(["fetchSlots", "fetchTemplates"]);
});

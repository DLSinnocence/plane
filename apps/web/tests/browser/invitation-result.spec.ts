/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, test } from "@playwright/test";

for (const emailStatus of ["not_configured", "failed"]) {
  test(`saved invitation stays shareable when email is ${emailStatus}`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/?invitation-result&email_status=${emailStatus}`);
    await expect(page.getByRole("status")).toContainText(
      `workspace_settings.settings.members.invitation_flow.${emailStatus}`
    );
    await expect(page.getByText("new.person@example.test", { exact: true })).toBeVisible();
    const link = page.getByRole("textbox");
    await expect(link).toHaveAttribute("readonly", "");
    const value = await link.inputValue();
    const destination = new URL(value);
    expect(destination.pathname).toBe("/workspace-invitations/");
    expect(destination.searchParams.get("token")).toBe("fixture-token");
    await page.getByRole("button").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
  });
}

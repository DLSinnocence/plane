/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const englishMessages = JSON.parse(
  readFileSync(new URL("../../../../packages/i18n/src/locales/en/common.json", import.meta.url), "utf8")
) as typeof import("../../../../packages/i18n/src/locales/en/common.json");
const chineseMessages = JSON.parse(
  readFileSync(new URL("../../../../packages/i18n/src/locales/zh-CN/common.json", import.meta.url), "utf8")
) as typeof import("../../../../packages/i18n/src/locales/zh-CN/common.json");

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

const regions = ["slots", "legacy", "inbox"] as const;
const canonical = "/preview-assets/canonical?signature=keep%2Bexact&expires=123";
const filename = "reference.PNG";
const modal = (page: Page) => page.getByRole("dialog");
const closeButton = (page: Page) => modal(page).getByRole("button", { name: "attachment.preview.close", exact: true });
const fileLink = (page: Page, region: string, name = filename) =>
  page.getByTestId(`preview-${region}`).getByRole("link", {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`),
  });
const thumbnailButton = (page: Page, region: string, name = filename) =>
  page
    .getByTestId(`preview-${region}`)
    .getByRole("button", { name, exact: true })
    .filter({ has: page.locator("img") });
const thumbnailImage = (page: Page, region: string, name = filename) =>
  thumbnailButton(page, region, name).locator("img");
const attachmentRow = (page: Page, region: string, name = filename) =>
  region === "slots"
    ? page
        .getByTestId(`preview-${region}`)
        .locator('[data-testid^="attachment-slot-"]:has(> [data-testid^="attachment-slot-label-"])')
        .filter({ has: page.getByRole("link", { name, exact: true }) })
    : fileLink(page, region, name).locator('xpath=ancestor::div[.//button[@aria-haspopup="menu"]][1]');
const downloadLink = (page: Page, region: string) =>
  attachmentRow(page, region).getByRole("link", { name: "attachment.preview.download", exact: true });
const zoomButton = (page: Page, name: "zoom_in" | "zoom_out" | "reset_zoom") =>
  modal(page).getByRole("button", { name: `attachment.preview.${name}`, exact: true });
const fixtureUrl = (params: Record<string, string> = {}) =>
  `/?${new URLSearchParams({ "attachment-preview": "", ...params })}`;

// A looping GIF89a with two 1x1 frames (red and green), each displayed for 50ms.
const animatedGif = Buffer.from(
  "47494638396101000100800000ff000000ff00" +
    "21ff0b4e45545343415045322e300301000000" +
    "21f90404050000002c0000000001000100000202440100" +
    "21f90404050000002c00000000010001000002024c0100" +
    "3b",
  "hex"
);

async function imageData(page: Page, mimeType = "image/png", imageWidth = 120, imageHeight = 80) {
  return page.evaluate(
    ({ mime, width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      const sky = context.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, "#0c4a6e");
      sky.addColorStop(1, "#bae6fd");
      context.fillStyle = sky;
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#fbbf24";
      context.beginPath();
      context.arc(width * 0.78, height * 0.24, Math.min(width, height) * 0.1, 0, Math.PI * 2);
      context.fill();
      for (const [peak, color] of [
        [0.32, "#0f766e"],
        [0.72, "#14b8a6"],
      ] as const) {
        context.fillStyle = color;
        context.beginPath();
        context.moveTo(width * (peak - 0.5), height);
        context.lineTo(width * peak, height * 0.3);
        context.lineTo(width * (peak + 0.5), height);
        context.closePath();
        context.fill();
      }
      return canvas.toDataURL(mime);
    },
    { mime: mimeType, width: imageWidth, height: imageHeight }
  );
}

async function serveImage(page: Page, mime = "image/png", width = 120, height = 80) {
  const data = mime === "image/gif" ? undefined : await imageData(page, mime, width, height);
  const body = data ? Buffer.from(data.split(",")[1], "base64") : animatedGif;
  const requests: string[] = [];
  await page.context().route("**/preview-assets/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ contentType: mime, body });
  });
  return requests;
}

async function serveDownload(page: Page, authenticated = false) {
  // Exercise native image decoding, HTTP redirects, and Content-Disposition.
  // This models the download protocol, not Django/S3 authorization.
  const data = await imageData(page);
  const body = Buffer.from(data.split(",")[1], "base64");
  const requests: { url: string; cookie: string }[] = [];
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url?.startsWith("/authenticated?")) {
      const cookie = request.headers.cookie ?? "";
      requests.push({ url: request.url, cookie });
      if (authenticated && !cookie.includes("preview_session=authorized")) {
        response.writeHead(403).end("Authentication required");
        return;
      }
      response.writeHead(302, { Location: "/object?signature=unchanged" }).end();
      return;
    }
    if (request.url === "/object?signature=unchanged") {
      response
        .writeHead(200, {
          "Content-Type": "image/png",
          "Content-Disposition": 'attachment; filename="reference.PNG"',
        })
        .end(body);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sourcePath = "/authenticated?signature=unchanged%2Bvalue";
  const src = `http://127.0.0.1:${(server.address() as AddressInfo).port}${sourcePath}`;
  return {
    src,
    sourcePath,
    requests,
    close: async () => {
      server.closeAllConnections();
      await promisify(server.close.bind(server))();
    },
  };
}

async function expectLoaded(page: Page, name = filename, width = 120, height = 80) {
  const image = modal(page).getByRole("img", { name, exact: true });
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty("naturalWidth", width);
  await expect(image).toHaveJSProperty("naturalHeight", height);
  await expect(modal(page).getByRole("status")).toHaveCount(0);
  await expect(modal(page).getByRole("alert")).toHaveCount(0);
  return image;
}

async function mutate(page: Page, action: "switch-issue" | "remove" | "replace") {
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent("attachment-preview:mutate", { detail })),
    action
  );
}

for (const region of regions) {
  for (const [extension, mime] of [
    ["PNG", "image/png"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
  ]) {
    test(`${region}: automatically displays ${extension} and enlarges it when clicked`, async ({ page }) => {
      const requests = await serveImage(page, mime);
      const name = `reference.${extension}`;
      let choosers = 0;
      page.on("filechooser", () => choosers++);
      await page.goto(fixtureUrl({ filename: name }));
      await Promise.all(regions.map((entry) => expect(fileLink(page, entry, name)).toBeVisible()));
      const thumbnail = thumbnailImage(page, region, name);
      await expect(thumbnail).toBeVisible();
      await expect(thumbnail).toHaveJSProperty("naturalWidth", mime === "image/gif" ? 1 : 120);
      await expect(thumbnail).toHaveJSProperty("naturalHeight", mime === "image/gif" ? 1 : 80);
      await expect(modal(page)).toHaveCount(0);
      if (mime === "image/gif") {
        const frame = await thumbnail.screenshot();
        await expect.poll(async () => !(await thumbnail.screenshot()).equals(frame)).toBe(true);
      }
      expect(requests.length).toBeGreaterThan(0);
      await expect(fileLink(page, region, name)).toHaveAttribute("href", canonical);
      await thumbnail.click();
      await expect(modal(page)).toHaveAccessibleName(name);
      await expect(modal(page)).toHaveAttribute("aria-modal", "true");
      await expect(modal(page)).toHaveAttribute("data-prevent-outside-click");
      const image = await expectLoaded(page, name, mime === "image/gif" ? 1 : 120, mime === "image/gif" ? 1 : 80);
      await expect(image).toHaveAttribute("src", canonical);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((url) => new URL(url).pathname + new URL(url).search === canonical)).toBe(true);
      expect(choosers).toBe(0);
      await image.click();
      await expect(closeButton(page)).toBeVisible();
      await expect(page.getByTestId("attachment-peek")).toBeAttached();
      if (mime === "image/gif") {
        const firstFrame = await image.screenshot();
        await expect.poll(async () => !(await image.screenshot()).equals(firstFrame)).toBe(true);
      }
    });
  }

  test(`${region}: replacing an unavailable image automatically refreshes its thumbnail`, async ({ page }) => {
    const data = await imageData(page);
    await page.route("**/preview-assets/**", (route) =>
      route.fulfill({
        contentType: "image/png",
        body: route.request().url().includes("/replaced?")
          ? Buffer.from(data.split(",")[1], "base64")
          : Buffer.from("invalid image"),
      })
    );
    await page.goto(fixtureUrl());
    await expect(thumbnailButton(page, region).getByRole("status")).toHaveText("attachment.preview.error");
    await mutate(page, "replace");
    const thumbnail = thumbnailImage(page, region);
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveJSProperty("naturalWidth", 120);
    await expect(thumbnail).toHaveAttribute("src", "/preview-assets/replaced?signature=unchanged");
    await expect(modal(page)).toHaveCount(0);
  });

  for (const dismissal of ["escape", "backdrop", "button"]) {
    test(`${region}: ${dismissal} dismisses only preview and restores its source focus`, async ({ page }) => {
      await serveImage(page);
      await page.goto(fixtureUrl());
      const source = thumbnailButton(page, region);
      await source.click();
      await expectLoaded(page);
      await expect(closeButton(page)).toBeFocused();
      await expect(zoomButton(page, "zoom_out")).toBeDisabled();
      await page.keyboard.press("Tab");
      await expect(zoomButton(page, "zoom_in")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(zoomButton(page, "reset_zoom")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(modal(page).getByRole("link", { name: "attachment.preview.download" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(closeButton(page)).toBeFocused();
      if (dismissal === "escape") await page.keyboard.press("Escape");
      if (dismissal === "backdrop") await page.mouse.click(2, 2);
      if (dismissal === "button") await closeButton(page).click();
      await expect(modal(page)).toHaveCount(0);
      await expect(page.getByTestId("attachment-peek")).toBeVisible();
      await expect(source).toBeFocused();
      await page.getByTestId("outside-peek").click();
      await expect(page.getByTestId("peek-closed")).toBeVisible();
    });
  }

  for (const permissions of [{ disabled: "" }, { role: "guest" }] as Record<string, string>[]) {
    test(`${region}: preview remains available for ${"disabled" in permissions ? "readonly" : "guest"} viewers`, async ({
      page,
    }) => {
      await serveImage(page);
      await page.goto(fixtureUrl(permissions));
      await expect(thumbnailImage(page, region)).toBeVisible();
      await expect(modal(page)).toHaveCount(0);
      await fileLink(page, region).click();
      await expectLoaded(page);
      await closeButton(page).click();
      await expect(page.getByTestId("attachment-peek")).toBeVisible();
      await attachmentRow(page, region).locator('button[aria-haspopup="menu"]').click();
      await expect(page.getByRole("menuitem")).toHaveText(["attachment.preview.download"]);
      await expect(page.getByRole("menuitem", { name: /replace|delete/i })).toHaveCount(0);
    });
  }

  for (const readonly of [false, true]) {
    test(`${region}: inline and menu actions download the real HTTP image${readonly ? " without edit permissions" : ""}`, async ({
      page,
    }) => {
      const { src, sourcePath, requests, close } = await serveDownload(page);
      try {
        await page.goto(fixtureUrl({ src, ...(readonly ? { disabled: "" } : {}) }));
        await expect(thumbnailImage(page, region)).toBeVisible();
        await expect(thumbnailImage(page, region)).toHaveJSProperty("naturalWidth", 120);
        const row = attachmentRow(page, region);
        const before = await page.getByTestId("preview-state").textContent();
        const inline = downloadLink(page, region);
        await expect(inline).toBeVisible();
        await expect(inline).toHaveAttribute("href", src);
        await expect(inline).toHaveAttribute("download", filename);
        await expect(inline).toHaveAttribute("target", "_blank");
        await expect(inline).toHaveAttribute("rel", "noopener noreferrer");
        const inlineEvent = page.waitForEvent("download");
        await inline.click();
        const inlineDownload = await inlineEvent;
        expect(inlineDownload.suggestedFilename()).toBe(filename);
        expect(await inlineDownload.failure()).toBeNull();
        await expect(modal(page)).toHaveCount(0);
        await row.locator('button[aria-haspopup="menu"]').click();
        const items = page.getByRole("menuitem");
        await expect(items.first()).toHaveText("attachment.preview.download");
        if (readonly) {
          await expect(items).toHaveCount(1);
          await expect(page.getByRole("menuitem", { name: /replace|delete/i })).toHaveCount(0);
          await expect(row.locator('input[type="file"]')).toHaveCount(0);
        } else {
          await expect(items).toHaveCount(region === "slots" ? 3 : 2);
        }
        const menuEvent = page.waitForEvent("download");
        await page.getByRole("menuitem", { name: "attachment.preview.download", exact: true }).click();
        const menuDownload = await menuEvent;
        expect(menuDownload.suggestedFilename()).toBe(filename);
        expect(await menuDownload.failure()).toBeNull();
        await expect(modal(page)).toHaveCount(0);
        await expect(page.getByTestId("attachment-peek")).toBeVisible();
        await expect(page.getByTestId("preview-state")).toHaveText(before!);
        expect(requests.length).toBeGreaterThanOrEqual(3);
        expect(requests.every((request) => request.url === sourcePath)).toBe(true);
      } finally {
        await close();
      }
    });
  }

  test(`${region}: nonimages and modified clicks retain navigation; image preview exposes download`, async ({
    page,
  }) => {
    await serveImage(page);
    await page
      .context()
      .route("**/preview-assets/document", (route) =>
        route.fulfill({ contentType: "text/html", body: "<p>Original document</p>" })
      );
    await page.goto(fixtureUrl());
    const document = fileLink(page, region, "report.pdf");
    await expect(document.getByRole("img", { name: "report.pdf", exact: true })).toHaveCount(0);
    await expect(document).toHaveAttribute("href", "/preview-assets/document");
    const documentPopup = page.waitForEvent("popup");
    await document.click();
    const openedDocument = await documentPopup;
    await expect(openedDocument).toHaveURL(/\/preview-assets\/document$/);
    await expect(modal(page)).toHaveCount(0);
    await openedDocument.close();

    const modifiedLink = fileLink(page, region);
    await modifiedLink.evaluate((element) => {
      window.addEventListener(
        "click",
        (event) => queueMicrotask(() => element.setAttribute("data-click-prevented", String(event.defaultPrevented))),
        { capture: true, once: true }
      );
    });
    await modifiedLink.click({ modifiers: ["ControlOrMeta"] });
    await expect(modifiedLink).toHaveAttribute("data-click-prevented", "false");
    await expect(modal(page)).toHaveCount(0);

    await fileLink(page, region).click();
    await expectLoaded(page);
    const original = modal(page).getByRole("link", { name: "attachment.preview.download", exact: true });
    await expect(original).toHaveAttribute("href", canonical);
    await expect(original).toHaveAttribute("target", "_blank");
    await expect(original).toHaveAttribute("rel", "noopener noreferrer");
    await expect(original).toHaveAttribute("download", filename);
    await expect(original).toBeVisible();
    await expect(closeButton(page)).toBeVisible();
  });

  for (const mutation of ["switch-issue", "remove", "replace"] as const) {
    test(`${region}: ${mutation} while a request is pending closes obsolete preview`, async ({ page }) => {
      const data = await imageData(page);
      let release!: () => void;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const completed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      await page.route("**/preview-assets/**", async (route) => {
        await pending;
        try {
          await route.fulfill({ contentType: "image/png", body: Buffer.from(data.split(",")[1], "base64") });
        } finally {
          finish();
        }
      });
      const requested = page.waitForRequest("**/preview-assets/**");
      await page.goto(fixtureUrl());
      await fileLink(page, region).click();
      await requested;
      await expect(modal(page).getByRole("status")).toHaveText("attachment.preview.loading");
      try {
        await mutate(page, mutation);
        await expect(modal(page)).toHaveCount(0);
        await expect(page.getByTestId("attachment-peek")).toBeVisible();
      } finally {
        release();
      }
      await completed;
      await expect(modal(page)).toHaveCount(0);
      if (mutation === "remove") {
        await expect(fileLink(page, region)).toHaveCount(0);
      } else {
        if (mutation === "switch-issue") {
          await mutate(page, "switch-issue");
          await expect(page.getByTestId("preview-issue")).toHaveText("issue");
          await expect(modal(page)).toHaveCount(0);
        } else {
          await expect(fileLink(page, region)).toHaveAttribute("href", "/preview-assets/replaced?signature=unchanged");
        }
        await fileLink(page, region).click();
        const image = await expectLoaded(page);
        await expect(image).toHaveAttribute(
          "src",
          mutation === "replace" ? "/preview-assets/replaced?signature=unchanged" : canonical
        );
      }
    });
  }
}

test("legacy row padding does not open the enclosing upload filechooser", async ({ page }) => {
  const requests = await serveImage(page);
  let choosers = 0;
  page.on("filechooser", () => choosers++);
  await page.goto(fixtureUrl());
  await expect(thumbnailImage(page, "legacy")).toBeVisible();
  const requestCount = requests.length;
  const row = fileLink(page, "legacy").locator(
    'xpath=ancestor::div[@role="presentation" and contains(concat(" ", normalize-space(@class), " "), " group ")][1]'
  );
  await expect(row).toHaveAttribute("role", "presentation");
  // The production row has px-3 padding. Click inside its left padding,
  // outside the filename link and action menu, to exercise bubbling.
  await row.click({ position: { x: 2, y: 2 } });
  await expect(modal(page)).toHaveCount(0);
  expect(choosers).toBe(0);
  expect(requests).toHaveLength(requestCount);
  await fileLink(page, "legacy").click();
  await expectLoaded(page);
  expect(choosers).toBe(0);
});

test("failed thumbnails retain the file entry and enlarged preview can retry the exact URL", async ({ page }) => {
  const data = await imageData(page);
  const requests: string[] = [];
  let available = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/preview-assets/**", async (route) => {
    requests.push(route.request().url());
    await pending;
    await route.fulfill(
      available
        ? { contentType: "image/png", body: Buffer.from(data.split(",")[1], "base64") }
        : { status: 503, contentType: "text/plain", body: "Temporarily unavailable" }
    );
  });
  await page.goto(fixtureUrl());
  const source = thumbnailButton(page, "slots");
  try {
    await expect(source.getByRole("status")).toHaveText("attachment.preview.loading");
  } finally {
    release();
  }
  await expect(source.getByRole("status")).toHaveText("attachment.preview.error");
  await expect(fileLink(page, "slots")).toHaveText(filename);
  await source.click();
  await expect(modal(page).getByRole("alert")).toHaveText("attachment.preview.error");
  available = true;
  await modal(page).getByRole("button", { name: "attachment.preview.retry", exact: true }).click();
  await expectLoaded(page);
  await expect.poll(() => modal(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(new Set(requests)).toEqual(new Set([new URL(canonical, page.url()).href]));
});

test("a corrupt image response offers retry and the original file without showing a broken image", async ({ page }) => {
  await page.route("**/preview-assets/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: "This is not an image" })
  );
  await page.goto(fixtureUrl());
  await fileLink(page, "slots").click();
  await expect(modal(page).getByRole("alert")).toHaveText("attachment.preview.error");
  await expect(modal(page).getByRole("img")).toHaveCount(0);
  await expect(modal(page).getByRole("button", { name: "attachment.preview.retry" })).toBeEnabled();
  await expect(modal(page).getByRole("link", { name: "attachment.preview.download" })).toHaveAttribute(
    "href",
    canonical
  );
});

test("a decoded cached source is displayed immediately on first open and reopen", async ({ page }) => {
  // Data URLs avoid Playwright routing's HTTP-cache disabling, and predecoding
  // exercises the already-complete image path without a synthetic load event.
  const src = await imageData(page);
  await page.goto(fixtureUrl({ src }));
  await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
  }, src);
  const openAndClose = async () => {
    await fileLink(page, "legacy").click();
    await expectLoaded(page);
    await closeButton(page).click();
  };
  await openAndClose();
  await openAndClose();
});

test("cookie-authenticated redirect previews an attachment-disposition image and retains download (protocol simulation)", async ({
  page,
  context,
}) => {
  const { src, sourcePath, requests, close } = await serveDownload(page, true);
  try {
    await context.addCookies([
      { name: "preview_session", value: "authorized", url: "http://127.0.0.1:4179", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto(fixtureUrl({ src }));
    await expect(thumbnailImage(page, "inbox")).toBeVisible();
    await expect(modal(page)).toHaveCount(0);
    await fileLink(page, "inbox").click();
    const image = await expectLoaded(page);
    await expect(image).toHaveAttribute("src", src);
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((request) => request.cookie.includes("preview_session=authorized") && request.url === sourcePath)
    ).toBe(true);
    const original = modal(page).getByRole("link", { name: "attachment.preview.download" });
    await expect(original).toHaveAttribute("href", src);
    const downloading = page.waitForEvent("download");
    await original.click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(filename);
    expect(await download.failure()).toBeNull();
    await closeButton(page).click();
    await context.clearCookies();
    // Start a fresh document: an already decoded image can remain available in
    // the old document even after its session cookie is removed.
    await page.reload();
    await fileLink(page, "inbox").click();
    await expect(modal(page).getByRole("alert")).toHaveText("attachment.preview.error");
    expect(requests.at(-1)?.cookie).not.toContain("preview_session=authorized");
  } finally {
    await close();
  }
});

for (const [width, height] of [
  [400, 2400],
  [2400, 400],
  [120, 80],
]) {
  test(`image ${width}x${height} fits viewport at native aspect ratio without upscaling`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await serveImage(page, "image/png", width, height);
    await page.goto(fixtureUrl());
    const thumbnail = thumbnailImage(page, "slots");
    await expect(thumbnail).toBeVisible();
    const thumbnailBox = (await thumbnail.boundingBox())!;
    expect(thumbnailBox.height).toBeLessThanOrEqual(128);
    const contentBox = (await page.getByTestId("attachment-slot-content-design").boundingBox())!;
    expect(thumbnailBox.width).toBeLessThanOrEqual(contentBox.width + 1);
    expect(thumbnailBox.width / thumbnailBox.height).toBeCloseTo(width / height, 1);
    await Promise.all(
      [thumbnail.locator(".."), thumbnailButton(page, "slots")].map(async (wrapper) => {
        const bounds = (await wrapper.boundingBox())!;
        expect(Math.abs(bounds.width - thumbnailBox.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(bounds.height - thumbnailBox.height)).toBeLessThanOrEqual(1);
        const style = await wrapper.evaluate((element) => {
          const css = getComputedStyle(element);
          return { background: css.backgroundColor, padding: css.padding, border: css.borderTopWidth };
        });
        expect(style).toEqual({ background: "rgba(0, 0, 0, 0)", padding: "0px", border: "0px" });
      })
    );
    await thumbnail.click();
    const image = await expectLoaded(page, filename, width, height);
    const box = (await image.boundingBox())!;
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(900);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
    expect(box.width).toBeLessThanOrEqual(width);
    expect(box.height).toBeLessThanOrEqual(height);
    expect(box.width / box.height).toBeCloseTo(width / height, 1);
  });
}

test("a long filename stays accessible while the narrow viewer header truncates it", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await serveImage(page);
  const labels = englishMessages.attachment.preview;
  const name = "unbroken-filename-".repeat(18) + ".PNG";
  await page.goto(fixtureUrl({ filename: name, "preview-labels": "", lang: "en" }));
  await fileLink(page, "inbox", name).click();
  await expectLoaded(page, name);
  await expect(modal(page)).toHaveAccessibleName(name);
  const title = modal(page).getByRole("heading", { name, exact: true });
  await expect(title).toHaveText(name);
  await expect(title).toHaveAttribute("title", name);
  const size = await title.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
    textOverflow: getComputedStyle(element).textOverflow,
  }));
  expect(size.clientWidth).toBeGreaterThan(0);
  expect(size.scrollWidth).toBeGreaterThan(size.clientWidth);
  expect(size.whiteSpace).toBe("nowrap");
  expect(size.textOverflow).toBe("ellipsis");
  const box = (await title.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  const close = modal(page).getByRole("button", { name: labels.close, exact: true });
  await expect(close).toBeInViewport();
  await close.click();
  await expect(fileLink(page, "inbox", name)).toBeFocused();
});

test("zoom reports actual scale, pans without closing, and resets to the original fit", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await serveImage(page, "image/png", 2400, 1600);
  await page.goto(fixtureUrl());
  await thumbnailButton(page, "slots").click();
  const image = await expectLoaded(page, filename, 2400, 1600);
  const stage = page.getByTestId("image-preview-stage");
  const percentage = page.getByTestId("image-preview-zoom");
  const initial = (await image.boundingBox())!;
  const initialPercentage = await percentage.textContent();
  expect(initial.width).toBeLessThan(2400);
  await expect(percentage).toHaveText(`${Math.round((initial.width / 2400) * 100)}%`);
  await expect(zoomButton(page, "zoom_out")).toBeDisabled();
  // Each click must observe the preceding zoom state.
  // eslint-disable-next-line no-await-in-loop
  for (let step = 0; step < 3; step++) await zoomButton(page, "zoom_in").click();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(initial.width * 1.5);
  const enlarged = (await image.boundingBox())!;
  await expect(percentage).toHaveText(`${Math.round((enlarged.width / 2400) * 100)}%`);
  await expect(modal(page).getByRole("status")).toHaveCount(0);
  await expect(zoomButton(page, "zoom_out")).toBeEnabled();
  const bounds = (await stage.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.click(x, y);
  await expect(closeButton(page)).toBeVisible();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y - 80, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => stage.evaluate((element) => element.scrollLeft)).toBeGreaterThan(50);
  await expect.poll(() => stage.evaluate((element) => element.scrollTop)).toBeGreaterThan(30);
  await expect(closeButton(page)).toBeVisible();
  await stage.focus();
  const scrollLeft = await stage.evaluate((element) => element.scrollLeft);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => stage.evaluate((element) => element.scrollLeft)).toBeGreaterThan(scrollLeft);
  await zoomButton(page, "zoom_out").click();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeLessThan(enlarged.width);
  await zoomButton(page, "reset_zoom").click();
  await expect(percentage).toHaveText(initialPercentage!);
  await expect.poll(async () => Math.abs((await image.boundingBox())!.width - initial.width)).toBeLessThan(1);
  await expect.poll(() => stage.evaluate((element) => [element.scrollLeft, element.scrollTop])).toEqual([0, 0]);
  await expect(zoomButton(page, "zoom_out")).toBeDisabled();
  await expect(closeButton(page)).toBeInViewport();
});

test("clicking blank image-stage space closes only the viewer", async ({ page }) => {
  await serveImage(page);
  await page.goto(fixtureUrl());
  const source = thumbnailButton(page, "slots");
  await source.click();
  await expectLoaded(page);
  await page.getByTestId("image-preview-stage").click({ position: { x: 8, y: 8 } });
  await expect(modal(page)).toHaveCount(0);
  await expect(page.getByTestId("attachment-peek")).toBeVisible();
  await expect(source).toBeFocused();
});

for (const lang of ["en", "zh"]) {
  test(`${lang}: mobile toolbar stays fully visible while the image is zoomed and scrolled`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await serveImage(page, "image/png", 1600, 1200);
    const labels = (lang === "zh" ? chineseMessages : englishMessages).attachment.preview;
    await page.goto(fixtureUrl({ "preview-labels": "", lang }));
    await thumbnailButton(page, "slots").click();
    await expectLoaded(page, filename, 1600, 1200);
    const zoom = modal(page).getByRole("button", { name: labels.zoom_in, exact: true });
    // Each click must observe the preceding zoom state.
    // eslint-disable-next-line no-await-in-loop
    for (let step = 0; step < 5; step++) await zoom.click();
    await page.getByTestId("image-preview-stage").evaluate((element) => element.scrollTo(200, 200));
    await Promise.all(
      [
        modal(page).getByRole("link", { name: labels.download, exact: true }),
        ...[labels.close, labels.zoom_in, labels.zoom_out, labels.reset_zoom].map((name) =>
          modal(page).getByRole("button", { name, exact: true })
        ),
        page.getByTestId("image-preview-zoom"),
      ].map(async (control) => {
        await expect(control).toBeInViewport();
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(375);
        expect(box.y + box.height).toBeLessThanOrEqual(667);
      })
    );
  });
}

test("real Chinese labels render a dark viewer and frameless inline image artifacts", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveImage(page, "image/png", 1000, 650);
  const name = "产品设计参考图.png";
  const labels = chineseMessages.attachment.preview;
  await page.goto(fixtureUrl({ filename: name, "preview-labels": "", lang: "zh" }));
  const source = thumbnailButton(page, "slots", name);
  await expect(source.locator("img")).toHaveJSProperty("naturalWidth", 1000);
  await expect(source.locator("img")).toHaveJSProperty("naturalHeight", 650);
  const row = attachmentRow(page, "slots", name);
  await expect(row.getByRole("link", { name: labels.download, exact: true })).toBeVisible();
  const section = page.getByTestId("preview-slots");
  await expect(
    section.getByRole("button", { name: new RegExp(`^${chineseMessages.common.attachments}`) })
  ).toBeVisible();
  await expect(section).not.toContainText(/common\.|attachment\./);
  const inlinePath = testInfo.outputPath("attachment-inline-zh.png");
  await section.screenshot({ path: inlinePath });
  await testInfo.attach("Chinese inline attachment", { path: inlinePath, contentType: "image/png" });
  await source.click();
  await expectLoaded(page, name, 1000, 650);
  await expect(modal(page).getByRole("link", { name: labels.download, exact: true })).toBeVisible();
  await expect(modal(page).getByRole("button", { name: labels.reset_zoom, exact: true })).toBeVisible();
  await expect(page.getByTestId("image-preview-stage").locator("..")).toHaveCSS("background-color", "rgb(10, 10, 10)");
  const viewerPath = testInfo.outputPath("attachment-dark-viewer-zh.png");
  await page.screenshot({ path: viewerPath });
  await testInfo.attach("Chinese dark image viewer", { path: viewerPath, contentType: "image/png" });
});

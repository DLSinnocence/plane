/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

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
      context.fillStyle = "#c026d3";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#0d9488";
      context.fillRect(0, 0, width / 2, height / 2);
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
      const thumbnail = fileLink(page, region, name).getByRole("img", { name, exact: true });
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
    await expect(fileLink(page, region).getByRole("status")).toHaveText("attachment.preview.error");
    await mutate(page, "replace");
    const thumbnail = fileLink(page, region).getByRole("img", { name: filename, exact: true });
    await expect(thumbnail).toBeVisible();
    await expect(thumbnail).toHaveJSProperty("naturalWidth", 120);
    await expect(thumbnail).toHaveAttribute("src", "/preview-assets/replaced?signature=unchanged");
    await expect(modal(page)).toHaveCount(0);
  });

  for (const dismissal of ["escape", "backdrop", "button"]) {
    test(`${region}: ${dismissal} dismisses only preview and restores its source focus`, async ({ page }) => {
      await serveImage(page);
      await page.goto(fixtureUrl());
      const source = fileLink(page, region);
      await source.click();
      await expectLoaded(page);
      await expect(closeButton(page)).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(modal(page).getByRole("link", { name: "attachment.preview.open_original" })).toBeFocused();
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
      await expect(fileLink(page, region).getByRole("img", { name: filename, exact: true })).toBeVisible();
      await expect(modal(page)).toHaveCount(0);
      await fileLink(page, region).click();
      await expectLoaded(page);
      await closeButton(page).click();
      await expect(page.getByTestId("attachment-peek")).toBeVisible();
    });
  }

  test(`${region}: nonimages and modified clicks retain navigation; original image action still works`, async ({
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
    const original = modal(page).getByRole("link", { name: "attachment.preview.open_original", exact: true });
    await expect(original).toHaveAttribute("href", canonical);
    await expect(original).toHaveAttribute("target", "_blank");
    await expect(original).toHaveAttribute("rel", "noopener noreferrer");
    const originalPopup = page.waitForEvent("popup");
    await original.click();
    const openedOriginal = await originalPopup;
    await expect(openedOriginal).toHaveURL(new URL(canonical, page.url()).href);
    await openedOriginal.close();
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
  await expect(fileLink(page, "legacy").getByRole("img", { name: filename, exact: true })).toBeVisible();
  const requestCount = requests.length;
  const row = fileLink(page, "legacy").locator("..");
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
  const source = fileLink(page, "slots");
  try {
    await expect(source.getByRole("status")).toHaveText("attachment.preview.loading");
  } finally {
    release();
  }
  await expect(source.getByRole("status")).toHaveText("attachment.preview.error");
  await expect(source).toContainText(filename);
  await source.click();
  await expect(modal(page).getByRole("alert")).toHaveText("attachment.preview.error");
  available = true;
  await modal(page).getByRole("button", { name: "attachment.preview.retry", exact: true }).click();
  await expectLoaded(page);
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
  await expect(modal(page).getByRole("link", { name: "attachment.preview.open_original" })).toHaveAttribute(
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
  // A real local HTTP server avoids Playwright route interception skipping a
  // redirected request. It models the protocol, not Django/S3 authorization.
  const data = await imageData(page);
  const body = Buffer.from(data.split(",")[1], "base64");
  const requests: { url: string; cookie: string }[] = [];
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url?.startsWith("/authenticated?")) {
      const cookie = request.headers.cookie ?? "";
      requests.push({ url: request.url, cookie });
      if (!cookie.includes("preview_session=authorized")) {
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
  try {
    await context.addCookies([
      { name: "preview_session", value: "authorized", url: "http://127.0.0.1:4179", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto(fixtureUrl({ src }));
    await expect(fileLink(page, "inbox").getByRole("img", { name: filename, exact: true })).toBeVisible();
    await expect(modal(page)).toHaveCount(0);
    await fileLink(page, "inbox").click();
    const image = await expectLoaded(page);
    await expect(image).toHaveAttribute("src", src);
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((request) => request.cookie.includes("preview_session=authorized") && request.url === sourcePath)
    ).toBe(true);
    const original = modal(page).getByRole("link", { name: "attachment.preview.open_original" });
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
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
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
    const thumbnail = fileLink(page, "slots").getByRole("img", { name: filename, exact: true });
    await expect(thumbnail).toBeVisible();
    const thumbnailBox = (await thumbnail.boundingBox())!;
    expect(thumbnailBox.height).toBeLessThanOrEqual(128);
    expect(thumbnailBox.width).toBeLessThanOrEqual(320);
    expect(thumbnailBox.width / thumbnailBox.height).toBeCloseTo(width / height, 1);
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

test("a long filename wraps and remains readable in a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await serveImage(page);
  const name = "unbroken-filename-".repeat(18) + ".PNG";
  await page.goto(fixtureUrl({ filename: name }));
  await fileLink(page, "inbox", name).click();
  await expectLoaded(page, name);
  const title = modal(page).getByRole("heading", { name, exact: true });
  await expect(title).toHaveText(name);
  const size = await title.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    height: element.clientHeight,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }));
  expect(size.clientWidth).toBeGreaterThan(0);
  expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth + 1);
  expect(size.height).toBeGreaterThan(25);
  expect(size.whiteSpace).not.toBe("nowrap");
  const box = (await title.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await expect(closeButton(page)).toBeInViewport();
  await closeButton(page).click();
  await expect(fileLink(page, "inbox", name)).toBeFocused();
});

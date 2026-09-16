/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { canPreviewAttachment } from "./attachment-preview.ts";

const attachment = (
  name,
  assetUrl = "/api/assets/v2/workspaces/team/projects/project/issues/issue/attachments/id/"
) => ({
  attributes: { name, size: 100 },
  asset_url: assetUrl,
});

test("common uploaded raster images are previewable even when asset URLs have no extension", () => {
  for (const name of ["photo.jpg", "PHOTO.JPEG", "透明图片.PNG", "animation.Gif", "design.v2.WeBp"])
    assert.equal(canPreviewAttachment(attachment(name)), true, name);
});

test("other attachments retain their original file action", () => {
  for (const name of ["", "README", "photo", "photo.", "picture.svg", "report.pdf", "page.html", "a.jpg.exe", "a.png "])
    assert.equal(canPreviewAttachment(attachment(name)), false, name);
});

test("asset path and query extension cannot make a nonimage filename previewable", () => {
  assert.equal(canPreviewAttachment(attachment("document.pdf", "/files/image.png?name=cover.jpg")), false);
  assert.equal(
    canPreviewAttachment(attachment("photo.PNG", "https://storage.example/object?signature=unchanged")),
    true
  );
});

test("an image requires a nonempty file address", () => {
  for (const url of ["", " ", "\n"]) assert.equal(canPreviewAttachment(attachment("photo.jpg", url)), false);
});

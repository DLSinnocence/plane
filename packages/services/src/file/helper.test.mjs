/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { fileTypeFromBuffer } from "file-type";

// Exercise the shared metadata helper with the actual file-type detector, not a MIME stub.
const code = ts.transpileModule(readFileSync(new URL("./helper.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
new Function("require", "exports", code)((name) => {
  if (name === "file-type") return { fileTypeFromBuffer };
  if (name === "@plane/constants") return { DANGEROUS_EXTENSIONS: ["exe", "js", "html"] };
  throw new Error(`Unexpected dependency: ${name}`);
}, exports);
const { getFileMetaDataForUpload } = exports;

function photoshopFile(name, type) {
  // A complete minimal PSD: version 1, 1x1 RGB, 8-bit, no extra sections, raw pixel data.
  const psd = Buffer.alloc(43);
  psd.write("8BPS", 0, "ascii");
  psd.writeUInt16BE(1, 4); // PSD version
  psd.writeUInt16BE(3, 12); // RGB channels
  psd.writeUInt32BE(1, 14); // height
  psd.writeUInt32BE(1, 18); // width
  psd.writeUInt16BE(8, 22); // channel depth
  psd.writeUInt16BE(3, 24); // RGB color mode
  // Three empty length-prefixed sections at 26..37; raw compression=0 at 38..39.
  psd.set([255, 128, 0], 40);
  return new File([psd], name, { type });
}

test("real PSD bytes detect canonical Photoshop MIME regardless of browser type or extension", async () => {
  await Promise.all(
    [
      ["design.psd", ""],
      ["design.PSD", "application/octet-stream"],
      ["design.bin", "image/png"],
    ].map(async ([name, type]) => {
      const file = photoshopFile(name, type);
      assert.deepEqual(await getFileMetaDataForUpload(file), {
        name,
        size: 43,
        type: "image/vnd.adobe.photoshop",
      });
    })
  );
});

test("a PSD extension or claimed MIME never bypasses the unknown-signature security fallback", async () => {
  await Promise.all(
    ["", "image/vnd.adobe.photoshop", "application/x-photoshop"].map(async (type) => {
      const file = new File(["not a Photoshop document"], "pretend.psd", { type });
      assert.deepEqual(await getFileMetaDataForUpload(file), { name: file.name, size: file.size, type: "" });
    })
  );
});

test("signature read failures retain the empty MIME fallback", async () => {
  const file = photoshopFile("unreadable.psd", "image/vnd.adobe.photoshop");
  file.slice = () => {
    throw new Error("Cannot read file");
  };
  assert.equal((await getFileMetaDataForUpload(file)).type, "");
});

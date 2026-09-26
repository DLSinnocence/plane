/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  ATTACHMENT_COMPRESSION_THRESHOLD,
  prepareAttachmentUpload,
  validateAttachmentUploadEncoding,
} from "./attachment-compression.ts";

const mime = "image/vnd.adobe.photoshop";
const metadataFor = (file) => ({ name: file.name, type: mime, size: file.size });
const largeFile = () => {
  const file = new File(["8BPS streamed content"], "design.psd", {
    type: "application/octet-stream",
    lastModified: 42,
  });
  Object.defineProperty(file, "size", { value: ATTACHMENT_COMPRESSION_THRESHOLD + 1 });
  return file;
};

test("files below and exactly at 50 MiB stay identical, even without CompressionStream", async (t) => {
  assert.equal(ATTACHMENT_COMPRESSION_THRESHOLD, 50 * 1024 * 1024);
  const compressionStream = globalThis.CompressionStream;
  t.after(() => {
    globalThis.CompressionStream = compressionStream;
  });
  globalThis.CompressionStream = undefined;
  await Promise.all(
    [0, ATTACHMENT_COMPRESSION_THRESHOLD - 1, ATTACHMENT_COMPRESSION_THRESHOLD].map(async (size) => {
      const file = { name: "unchanged.psd", size };
      const metadata = metadataFor(file);
      const result = await prepareAttachmentUpload(file, metadata);
      assert.equal(result.file, file);
      assert.equal(result.metadata, metadata);
      assert.equal(Object.hasOwn(result.metadata, "content_encoding"), false);
      assert.equal(Object.hasOwn(result.metadata, "compressed_size"), false);
    })
  );
});

test("a real file one byte above the threshold streams to a lossless gzip body with original metadata", async () => {
  const source = Buffer.alloc(ATTACHMENT_COMPRESSION_THRESHOLD + 1, 0x61);
  source.write("8BPS");
  const file = new File([source], "design.psd", { type: "application/octet-stream", lastModified: 42 });
  file.arrayBuffer = () => {
    throw new Error("Do not buffer the entire source");
  };
  const metadata = metadataFor(file);
  const result = await prepareAttachmentUpload(file, metadata);
  const gzip = Buffer.from(await result.file.arrayBuffer());
  assert.deepEqual(gzip.subarray(0, 2), Buffer.from([0x1f, 0x8b]));
  assert.deepEqual(gunzipSync(gzip), source);
  assert.deepEqual(result.metadata, { ...metadata, content_encoding: "gzip", compressed_size: gzip.length });
  assert.deepEqual(metadata, metadataFor(file));
  assert.equal(result.file.name, file.name);
  assert.equal(result.file.type, mime);
  assert.equal(result.file.lastModified, 42);
  assert.ok(result.file.size < file.size);
});

test("a missing compression API rejects clearly rather than uploading the original", async (t) => {
  const compressionStream = globalThis.CompressionStream;
  t.after(() => {
    globalThis.CompressionStream = compressionStream;
  });
  globalThis.CompressionStream = undefined;
  const file = largeFile();
  await assert.rejects(prepareAttachmentUpload(file, metadataFor(file)), {
    code: "ATTACHMENT_COMPRESSION_UNSUPPORTED",
  });
});

test("a missing source streaming API rejects clearly", async () => {
  const file = largeFile();
  file.stream = undefined;
  await assert.rejects(prepareAttachmentUpload(file, metadataFor(file)), {
    code: "ATTACHMENT_COMPRESSION_UNSUPPORTED",
  });
});

test("constructor and asynchronous stream failures reject instead of falling back", async (t) => {
  const file = largeFile();
  const failure = new Error("Compression unavailable");
  t.mock.method(globalThis, "CompressionStream", function () {
    throw failure;
  });
  await assert.rejects(prepareAttachmentUpload(file, metadataFor(file)), {
    code: "ATTACHMENT_COMPRESSION_FAILED",
    cause: failure,
  });
  t.mock.restoreAll();
  file.stream = () =>
    new ReadableStream({
      start(controller) {
        controller.error(failure);
      },
    });
  await assert.rejects(prepareAttachmentUpload(file, metadataFor(file)), {
    code: "ATTACHMENT_COMPRESSION_FAILED",
    cause: failure,
  });
});

test("gzip storage authorization requires both encoding and the original detected MIME", () => {
  const metadata = {
    name: "design.psd",
    size: ATTACHMENT_COMPRESSION_THRESHOLD + 1,
    type: mime,
    content_encoding: "gzip",
    compressed_size: 100,
  };
  for (const fields of [
    undefined,
    {},
    { "Content-Type": mime },
    { "Content-Encoding": "gzip" },
    { "Content-Encoding": "identity", "Content-Type": mime },
    { "Content-Encoding": "gzip", "Content-Type": "application/gzip" },
    { "Content-Encoding": "gzip", "content-encoding": "identity", "Content-Type": mime },
  ]) {
    assert.throws(() => validateAttachmentUploadEncoding(metadata, fields), {
      code: "ATTACHMENT_COMPRESSION_NOT_ACCEPTED",
    });
  }
  for (const fields of [
    { "Content-Encoding": "gzip", "Content-Type": mime },
    { "content-encoding": "gzip", "content-type": mime },
  ]) {
    assert.doesNotThrow(() => validateAttachmentUploadEncoding(metadata, fields));
  }
  assert.doesNotThrow(() => validateAttachmentUploadEncoding({ name: "small", size: 1, type: "" }, {}));
});

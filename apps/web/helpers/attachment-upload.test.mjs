/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getAttachmentRejectionKey,
  getAttachmentRejectionDetails,
  getAttachmentUploadErrorKey,
  getAttachmentUploadErrorDetails,
} from "./attachment-upload.ts";

const limit = 5 * 1024 * 1024;
const rejection = (size, code, message = code) => [{ file: { size }, errors: [{ code, message }] }];

test("a small ZIP rejected for another reason is never labelled as too large", () => {
  const rejected = rejection(39 * 1024, "file-invalid-type", "Only PDF files are allowed");
  assert.equal(getAttachmentRejectionKey(rejected, limit), "attachment.invalid_file_type");
  assert.equal(getAttachmentRejectionDetails(rejected), "file-invalid-type: Only PDF files are allowed");
  assert.equal(getAttachmentRejectionKey(rejection(39 * 1024, "file-read-error"), limit), "attachment.file_read_error");
});

test("size warnings require the file to actually exceed the configured limit", () => {
  assert.equal(getAttachmentRejectionKey(rejection(limit + 1, "file-too-large"), limit), "attachment.file_size_limit");
  assert.equal(getAttachmentRejectionKey(rejection(limit, "file-too-large"), limit), "attachment.file_read_error");
  assert.equal(getAttachmentRejectionKey(rejection(39 * 1024, "file-too-large"), limit), "attachment.file_read_error");
  assert.equal(getAttachmentRejectionKey(rejection(100, "too-many-files"), limit), "attachment.only_one_file_allowed");
});

test("permission denial preserves HTTP status and the server's real reason", () => {
  const error = { response: { status: 403, data: { error: "Your project membership is inactive." } } };
  assert.equal(getAttachmentUploadErrorKey(error), "attachment.permission_denied");
  assert.equal(getAttachmentUploadErrorDetails(error), "HTTP 403: Your project membership is inactive.");
});

test("server request size errors are distinct from local file size validation", () => {
  const error = {
    response: { status: 413, data: { error: "REQUEST_BODY_TOO_LARGE", detail: "Proxy body limit exceeded" } },
  };
  assert.equal(getAttachmentUploadErrorKey(error), "attachment.server_size_rejected");
  assert.match(getAttachmentUploadErrorDetails(error), /HTTP 413.*Proxy body limit exceeded/);
});

test("storage XML reports its error code and message without exposing the signed request", () => {
  const error = {
    response: {
      status: 403,
      data: "<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature does not match.</Message><StringToSign>private-signature</StringToSign></Error>",
    },
  };
  assert.equal(
    getAttachmentUploadErrorDetails(error),
    "HTTP 403: SignatureDoesNotMatch; The request signature does not match."
  );
  assert.doesNotMatch(getAttachmentUploadErrorDetails(error), /private-signature|<Error>/);
});

test("network errors and field validation reasons are retained without claiming a size failure", () => {
  const network = new Error("Network Error");
  assert.equal(getAttachmentUploadErrorKey(network), "attachment.error");
  assert.equal(getAttachmentUploadErrorDetails(network), "Network Error");
  assert.equal(
    getAttachmentUploadErrorDetails({ response: { status: 400, data: { slot_id: ["This slot no longer exists."] } } }),
    "HTTP 400: slot_id: This slot no longer exists."
  );
});

test("HTML server pages and malformed responses do not become raw UI markup", () => {
  assert.equal(
    getAttachmentUploadErrorDetails({ response: { status: 502, data: "<html>internal proxy diagnostic</html>" } }),
    "HTTP 502"
  );
  assert.equal(getAttachmentUploadErrorDetails(null), "");
  assert.equal(getAttachmentUploadErrorDetails({ error: { private: "not a user-facing message" } }), "");
});

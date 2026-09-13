/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(relativePath, dependencies) {
  const code = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => dependencies[name] ?? require(name), exports);
  return exports;
}

const attachment = { id: "file", attributes: { name: "archive.zip", size: 3 }, issue_id: "issue" };
const signed = { asset_id: "file", attachment, upload_data: { url: "/storage", fields: {} } };
const archive = new File(["zip"], "archive.zip", { type: "application/zip" });

function fixture(upload) {
  const posts = [];
  const confirmations = [];
  class APIService {
    post(...args) {
      posts.push(args);
      return Promise.resolve({ data: signed });
    }
    patch(...args) {
      confirmations.push(args);
      return Promise.resolve({});
    }
  }
  const { IssueAttachmentService } = load("./issue_attachment.service.ts", {
    "@/services/api.service": { APIService },
    "@/services/file-upload.service": {
      FileUploadService: class {
        uploadFile = upload;
      },
    },
    "@plane/constants": { API_BASE_URL: "" },
    "@plane/types": { EIssueServiceType: { ISSUES: "issues" } },
    "@plane/services": {
      getFileMetaDataForUpload: async (file) => ({ name: file.name, size: file.size, type: file.type }),
      generateFileUploadPayload: () => new FormData(),
    },
  });
  return { service: new IssueAttachmentService(), posts, confirmations };
}

test("slot uploads send slot metadata and confirm only after storage upload succeeds", async () => {
  let finishUpload;
  let uploadStarted;
  const started = new Promise((resolve) => {
    uploadStarted = resolve;
  });
  const uploading = new Promise((resolve) => {
    finishUpload = resolve;
  });
  const f = fixture(() => {
    uploadStarted();
    return uploading;
  });
  const request = f.service.uploadIssueAttachment("workspace", "project", "issue", archive, undefined, "slot");
  await started;
  assert.deepEqual(f.posts[0][1], { name: "archive.zip", size: 3, type: "application/zip", slot_id: "slot" });
  assert.deepEqual(f.confirmations, []);
  finishUpload();
  assert.deepEqual(await request, attachment);
  assert.deepEqual(f.confirmations, [
    ["/api/assets/v2/workspaces/workspace/projects/project/issues/issue/attachments/file/"],
  ]);
});

test("ordinary attachments keep their existing metadata payload", async () => {
  const f = fixture(async () => undefined);
  await f.service.uploadIssueAttachment("workspace", "project", "issue", archive);
  assert.equal(Object.hasOwn(f.posts[0][1], "slot_id"), false);
  assert.equal(f.confirmations.length, 1);
});

test("storage errors propagate unchanged and never confirm the pending slot attachment", async () => {
  const failure = { error: "Upload failed" };
  const f = fixture(async () => {
    throw failure;
  });
  await assert.rejects(
    f.service.uploadIssueAttachment("workspace", "project", "issue", archive, undefined, "slot"),
    (error) => error === failure
  );
  assert.deepEqual(f.confirmations, []);
});

test("cancelled storage uploads reject instead of continuing into attachment confirmation", async () => {
  const axios = require("axios");
  const failure = new axios.CanceledError("cancelled by user");
  class APIService {
    post() {
      return Promise.reject(failure);
    }
  }
  const { FileUploadService } = load("../file-upload.service.ts", { "@/services/api.service": { APIService } });
  await assert.rejects(new FileUploadService().uploadFile("/storage", new FormData()), (error) => error === failure);
});

test("cancelling an active storage request rejects its upload promise", async () => {
  class APIService {
    post(_url, _data, config) {
      return new Promise((_resolve, reject) => {
        config.signal.addEventListener("abort", () => reject(new Error("Upload canceled")), { once: true });
      });
    }
  }
  const { FileUploadService } = load("../file-upload.service.ts", { "@/services/api.service": { APIService } });
  const service = new FileUploadService();
  const uploading = service.uploadFile("/storage", new FormData());
  service.cancelUpload();
  await assert.rejects(uploading, /Upload canceled/);
});

test("HTTP permission status survives both storage and attachment service error paths", async () => {
  const failure = { response: { status: 403, data: { detail: "Project membership is inactive." } } };
  class APIService {
    post() {
      return Promise.reject(failure);
    }
  }
  const { FileUploadService } = load("../file-upload.service.ts", { "@/services/api.service": { APIService } });
  await assert.rejects(new FileUploadService().uploadFile("/storage", new FormData()), (error) => error === failure);
  const f = fixture(async () => {
    throw failure;
  });
  await assert.rejects(
    f.service.uploadIssueAttachment("workspace", "project", "issue", archive),
    (error) => error === failure
  );
  assert.deepEqual(f.confirmations, []);
});

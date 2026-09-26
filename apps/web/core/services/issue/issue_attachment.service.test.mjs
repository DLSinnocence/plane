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
import { gunzipSync } from "node:zlib";
import * as compression from "../../../helpers/attachment-compression.ts";

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

function fixture(upload, completion, signedResponse = signed, serviceType = "issues") {
  const posts = [];
  const confirmations = [];
  class APIService {
    post(...args) {
      posts.push(args);
      return Promise.resolve({ data: signedResponse });
    }
    patch(...args) {
      confirmations.push(args);
      return Promise.resolve({ data: completion });
    }
  }
  const { IssueAttachmentService } = load("./issue_attachment.service.ts", {
    "@/services/api.service": { APIService },
    "@/services/file-upload.service": {
      FileUploadService: class {
        uploadFile = upload;
      },
    },
    "@/helpers/attachment-compression": compression,
    "@plane/constants": { API_BASE_URL: "" },
    "@plane/types": { EIssueServiceType: { ISSUES: "issues" } },
    "@plane/services": {
      getFileMetaDataForUpload: async (file) => ({ name: file.name, size: file.size, type: file.type }),
      generateFileUploadPayload: (response, file) => {
        const form = new FormData();
        Object.entries(response.upload_data.fields).forEach(([key, value]) => form.append(key, value));
        form.append("file", file);
        return form;
      },
    },
  });
  return { service: new IssueAttachmentService(serviceType), posts, confirmations };
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
  assert.deepEqual(await request, { ...attachment, deleted_attachment_ids: [] });
  assert.deepEqual(f.confirmations, [
    ["/api/assets/v2/workspaces/workspace/projects/project/issues/issue/attachments/file/"],
  ]);
});

test("direct and slot gzip issue uploads retain metadata and send only compressed bytes with signed fields", async () => {
  const source = Buffer.from("8BPS original Photoshop contents");
  const file = new File([source], "design.psd", { type: "image/vnd.adobe.photoshop" });
  Object.defineProperty(file, "size", { value: compression.ATTACHMENT_COMPRESSION_THRESHOLD + 1 });
  const fields = {
    "Content-Encoding": "gzip",
    "Content-Type": file.type,
    key: "asset/design.psd",
    policy: "signed-policy",
  };
  const cases = [undefined, "slot"].map((slotId) => ({ serviceType: "issues", slotId }));
  await Promise.all(
    cases.map(async ({ serviceType, slotId }) => {
      let uploaded;
      const progress = assert.fail;
      const f = fixture(
        async (...args) => {
          uploaded = args;
        },
        undefined,
        { ...signed, upload_data: { url: "/storage", fields } },
        serviceType
      );
      await f.service.uploadIssueAttachment("workspace", "project", "issue", file, progress, slotId);
      const form = uploaded[1];
      const body = form.get("file");
      assert.deepEqual(gunzipSync(Buffer.from(await body.arrayBuffer())), source);
      assert.equal(body.name, file.name);
      assert.equal(body.type, file.type);
      assert.equal(uploaded[0], "/storage");
      assert.equal(uploaded[2], progress);
      for (const [key, value] of Object.entries(fields)) assert.equal(form.get(key), value);
      assert.deepEqual(f.posts[0], [
        `/api/assets/v2/workspaces/workspace/projects/project/${serviceType}/issue/attachments/`,
        {
          name: file.name,
          type: file.type,
          size: file.size,
          content_encoding: "gzip",
          compressed_size: body.size,
          ...(slotId ? { slot_id: slotId } : {}),
        },
      ]);
      assert.equal(f.confirmations.length, 1);
      assert.ok(f.confirmations[0][0].includes(`/${serviceType}/`));
    })
  );
});

test("older API or wrong signed MIME never uploads gzip bytes or confirms an attachment", async () => {
  const file = new File(["8BPS original"], "design.psd", { type: "image/vnd.adobe.photoshop" });
  Object.defineProperty(file, "size", { value: compression.ATTACHMENT_COMPRESSION_THRESHOLD + 1 });
  await Promise.all(
    [{ "Content-Type": file.type }, { "Content-Encoding": "gzip", "Content-Type": "application/gzip" }].map(
      async (fields) => {
        let uploads = 0;
        const f = fixture(
          async () => {
            uploads++;
          },
          undefined,
          { ...signed, upload_data: { url: "/storage", fields } }
        );
        await assert.rejects(f.service.uploadIssueAttachment("workspace", "project", "issue", file), {
          code: "ATTACHMENT_COMPRESSION_NOT_ACCEPTED",
        });
        assert.equal(f.posts.length, 1);
        assert.equal(uploads, 0);
        assert.deepEqual(f.confirmations, []);
      }
    )
  );
});

test("compression failure aborts before requesting an upload signature", async () => {
  const file = new File(["8BPS original"], "design.psd", { type: "image/vnd.adobe.photoshop" });
  Object.defineProperty(file, "size", { value: compression.ATTACHMENT_COMPRESSION_THRESHOLD + 1 });
  file.stream = () => {
    throw new Error("Cannot read source");
  };
  let uploads = 0;
  const f = fixture(async () => {
    uploads++;
  });
  await assert.rejects(f.service.uploadIssueAttachment("workspace", "project", "issue", file), {
    code: "ATTACHMENT_COMPRESSION_FAILED",
  });
  assert.deepEqual(f.posts, []);
  assert.equal(uploads, 0);
  assert.deepEqual(f.confirmations, []);
});

test("small files use the original body and unchanged metadata", async () => {
  let payload;
  const f = fixture(async (_url, form) => {
    payload = form;
  });
  await f.service.uploadIssueAttachment("workspace", "project", "issue", archive);
  assert.equal(payload.get("file"), archive);
  assert.deepEqual(f.posts[0][1], { name: archive.name, type: archive.type, size: archive.size });
});

test("direct uploads let the server assign their named attachment row", async () => {
  const f = fixture(async () => undefined);
  await f.service.uploadIssueAttachment("workspace", "project", "issue", archive);
  assert.equal(Object.hasOwn(f.posts[0][1], "slot_id"), false);
  assert.equal(f.confirmations.length, 1);
});

test("confirmation returns the latest row name and actual replaced file IDs", async () => {
  const row = { id: "slot", name: "Renamed during upload", sort_order: 9 };
  const f = fixture(
    async () => undefined,
    {
      attachment_slot_id: "slot",
      attachment_slot: row,
      deleted_attachment_ids: ["replaced"],
    },
    { ...signed, attachment_slot: { ...row, name: "附件", sort_order: 1 } }
  );
  const result = await f.service.uploadIssueAttachment("workspace", "project", "issue", archive);
  assert.deepEqual(result.attachment_slot, { ...row, attachment: { ...attachment, attachment_slot_id: "slot" } });
  assert.deepEqual(result.deleted_attachment_ids, ["replaced"]);
  assert.equal(result.attachment_slot_id, "slot");
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

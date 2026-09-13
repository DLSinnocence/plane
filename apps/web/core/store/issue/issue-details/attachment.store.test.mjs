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
const compiled = ts.transpileModule(readFileSync(new URL("./attachment.store.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const file = (id) => ({
  id,
  attributes: { name: `${id}.zip`, size: 39 * 1024 },
  issue_id: "issue",
  asset_url: `/files/${id}`,
});
const slot = (attachment = null) => ({ id: "slot", name: "安装包", sort_order: 1, attachment });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture(attachmentApi = {}, slotApi = {}) {
  const api = {
    uploadIssueAttachment: async () => file("new"),
    deleteIssueAttachment: async () => undefined,
    ...attachmentApi,
  };
  const slots = { fetchSlots: async () => [], deleteSlot: async () => undefined, ...slotApi };
  const imports = (specifier) => {
    if (specifier === "@/services/issue")
      return {
        IssueAttachmentService: function IssueAttachmentService() {
          return api;
        },
      };
    if (specifier === "@/services/issue/attachment-template.service") {
      return {
        AttachmentTemplateService: function AttachmentTemplateService() {
          return slots;
        },
      };
    }
    return require(specifier);
  };
  const exports = {};
  new Function("require", "exports", compiled)(imports, exports);
  const updates = [];
  const root = { issueDetail: {}, issues: { updateIssue: (...args) => updates.push(args) } };
  return { store: new exports.IssueAttachmentStore(root, "issues"), updates };
}

test("slot fetches populate attachment lists and preserve replaced files as ordinary attachments", async () => {
  let current = file("old");
  const { store } = fixture({}, { fetchSlots: async () => [slot({ ...current, attachment_slot_id: "slot" })] });
  await store.fetchAttachmentSlots("workspace", "project", "issue");
  assert.equal(store.getAttachmentById("old").attributes.name, "old.zip");
  current = file("new");
  await store.fetchAttachmentSlots("workspace", "project", "issue");
  assert.deepEqual([...store.getAttachmentsByIssueId("issue")], ["old", "new"]);
  assert.equal(store.getAttachmentById("old").attachment_slot_id, null);
  assert.equal(store.getAttachmentSlotsByIssueId("issue")[0].attachment.id, "new");
});

test("a stale fetch cannot erase a newly created slot", async () => {
  const pending = deferred();
  const { store } = fixture({}, { fetchSlots: () => pending.promise, createSlot: async () => slot() });
  const fetching = store.fetchAttachmentSlots("workspace", "project", "issue");
  await store.createAttachmentSlot("workspace", "project", "issue", "安装包");
  pending.resolve([]);
  await fetching;
  assert.deepEqual(
    store.getAttachmentSlotsByIssueId("issue").map(({ name }) => name),
    ["安装包"]
  );
});

test("a failed slot upload leaves the current file in place and clears upload progress", async () => {
  const failure = new Error("storage upload failed");
  let targetSlot;
  const { store } = fixture(
    {
      uploadIssueAttachment: async (...args) => {
        targetSlot = args[5];
        throw failure;
      },
    },
    { fetchSlots: async () => [slot(file("old"))] }
  );
  await store.fetchAttachmentSlots("workspace", "project", "issue");
  await assert.rejects(
    store.createAttachment("workspace", "project", "issue", new File(["zip"], "new.zip"), "slot"),
    (error) => error === failure
  );
  assert.equal(targetSlot, "slot");
  assert.equal(store.getAttachmentSlotsByIssueId("issue")[0].attachment.id, "old");
  assert.deepEqual([...store.getAttachmentsByIssueId("issue")], ["old"]);
  assert.deepEqual(store.getAttachmentsUploadStatusByIssueId("issue"), []);
});

test("a successful upload stays successful when refreshing slots fails", async () => {
  let refreshFails = false;
  const { store } = fixture(
    {},
    {
      fetchSlots: async () => {
        if (refreshFails) throw new Error("refresh failed");
        return [slot(file("old"))];
      },
    }
  );
  await store.fetchAttachmentSlots("workspace", "project", "issue");
  refreshFails = true;
  const result = await store.createAttachment("workspace", "project", "issue", new File(["zip"], "new.zip"), "slot");
  assert.equal(result.id, "new");
  assert.equal(store.getAttachmentSlotsByIssueId("issue")[0].attachment.id, "new");
  assert.deepEqual([...store.getAttachmentsByIssueId("issue")], ["old", "new"]);
});

test("deleting a slot keeps its file, while deleting a file empties its slot", async () => {
  const first = fixture({}, { fetchSlots: async () => [slot(file("old"))] });
  await first.store.fetchAttachmentSlots("workspace", "project", "issue");
  await first.store.removeAttachmentSlot("workspace", "project", "issue", "slot");
  assert.deepEqual(first.store.getAttachmentSlotsByIssueId("issue"), []);
  assert.deepEqual([...first.store.getAttachmentsByIssueId("issue")], ["old"]);
  assert.equal(first.store.getAttachmentById("old").attachment_slot_id, null);

  const second = fixture({}, { fetchSlots: async () => [slot(file("old"))] });
  await second.store.fetchAttachmentSlots("workspace", "project", "issue");
  await second.store.removeAttachment("workspace", "project", "issue", "old");
  assert.equal(second.store.getAttachmentSlotsByIssueId("issue")[0].attachment, null);
  assert.deepEqual([...second.store.getAttachmentsByIssueId("issue")], []);
});

test("late debounced progress does not recreate a completed upload", async () => {
  const { store } = fixture({
    uploadIssueAttachment: async (...args) => {
      args[4]({ progress: 1 });
      return file("new");
    },
  });
  await store.createAttachment("workspace", "project", "issue", new File(["zip"], "new.zip"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(store.getAttachmentsUploadStatusByIssueId("issue"), []);
});

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { autorun, runInAction, toJS } from "mobx";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("./comment.store.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const comment = (id, created_at) => ({ id, created_at, comment_html: `<p>${id}</p>` });

function fixture(api = {}) {
  const imports = (specifier) => {
    if (specifier === "@/services/issue") {
      return {
        IssueCommentService: function IssueCommentService() {
          return api;
        },
      };
    }
    return require(specifier);
  };
  const exports = {};
  new Function("require", "exports", compiled)(imports, exports);
  // No activity store: comments must be readable before activity data even exists.
  const root = { commentReaction: { applyCommentReactions: () => {} } };
  return new exports.IssueCommentStore(root, "issues");
}

function load(store, items, ids = items.map(({ id }) => id)) {
  runInAction(() => {
    store.comments.issue = ids;
    for (const item of items) store.commentMap[item.id] = item;
  });
}

test("comments remain unloaded during fetch then become readable without an activity store", async () => {
  let resolve;
  const response = new Promise((done) => {
    resolve = done;
  });
  const store = fixture({ getIssueComments: () => response });
  assert.equal(store.getSortedCommentsByIssueId("", "asc"), undefined);
  assert.equal(store.getSortedCommentsByIssueId("issue", "asc"), undefined);
  const fetching = store.fetchComments("workspace", "project", "issue");
  assert.equal(store.getSortedCommentsByIssueId("issue", "asc"), undefined);
  resolve([comment("first", "2026-01-01")]);
  await fetching;
  assert.deepEqual(
    store.getSortedCommentsByIssueId("issue", "asc").map(({ id }) => id),
    ["first"]
  );
});

test("a completed empty comments fetch is distinct from an unloaded issue", async () => {
  const store = fixture({ getIssueComments: async () => [] });
  await store.fetchComments("workspace", "project", "issue");
  assert.deepEqual(store.getSortedCommentsByIssueId("issue", "asc"), []);
  assert.equal(store.getSortedCommentsByIssueId("other", "asc"), undefined);
});

test("comments sort by timestamps, retain full records and leave IDs and map unchanged", () => {
  const store = fixture();
  const items = [
    comment("late", "2026-01-01T09:00:00Z"),
    comment("early", "2026-01-01T10:00:00+02:00"),
    comment("undated", null),
  ];
  const ids = ["missing", ...items.map(({ id }) => id)];
  load(store, items, ids);
  const sorted = store.getSortedCommentsByIssueId("issue", "asc");
  assert.deepEqual(
    sorted.map(({ id }) => id),
    ["undated", "early", "late"]
  );
  assert.strictEqual(sorted[1], store.getCommentById("early"));
  assert.equal(sorted[1].comment_html, "<p>early</p>");
  assert.deepEqual(store.getSortedCommentsByIssueId("issue", "desc"), sorted.toReversed());
  assert.deepEqual([...store.comments.issue], ids);
  assert.deepEqual(Object.values(toJS(store.commentMap)), items);
});

test("observed comments react to loading, creation, edits, timestamp changes and deletion", async () => {
  const store = fixture({
    createIssueComment: async () => comment("new", "2026-01-02"),
    patchIssueComment: async () => ({ updated_at: "2026-01-03", edited_at: "2026-01-03" }),
    deleteIssueComment: async () => undefined,
  });
  const snapshots = [];
  const stop = autorun(() => {
    const comments = store.getSortedCommentsByIssueId("issue", "asc");
    snapshots.push(comments?.map(({ id, comment_html }) => ({ id, comment_html })));
  });
  try {
    load(store, []);
    load(store, [comment("old", "2026-01-01")]);
    await store.createComment("workspace", "project", "issue", {});
    assert.deepEqual(
      snapshots.at(-1).map(({ id }) => id),
      ["old", "new"]
    );
    await store.updateComment("workspace", "project", "issue", "new", { comment_html: "edited" });
    assert.equal(snapshots.at(-1)[1].comment_html, "edited");
    runInAction(() => {
      store.commentMap.new.created_at = "2025-01-01";
    });
    assert.deepEqual(
      snapshots.at(-1).map(({ id }) => id),
      ["new", "old"]
    );
    await store.removeComment("workspace", "project", "issue", "old");
    assert.deepEqual(
      snapshots.at(-1).map(({ id }) => id),
      ["new"]
    );
    assert.equal(snapshots[0], undefined);
    assert.deepEqual(snapshots[1], []);
  } finally {
    stop();
  }
});

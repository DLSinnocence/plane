/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { autorun, observable, runInAction, toJS } from "mobx";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("./activity.store.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const EActivityFilterType = {
  STATE: "state",
  ASSIGNEE: "assignee",
  DEFAULT: "default",
  ACTIVITY: "activity",
  COMMENT: "comment",
};
const activity = (id, field, created_at) => ({ id, field, created_at, new_value: "not part of projection" });
function IssueActivityService() {
  return {};
}

function fixture(serviceType = "issues") {
  const comments = observable({ ids: undefined, map: {} });
  const comment = {
    getCommentsByIssueId: () => comments.ids,
    getCommentById: (id) => comments.map[id],
  };
  const root = {
    issue: {
      issueDetail: { comment: serviceType === "issues" ? comment : undefined },
      epicDetail: { comment: serviceType === "epics" ? comment : undefined },
    },
  };
  const imports = (specifier) => {
    if (specifier === "@plane/constants") return { EActivityFilterType };
    if (specifier === "@plane/types") return { EIssueServiceType: { ISSUES: "issues", EPICS: "epics" } };
    if (specifier === "@/services/issue") return { IssueActivityService };
    return require(specifier);
  };
  const exports = {};
  new Function("require", "exports", compiled)(imports, exports);
  return { store: new exports.IssueActivityStore(root, serviceType), comments };
}

function load(store, items, ids = items.map(({ id }) => id)) {
  runInAction(() => {
    store.activities.issue = ids;
    for (const item of items) store.activityMap[item.id] = item;
  });
}

test("activity reads distinguish unloaded and empty without waiting for comments", () => {
  const { store } = fixture();
  assert.equal(store.getActivityItemsByIssueId("", "asc"), undefined);
  assert.equal(store.getActivityItemsByIssueId("issue", "asc"), undefined);
  load(store, []);
  assert.deepEqual(store.getActivityItemsByIssueId("issue", "asc"), []);
  assert.equal(store.getActivityAndCommentsByIssueId("issue", "asc"), undefined);
  load(store, [activity("a", null, "2026-01-01")]);
  assert.deepEqual(store.getActivityItemsByIssueId("issue", "asc"), [
    { id: "a", activity_type: "default", created_at: "2026-01-01" },
  ]);
});

test("activity projection classifies fields and sorts dates without changing source IDs or records", () => {
  const { store } = fixture();
  const items = [
    activity("generic", "priority", "2026-01-03"),
    activity("state", "state", "2026-01-01"),
    activity("default", null, "2026-01-04"),
    activity("assignee", "assignees", "2026-01-02"),
  ];
  const ids = ["missing", ...items.map(({ id }) => id)];
  load(store, items, ids);
  const ascending = store.getActivityItemsByIssueId("issue", "asc");
  assert.deepEqual(ascending, [
    { id: "state", activity_type: "state", created_at: "2026-01-01" },
    { id: "assignee", activity_type: "assignee", created_at: "2026-01-02" },
    { id: "generic", activity_type: "activity", created_at: "2026-01-03" },
    { id: "default", activity_type: "default", created_at: "2026-01-04" },
  ]);
  assert.deepEqual(store.getActivityItemsByIssueId("issue", "desc"), ascending.toReversed());
  assert.deepEqual([...store.activities.issue], ids);
  assert.deepEqual(Object.values(toJS(store.activityMap)), items);
});

for (const serviceType of ["issues", "epics"]) {
  test(`combined ${serviceType} reads still wait for both datasets and merge in date order`, () => {
    const { store, comments } = fixture(serviceType);
    runInAction(() => {
      comments.ids = ["comment", "missing"];
      comments.map.comment = { id: "comment", created_at: "2026-01-02" };
    });
    assert.equal(store.getActivityAndCommentsByIssueId("issue", "asc"), undefined);
    load(store, [activity("a", "state", "2026-01-01"), activity("b", "priority", "2026-01-03")]);
    const combined = store.getActivityAndCommentsByIssueId("issue", "asc");
    assert.deepEqual(
      combined.map(({ id }) => id),
      ["a", "comment", "b"]
    );
    assert.equal(combined[1].activity_type, "comment");
    assert.deepEqual(store.getActivityAndCommentsByIssueId("issue", "desc"), combined.toReversed());
    runInAction(() => {
      comments.ids = [];
      store.activities.issue = [];
    });
    assert.deepEqual(store.getActivityAndCommentsByIssueId("issue", "asc"), []);
  });
}

test("observed activity reads react to loading, ID and record changes independently of comments", () => {
  const { store, comments } = fixture();
  const snapshots = [];
  const stop = autorun(() => snapshots.push(store.getActivityItemsByIssueId("issue", "asc")));
  try {
    load(store, []);
    load(store, [activity("a", "priority", "2026-01-02"), activity("b", "state", "2026-01-01")]);
    runInAction(() => {
      store.activityMap.a.created_at = "2025-01-01";
      store.activityMap.a.field = "assignees";
    });
    runInAction(() => {
      store.activities.issue.splice(1, 1);
    });
    assert.equal(snapshots[0], undefined);
    assert.deepEqual(snapshots[1], []);
    assert.deepEqual(
      snapshots[2].map(({ id }) => id),
      ["b", "a"]
    );
    assert.equal(snapshots[3][0].id, "a");
    assert.equal(snapshots[3][0].activity_type, "assignee");
    assert.deepEqual(
      snapshots[4].map(({ id }) => id),
      ["a"]
    );
    runInAction(() => {
      comments.ids = [];
    });
    assert.equal(snapshots.length, 5);
  } finally {
    stop();
  }
});

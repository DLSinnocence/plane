/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { set } from "lodash-es";

// Exercise the actual update method with isolated store/service collaborators.
// Loading the root store would require the browser and the application router.
const source = ts.createSourceFile(
  "base-issues.store.ts",
  readFileSync(new URL("./base-issues.store.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
);
const storeClass = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name.text === "BaseIssuesStore"
);
const method = storeClass.members.find(
  (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "issueUpdate"
);
const compiled = ts.transpileModule(`class Store { ${method.getText(source)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const issueUpdate = new Function("clone", "runInAction", `${compiled}; return Store.prototype.issueUpdate;`)(
  (value) => (value ? { ...value } : value),
  (callback) => callback()
);

const issueStoreSource = ts.createSourceFile(
  "issue.store.ts",
  readFileSync(new URL("../issue.store.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
);
const issueStoreClass = issueStoreSource.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name.text === "IssueStore"
);
const setter = issueStoreClass.members.find(
  (node) => ts.isPropertyDeclaration(node) && node.name.getText(issueStoreSource) === "updateIssue"
);
const compiledSetter = ts.transpileModule(`class Store { ${setter.getText(issueStoreSource)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const IssueFieldStore = new Function(
  "set",
  "runInAction",
  "getCurrentDateTimeInISO",
  `${compiledSetter}; return Store;`
)(
  set,
  (callback) => callback(),
  () => "2026-01-01T00:00:00Z"
);

function fixture(patchIssue) {
  const issue = { id: "issue", project_id: "project", state_id: "todo", assignee_ids: ["alice"] };
  const fieldStore = new IssueFieldStore();
  fieldStore.issuesMap = { issue };
  const groups = [];
  const stats = [];
  const store = {
    assertCanEditIssue: () => {},
    rootIssueStore: {
      issues: {
        getIssueById: () => issue,
        updateIssue: fieldStore.updateIssue,
      },
    },
    issueService: { patchIssue },
    updateIssueList: (after, before) => groups.push({ after: structuredClone(after), before: structuredClone(before) }),
    updateParentStats: (before, after) =>
      stats.push({ before: structuredClone(before), after: structuredClone(after) }),
    fetchParentStats: () => {},
  };
  return {
    issue,
    groups,
    stats,
    update: (data, sync = true) => issueUpdate.call(store, "workspace", "project", "issue", data, sync),
  };
}

test("transitions use destination assignees and reconcile groups from the optimistic state", async () => {
  const result = fixture(async () => ({
    state_id: "doing",
    assignee_ids: ["bob"],
    state_assignees: { doing: ["bob"] },
  }));
  await result.update({ state_id: "doing" });
  assert.deepEqual(result.issue.assignee_ids, ["bob"]);
  assert.deepEqual(result.issue.state_assignees, { doing: ["bob"] });
  assert.deepEqual(result.groups[1].before.assignee_ids, ["alice"]);
  assert.deepEqual(result.groups[1].after.assignee_ids, ["bob"]);
  assert.equal(result.groups[1].before.state_id, "doing");
});

test("a response matching the optimistic state does not repeat the state group change", async () => {
  const result = fixture(async () => ({ state_id: "doing", assignee_ids: ["alice"] }));
  await result.update({ state_id: "doing" });
  const stateChanges = result.groups.filter(({ before, after }) => before.state_id !== after.state_id);
  assert.equal(stateChanges.length, 1);
  assert.equal(stateChanges[0].before.state_id, "todo");
  assert.equal(stateChanges[0].after.state_id, "doing");
});

test("groups reconcile even if the shared map already received the server assignment", async () => {
  const response = { state_id: "doing", assignee_ids: ["bob"], state_assignees: { doing: ["bob"] } };
  const result = fixture(async () => {
    // Another consumer has synchronized the shared map, but not this view's groups.
    Object.assign(result.issue, response);
    return response;
  });
  await result.update({ state_id: "doing" });
  assert.deepEqual(result.groups[1].before.assignee_ids, ["alice"]);
  assert.deepEqual(result.groups[1].after.assignee_ids, ["bob"]);
  assert.equal(result.groups.filter(({ before, after }) => before.state_id !== after.state_id).length, 1);
});

test("empty server assignments replace optimistic assignments and maps", async () => {
  const result = fixture(async () => ({ assignee_ids: [], state_assignees: {} }));
  await result.update({ assignee_ids: ["bob"], state_assignees: { todo: ["bob"] } });
  assert.deepEqual(result.issue.assignee_ids, []);
  assert.deepEqual(result.issue.state_assignees, {});
  assert.deepEqual(result.groups[1].before.assignee_ids, ["bob"]);
  assert.deepEqual(result.groups[1].after.assignee_ids, []);
});

test("server reset removes a state key without merging old assignments back", async () => {
  const result = fixture(async () => ({ state_assignees: { doing: ["bob"] } }));
  result.issue.state_assignees = { todo: ["alice"], doing: ["bob"] };
  await result.update({ state_assignees: { doing: ["bob"] } });
  assert.deepEqual(result.issue.state_assignees, { doing: ["bob"] });
  assert.equal(Object.hasOwn(result.issue.state_assignees, "todo"), false);
});

test("permission failures restore the issue, optional map, groups and parent counts", async () => {
  const error = new Error("Forbidden");
  const result = fixture(async () => {
    throw error;
  });
  await assert.rejects(
    result.update({ state_id: "doing", assignee_ids: ["bob"], state_assignees: { doing: ["bob"] } }),
    error
  );
  assert.equal(result.issue.state_id, "todo");
  assert.deepEqual(result.issue.assignee_ids, ["alice"]);
  assert.equal(result.issue.state_assignees, undefined);
  assert.equal(result.groups[1].before.state_id, "doing");
  assert.equal(result.groups[1].after.state_id, "todo");
  assert.equal(result.stats[1].before.state_id, "doing");
  assert.equal(result.stats[1].after.state_id, "todo");
});

test("rejected testing preference updates restore the No default and explicit values", async () => {
  await Promise.all(
    [undefined, false, true].map(async (previous) => {
      const result = fixture(async () => {
        throw new Error("Rejected");
      });
      if (previous !== undefined) result.issue.needs_testing = previous;
      await assert.rejects(result.update({ needs_testing: previous !== true }), /Rejected/);
      assert.equal(result.issue.needs_testing, previous ?? false);
    })
  );
});

test("local-only updates do not contact the server", async () => {
  const result = fixture(async () => {
    assert.fail("unexpected PATCH");
  });
  await result.update({ state_id: "doing" }, false);
  assert.equal(result.issue.state_id, "doing");
  assert.equal(result.groups.length, 1);
  assert.equal(result.stats.length, 0);
});

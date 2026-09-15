/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { action, autorun, observable } from "mobx";
import ts from "typescript";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("./sub_issues.store.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const response = (...ids) => ({
  sub_issues: ids.map((id) => ({ id, project_id: "project", created_at: "2026-01-01T00:00:00Z" })),
  state_distribution: { unstarted: ids },
});

function WorkItemSubIssueFiltersStore(subIssueStore) {
  return { subIssueStore };
}

function fixture(subIssues) {
  const calls = [];
  const api = {
    subIssues: (...args) => {
      calls.push(args);
      return subIssues(...args);
    },
  };
  const imports = (specifier) => {
    if (specifier === "@/services/issue")
      return {
        IssueService: function IssueService() {
          return api;
        },
      };
    if (specifier === "./sub_issues_filter.store") return { WorkItemSubIssueFiltersStore };
    return require(specifier);
  };
  const exports = {};
  new Function("require", "exports", compiled)(imports, exports);
  const issuesMap = observable({
    parent: { id: "parent", sub_issues_count: 0 },
    other: { id: "other", sub_issues_count: 0 },
  });
  const issues = {
    issuesMap,
    addIssue: action((children) => {
      for (const child of children) issuesMap[child.id] = child;
    }),
    updateIssue: action((id, data) => {
      Object.assign(issuesMap[id], data);
    }),
  };
  const root = { rootIssueStore: { issues } };
  const store = new exports.IssueSubIssuesStore(root, "issues");
  return { store, calls, issuesMap };
}

const fetchParent = (store) => store.fetchSubIssues("workspace", "project", "parent");

test("concurrent fetches of the same parent share one request and promise", async () => {
  const pending = deferred();
  const { store, calls, issuesMap } = fixture(() => pending.promise);
  const first = fetchParent(store);
  const second = fetchParent(store);
  assert.equal(first, second);
  assert.deepEqual(calls, [["workspace", "project", "parent"]]);
  assert.equal(store.loader, "init-loader");
  const data = response("child");
  pending.resolve(data);
  assert.equal(await first, data);
  assert.equal(await second, data);
  assert.deepEqual([...store.subIssuesByIssueId("parent")], ["child"]);
  assert.equal(issuesMap.parent.sub_issues_count, 1);
  assert.equal(store.loader, undefined);
});

test("different parents load independently and keep the loader until both finish", async () => {
  const parent = deferred();
  const other = deferred();
  const { store, calls } = fixture((_workspace, _project, id) => (id === "parent" ? parent.promise : other.promise));
  const first = fetchParent(store);
  const second = store.fetchSubIssues("workspace", "project", "other");
  assert.notEqual(first, second);
  assert.equal(calls.length, 2);
  other.resolve(response("other-child"));
  await second;
  assert.deepEqual([...store.subIssuesByIssueId("other")], ["other-child"]);
  assert.equal(store.subIssuesByIssueId("parent"), undefined);
  assert.equal(store.loader, "init-loader");
  parent.resolve(response("child"));
  await first;
  assert.deepEqual([...store.subIssuesByIssueId("parent")], ["child"]);
  assert.equal(store.loader, undefined);
});

test("deduplication includes workspace and project in addition to parent", async () => {
  const pending = [deferred(), deferred(), deferred()];
  let index = 0;
  const { store, calls } = fixture(() => pending[index++].promise);
  const requests = [
    fetchParent(store),
    store.fetchSubIssues("other-workspace", "project", "parent"),
    store.fetchSubIssues("workspace", "other-project", "parent"),
  ];
  assert.equal(new Set(requests).size, 3);
  assert.equal(calls.length, 3);
  for (const request of pending) request.resolve(response());
  await Promise.all(requests);
  assert.equal(store.loader, undefined);
});

test("rejection clears the loader and releases the request so a later fetch retries", async () => {
  const pending = deferred();
  const failure = new Error("network unavailable");
  let attempts = 0;
  const { store, calls } = fixture(() => (++attempts === 1 ? pending.promise : Promise.resolve(response("child"))));
  const first = fetchParent(store);
  assert.equal(fetchParent(store), first);
  const rejected = assert.rejects(first, (error) => error === failure);
  pending.reject(failure);
  await rejected;
  assert.equal(store.loader, undefined);
  assert.equal(store.subIssuesByIssueId("parent"), undefined);
  await fetchParent(store);
  assert.equal(calls.length, 2);
  assert.deepEqual([...store.subIssuesByIssueId("parent")], ["child"]);
  assert.equal(store.loader, undefined);
});

test("a failed refresh preserves hydrated children, parent count and state distribution", async () => {
  let attempts = 0;
  const { store, issuesMap } = fixture(async () => {
    if (++attempts > 1) throw new Error("refresh failed");
    return response("child", "sibling");
  });
  await fetchParent(store);
  await assert.rejects(fetchParent(store), /refresh failed/);
  assert.deepEqual([...store.subIssuesByIssueId("parent")], ["child", "sibling"]);
  assert.equal(issuesMap.parent.sub_issues_count, 2);
  assert.equal(issuesMap.child.id, "child");
  assert.deepEqual([...store.stateDistributionByIssueId("parent").unstarted], ["child", "sibling"]);
  assert.equal(store.loader, undefined);
});

test("observers receive child records, parent count, IDs and distribution atomically", async () => {
  const pending = deferred();
  const { store, issuesMap } = fixture(() => pending.promise);
  const snapshots = [];
  const dispose = autorun(() => {
    snapshots.push({
      count: issuesMap.parent.sub_issues_count,
      child: issuesMap.child?.id,
      ids: [...(store.subIssuesByIssueId("parent") ?? [])],
      distribution: [...(store.stateDistributionByIssueId("parent")?.unstarted ?? [])],
    });
  });
  try {
    const fetching = fetchParent(store);
    pending.resolve(response("child"));
    await fetching;
    assert.deepEqual(snapshots, [
      { count: 0, child: undefined, ids: [], distribution: [] },
      { count: 1, child: "child", ids: ["child"], distribution: ["child"] },
    ]);
  } finally {
    dispose();
  }
});

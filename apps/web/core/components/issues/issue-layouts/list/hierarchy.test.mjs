/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { autorun, observable, runInAction } from "mobx";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { getListRootIssueIds } from "./hierarchy.ts";

const issue = (id, parentId = null, childCount = 0) => ({
  id,
  parent_id: parentId,
  sub_issues_count: childCount,
  created_at: "2026-09-15T00:00:00Z",
});

const fixture = () => ({
  parent: issue("parent", null, 1),
  child: issue("child", "parent", 1),
  grandchild: issue("grandchild", "child"),
  unrelated: issue("unrelated"),
});

test("children sorted before their parents only appear through the hierarchy", () => {
  const issuesMap = fixture();
  const issueIds = ["grandchild", "child", "unrelated", "parent"];
  assert.deepEqual(getListRootIssueIds(issueIds, issuesMap), ["unrelated", "parent"]);
  assert.deepEqual(issueIds, ["grandchild", "child", "unrelated", "parent"]);
});

test("an ancestor outside the current filter, page or group does not hide the child", () => {
  const issuesMap = fixture();
  assert.deepEqual(getListRootIssueIds(["child", "grandchild"], issuesMap), ["child"]);
  assert.deepEqual(getListRootIssueIds(["grandchild"], issuesMap), ["grandchild"]);
});

test("a cached intermediate parent still provides a path from a listed ancestor", () => {
  assert.deepEqual(getListRootIssueIds(["grandchild", "parent"], fixture()), ["parent"]);
});

test("missing or non-expandable parents do not make children inaccessible", () => {
  for (const parent of [undefined, { id: "parent" }, issue("parent")]) {
    const issuesMap = { ...fixture(), parent };
    assert.ok(getListRootIssueIds(["parent", "child"], issuesMap).includes("child"));
  }
  const issuesMap = fixture();
  delete issuesMap.child;
  assert.deepEqual(getListRootIssueIds(["parent", "grandchild"], issuesMap), ["parent", "grandchild"]);
});

test("self references and parent cycles never remove every work item", () => {
  const issuesMap = {
    self: issue("self", "self", 1),
    first: issue("first", "second", 1),
    second: issue("second", "first", 1),
  };
  assert.deepEqual(getListRootIssueIds(["self", "first", "second"], issuesMap), ["self", "first", "second"]);
});

test("observable parent changes and pagination recompute roots without replacing the map", () => {
  const issuesMap = observable(fixture());
  const issueIds = observable(["child"]);
  const snapshots = [];
  const dispose = autorun(() => snapshots.push(getListRootIssueIds(issueIds, issuesMap)));
  try {
    runInAction(() => issueIds.push("parent"));
    runInAction(() => {
      issuesMap.child.parent_id = null;
    });
    runInAction(() => {
      issuesMap.child.parent_id = "parent";
    });
    assert.deepEqual(snapshots, [["child"], ["parent"], ["child", "parent"], ["parent"]]);
  } finally {
    dispose();
  }
});

// Render the production list, isolating row internals that require the app's router and stores.
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("./blocks-list.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const listModule = {};
new Function("require", "exports", compiled)((id) => {
  if (id === "./hierarchy") return { getListRootIssueIds };
  if (id === "./block-root")
    return {
      IssueBlockRoot: ({ issueId, isLastChild, nestingLevel }) =>
        createElement("div", {
          "data-issue-id": issueId,
          "data-last-child": isLastChild,
          "data-nesting-level": nestingLevel,
        }),
    };
  return require(id);
}, listModule);

const renderList = (issueIds, isEpic = false) =>
  renderToStaticMarkup(
    createElement(listModule.IssueBlocksList, {
      issueIds,
      issuesMap: fixture(),
      groupId: "all-issues",
      isEpic,
    })
  );

test("the list renders only roots and marks the last rendered row for drag and drop", () => {
  const html = renderList(["child", "unrelated", "parent", "grandchild"]);
  assert.equal((html.match(/data-issue-id=/g) ?? []).length, 2);
  assert.ok(!html.includes('data-issue-id="child"'));
  assert.ok(!html.includes('data-issue-id="grandchild"'));
  assert.ok(html.includes('data-issue-id="unrelated" data-last-child="false" data-nesting-level="0"'));
  assert.ok(html.includes('data-issue-id="parent" data-last-child="true" data-nesting-level="0"'));
});

test("epic lists keep their flat rows because they do not render nested children", () => {
  const html = renderList(["parent", "child"], true);
  assert.equal((html.match(/data-issue-id=/g) ?? []).length, 2);
  assert.ok(html.includes('data-issue-id="child" data-last-child="true"'));
});

test("empty lists render without rows", () => {
  assert.ok(!renderList([]).includes("data-issue-id="));
});

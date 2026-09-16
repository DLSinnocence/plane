/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { observable, runInAction } from "mobx";
import React from "react";
import { act, create } from "react-test-renderer";
import ts from "typescript";
import { MAX_LIST_NESTING_LEVEL } from "./hierarchy.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
const load = (path, mocks = {}) => {
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)((id) => mocks[id] ?? require(id), exports);
  return exports;
};
const expansion = load("../../../../hooks/use-expanded-sub-issues.ts", {
  "../components/issues/issue-layouts/list/hierarchy": { MAX_LIST_NESTING_LEVEL },
});
const nothing = () => null;
function WorkItemSubIssueFiltersStore(subIssueStore) {
  return { subIssueStore };
}

async function mountList(initialChildren) {
  let serverChildren = initialChildren;
  const calls = [];
  const issuesMap = observable({
    parent: {
      id: "parent",
      project_id: "project",
      created_at: "2026-01-01",
      sub_issues_count: initialChildren.length,
    },
  });
  const { IssueSubIssuesStore } = load("../../../../store/issue/issue-details/sub_issues.store.ts", {
    "@/services/issue": {
      IssueService: function IssueService() {
        return {
          subIssues: async () => {
            calls.push([...serverChildren]);
            return {
              sub_issues: serverChildren.map((id) => ({
                id,
                parent_id: "parent",
                project_id: "project",
                created_at: "2026-01-01",
                sub_issues_count: 0,
              })),
              state_distribution: { unstarted: [...serverChildren] },
            };
          },
        };
      },
    },
    "./sub_issues_filter.store": { WorkItemSubIssueFiltersStore },
  });
  const subIssues = new IssueSubIssuesStore(
    {
      rootIssueStore: {
        issues: {
          addIssue: (children) => children.forEach((child) => (issuesMap[child.id] = child)),
          updateIssue: (id, data) => Object.assign(issuesMap[id], data),
        },
      },
    },
    "issues"
  );
  const { IssueBlockRoot } = load("./block-root.tsx", {
    "@atlaskit/pragmatic-drag-and-drop/combine": { combine: nothing },
    "@atlaskit/pragmatic-drag-and-drop/element/adapter": { dropTargetForElements: nothing },
    "@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item": {},
    "@plane/hooks": { useOutsideClickDetector: nothing },
    "@plane/types": { EIssueServiceType: { ISSUES: "issues", EPICS: "epics" } },
    "@plane/ui": { DropIndicator: nothing },
    "@/components/core/render-if-visible-HOC": { default: ({ children }) => children, __esModule: true },
    "@/components/ui/loader/layouts/list-layout-loader": { ListLoaderItemRow: nothing },
    "next/navigation": { useParams: () => ({ workspaceSlug: "workspace" }) },
    "@/hooks/use-expanded-sub-issues": expansion,
    "@/hooks/store/use-issue-detail": { useIssueDetail: () => ({ subIssues }) },
    "@/hooks/use-platform-os": { usePlatformOS: () => ({ isMobile: false }) },
    "../utils": { getIssueBlockId: (id) => id, isIssueNew: () => false },
    "../sub-issues-load-status": { SubIssuesLoadStatus: nothing },
    "./block": {
      IssueBlock: ({ issueId, setExpanded }) =>
        React.createElement(
          "button",
          { "data-issue": issueId, onClick: () => setExpanded((value) => !value) },
          issueId
        ),
    },
  });
  let renderer;
  await act(async () => {
    renderer = create(
      React.createElement(IssueBlockRoot, {
        issueId: "parent",
        issuesMap,
        nestingLevel: 0,
        containerRef: { current: null },
        canEditProperties: () => false,
        quickActions: nothing,
        selectionHelpers: {},
        groupId: "all",
        isDragAllowed: false,
        canDropOverIssue: false,
      })
    );
  });
  return {
    calls,
    subIssues,
    issuesMap,
    visibleIds: () => renderer.root.findAllByType("button").map((row) => row.props["data-issue"]),
    sync: async (ids) => {
      serverChildren = ids;
      // A different client deleted/created work items; the list refresh reports the new parent count.
      await act(async () => runInAction(() => (issuesMap.parent.sub_issues_count = ids.length)));
    },
    toggle: () => act(async () => renderer.root.findByProps({ "data-issue": "parent" }).props.onClick()),
    unmount: () => act(async () => renderer.unmount()),
  };
}

test("another user's deletion of the last child removes its already expanded row after synchronization", async () => {
  const view = await mountList(["deleted"]);
  try {
    assert.deepEqual(view.visibleIds(), ["parent", "deleted"]);
    await view.sync([]);
    assert.equal(view.issuesMap.parent.sub_issues_count, 0);
    assert.deepEqual(view.visibleIds(), ["parent"]);
  } finally {
    await view.unmount();
  }
});

test("deleting all children then adding one at the old count loads the replacement", async () => {
  const view = await mountList(["deleted"]);
  try {
    await view.sync([]);
    assert.deepEqual(view.visibleIds(), ["parent"]);
    await view.sync(["replacement"]);
    assert.deepEqual(view.visibleIds(), ["parent", "replacement"]);
    assert.deepEqual(view.subIssues.subIssuesByIssueId("parent"), ["replacement"]);
    assert.deepEqual(view.calls, [["deleted"], ["replacement"]]);
  } finally {
    await view.unmount();
  }
});

test("deletions synchronized while collapsed do not reuse the previous child snapshot on reopening", async () => {
  const view = await mountList(["deleted", "sibling"]);
  try {
    await view.toggle();
    await view.sync(["sibling"]);
    await view.sync(["sibling", "replacement"]);
    assert.deepEqual(view.visibleIds(), ["parent"]);
    await view.toggle();
    assert.deepEqual(view.visibleIds(), ["parent", "sibling", "replacement"]);
    assert.deepEqual(view.calls, [
      ["deleted", "sibling"],
      ["sibling", "replacement"],
    ]);
  } finally {
    await view.unmount();
  }
});

test("a child count seen earlier does not restore a deleted row or omit the replacement", async () => {
  const view = await mountList(["deleted", "sibling"]);
  try {
    await view.sync(["sibling"]);
    assert.deepEqual(view.visibleIds(), ["parent", "sibling"]);
    await view.sync(["sibling", "replacement"]);
    assert.deepEqual(view.visibleIds(), ["parent", "sibling", "replacement"]);
    await view.sync(["replacement"]);
    assert.deepEqual(view.visibleIds(), ["parent", "replacement"]);
  } finally {
    await view.unmount();
  }
});

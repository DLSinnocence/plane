/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import * as lodash from "lodash-es";
import { runInAction } from "mobx";
import ts from "typescript";

const require = createRequire(import.meta.url);
function loadSource(relativePath, mocks) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function("require", "exports", compiled)((id) => (id in mocks ? mocks[id] : require(id)), exports);
  return exports;
}

const storageData = new Map();
const { IssueFilterHelperStore } = loadSource("../core/store/issue/helpers/issue-filter-helper.store.ts", {
  "lodash-es": lodash,
  "@plane/constants": {
    EIssueGroupByToServerOptions: {},
    EServerGroupByToFilterOptions: {},
    ENABLE_ISSUE_DEPENDENCIES: false,
  },
  "@plane/types": { EIssueLayoutTypes: { GANTT: "gantt" } },
  "@plane/utils": {},
  "@/lib/local-storage": {
    storage: { get: (key) => storageData.get(key), set: (key, value) => storageData.set(key, value) },
  },
});
const helper = new IssueFilterHelperStore();

test("the production list ignores saved collapse, permits temporary collapse, and resets on navigation", async () => {
  const oldGroups = { group_by: ["todo"], sub_group_by: [] };
  const issueStore = {
    issueMap: {},
    issues: { groupedIssueIds: {}, viewFlags: {} },
    issuesFilter: { issueFilters: { displayFilters: { group_by: "state" }, kanbanFilters: oldGroups } },
  };
  let writes = 0;
  const actions = {
    fetchIssues: () => {},
    fetchNextIssues: () => {},
    updateFilters: () => {
      writes++;
    },
  };
  const { BaseListRoot } = loadSource("../core/components/issues/issue-layouts/list/base-list-root.tsx", {
    "next/navigation": { useParams: () => ({ workspaceSlug: "workspace", projectId: "project" }) },
    "@plane/constants": { EUserPermissions: { ADMIN: 20, MEMBER: 15 }, EUserPermissionsLevel: { PROJECT: "project" } },
    "@plane/types": { EIssueLayoutTypes: { LIST: "list" } },
    "@/hooks/store/use-issues": { useIssues: () => issueStore },
    "@/hooks/store/user": { useUserPermissions: () => ({ allowPermissions: () => false }) },
    "@/hooks/use-group-dragndrop": { useGroupIssuesDragNDrop: () => () => {} },
    "@/hooks/use-issue-layout-store": { useIssueStoreType: () => "profile" },
    "@/hooks/use-issues-actions": { useIssuesActions: () => actions },
    "../issue-layout-HOC": { IssueLayoutHOC: ({ children }) => children },
    "./default": {
      List: ({ collapsedGroups, handleCollapsedGroups }) =>
        createElement("button", {
          "data-collapsed": collapsedGroups.group_by.length,
          onClick: () => handleCollapsedGroups("todo"),
        }),
    },
  });
  let renderer;
  const props = { QuickActions: () => null, viewId: "assigned" };
  try {
    await act(async () => {
      renderer = create(createElement(BaseListRoot, props));
    });
    assert.equal(renderer.root.findByType("button").props["data-collapsed"], 0);
    await act(async () => renderer.root.findByType("button").props.onClick());
    assert.equal(renderer.root.findByType("button").props["data-collapsed"], 1);
    assert.equal(writes, 0);
    assert.deepEqual(oldGroups.group_by, ["todo"]);
    await act(async () => renderer.update(createElement(BaseListRoot, { ...props, viewId: "created" })));
    assert.equal(renderer.root.findByType("button").props["data-collapsed"], 0);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
  }
});

test("requests always include children regardless of saved false or legacy layout parameter lists", () => {
  for (const displayFilters of [undefined, {}, { sub_issue: false }, { sub_issue: true }]) {
    for (const acceptedParams of [[], ["sub_issue"]]) {
      assert.equal(helper.computedFilteredParams({}, displayFilters, acceptedParams).sub_issue, true);
    }
  }
  const filters = { displayFilters: { sub_issue: false, layout: "list" } };
  assert.equal(helper.computedIssueFilters(filters).displayFilters.sub_issue, true);
  assert.equal(filters.displayFilters.sub_issue, false, "normalizing a snapshot does not mutate its caller");
});

test("pagination cannot restore a false child filter", () => {
  for (const cursor of [undefined, "100:2:0"]) {
    const params = helper.getPaginationParams({ sub_issue: false }, { perPageCount: 100 }, cursor);
    assert.equal(params.sub_issue, true);
    assert.equal(params.per_page, "100");
  }
});

test("writing any preference removes false child visibility from existing saved records", () => {
  storageData.set(
    "issue_local_filters",
    JSON.stringify([
      {
        key: "profile",
        workspaceSlug: "workspace",
        viewId: "user",
        filters: { display_filters: { sub_issue: false, layout: "list" } },
      },
      {
        key: "project",
        workspaceSlug: "workspace",
        viewId: "other",
        filters: { display_filters: { sub_issue: false, layout: "kanban" } },
      },
    ])
  );
  helper.handleIssuesLocalFilters.set("profile", "rich_filters", "workspace", "user", undefined, { rich_filters: {} });
  let saved = JSON.parse(storageData.get("issue_local_filters"));
  assert.deepEqual(
    saved.map((entry) => entry.filters.display_filters.sub_issue),
    [true, true]
  );
  assert.deepEqual(
    saved.map((entry) => entry.filters.display_filters.layout),
    ["list", "kanban"]
  );
  helper.handleIssuesLocalFilters.set("profile", "display_filters", "workspace", "new-user", undefined, {
    display_filters: { sub_issue: false, layout: "list" },
  });
  saved = JSON.parse(storageData.get("issue_local_filters"));
  assert.equal(saved.at(-1).filters.display_filters.sub_issue, true);
});

test("old collapsed groups and hidden-child settings are not restored or persisted", () => {
  storageData.set(
    "issue_local_filters",
    JSON.stringify([
      {
        key: "profile",
        workspaceSlug: "workspace",
        viewId: "user",
        filters: {
          display_filters: { sub_issue: false, layout: "list" },
          kanban_filters: { group_by: ["todo"], sub_group_by: ["member"] },
        },
      },
    ])
  );
  const loaded = helper.handleIssuesLocalFilters.get("profile", "workspace", "user", undefined);
  assert.equal(loaded.display_filters.sub_issue, true);
  assert.deepEqual(loaded.kanban_filters, { group_by: [], sub_group_by: [] });
  helper.handleIssuesLocalFilters.set("profile", "kanban_filters", "workspace", "user", undefined, {
    kanban_filters: { group_by: ["todo"], sub_group_by: [] },
  });
  const saved = JSON.parse(storageData.get("issue_local_filters"))[0].filters;
  assert.equal(saved.display_filters.sub_issue, true);
  assert.deepEqual(saved.kanban_filters, { group_by: [], sub_group_by: [] });
});

test("live issue updates retain child rows even when the store still contains old false", () => {
  const source = ts.createSourceFile(
    "base.ts",
    readFileSync(new URL("../core/store/issue/helpers/base-issues.store.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  let method;
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === "updateIssueList") method = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(method);
  const compiled = ts.transpileModule(`class Probe { ${method} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const actions = { ADD: "add", DELETE: "delete", REORDER: "reorder" };
  const Probe = new Function(
    "runInAction",
    "update",
    "uniq",
    "concat",
    "pull",
    "EIssueGroupedAction",
    `${compiled}; return Probe;`
  )(runInAction, lodash.update, lodash.uniq, lodash.concat, lodash.pull, actions);
  const store = new Probe();
  store.issueFilterStore = { issueFilters: { displayFilters: { sub_issue: false } } };
  store.groupedIssueIds = { all: [] };
  store.getUpdateDetails = () => [{ action: actions.ADD, path: ["all"] }];
  store.issuesSortWithOrderBy = (ids) => ids;
  store.accumulateIssueUpdates = () => {};
  store.updateIssueCount = () => {};
  store.updateIssueList({ id: "child", parent_id: "parent" });
  assert.deepEqual(store.groupedIssueIds.all, ["child"]);
});

test("display options no longer render a child-visibility switch", () => {
  const { FilterExtraOptions } = loadSource(
    "../core/components/issues/issue-layouts/filters/header/display-filters/extra-options.tsx",
    {
      "@plane/i18n": { useTranslation: () => ({ t: (key) => key }) },
      "@/components/issues/issue-layouts/filters": {
        FilterOption: ({ title }) => createElement("button", null, title),
      },
    }
  );
  const html = renderToStaticMarkup(
    createElement(FilterExtraOptions, {
      selectedExtraOptions: { sub_issue: false, show_empty_groups: true },
      enabledExtraOptions: ["sub_issue", "show_empty_groups"],
      handleUpdate: () => {},
    })
  );
  assert.ok(html.includes("show_empty_groups"));
  assert.ok(!html.includes("show_sub_issues"));
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});

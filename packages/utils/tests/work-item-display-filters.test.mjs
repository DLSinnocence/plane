/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { getComputedDisplayFilters } from "../src/work-item/display-filters.ts";
import { getListRootIssueIds } from "../../../apps/web/core/components/issues/issue-layouts/list/hierarchy.ts";

test("a fresh assigned-work-items view includes children", () => {
  for (const saved of [undefined, {}, { layout: "list" }]) {
    assert.equal(getComputedDisplayFilters(saved).sub_issue, true);
  }
});

test("legacy hidden-child preferences never hide assigned children", () => {
  for (const layout of ["list", "kanban", "spreadsheet", "calendar", "gantt_chart"]) {
    const filters = getComputedDisplayFilters({ layout, sub_issue: false, order_by: "-created_at" });
    assert.equal(filters.sub_issue, true);
    assert.equal(filters.layout, layout);
    assert.equal(filters.order_by, "-created_at");
  }
  assert.equal(getComputedDisplayFilters({}, { sub_issue: false }).sub_issue, true);
});

test("a child assigned without its parent remains a visible list root", () => {
  const issuesMap = {
    parent: { id: "parent", created_at: "2026-01-01", sub_issues_count: 1, assignee_ids: ["someone-else"] },
    child: { id: "child", parent_id: "parent", created_at: "2026-01-01", assignee_ids: ["me"] },
  };
  const filters = getComputedDisplayFilters({ sub_issue: false });
  const assigned = Object.values(issuesMap)
    .filter((issue) => issue.assignee_ids.includes("me") && (filters.sub_issue || !issue.parent_id))
    .map((issue) => issue.id);
  assert.deepEqual(assigned, ["child"]);
  assert.deepEqual(getListRootIssueIds(assigned, issuesMap), ["child"]);
});

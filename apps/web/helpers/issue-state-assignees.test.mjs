/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canConfigureStateAssignees,
  getDefaultStateAssignees,
  getIssueWorkflowFormData,
} from "./issue-state-assignees.ts";

const states = [
  { id: "planning", group: "backlog" },
  { id: "todo", group: "unstarted" },
  { id: "development", group: "started" },
  { id: "acceptance", group: "started" },
  { id: "done", group: "completed" },
  { id: "cancelled", group: "cancelled" },
];

test("every stage is explicitly assigned to the creator on creation", () => {
  const result = getDefaultStateAssignees(states, "creator");
  assert.deepEqual(
    Object.keys(result),
    states.map((state) => state.id)
  );
  for (const state of states) assert.deepEqual(result[state.id], ["creator"]);
  result.todo.push("other");
  assert.deepEqual(result.development, ["creator"]);
});

test("working stages keep independent selections and explicit unassigned values", () => {
  const selected = { development: ["developer"], acceptance: ["reviewer", "qa"], todo: [] };
  const result = getDefaultStateAssignees(states, "creator", selected);
  assert.deepEqual(result.development, ["developer"]);
  assert.deepEqual(result.acceptance, ["reviewer", "qa"]);
  assert.deepEqual(result.todo, []);
  assert.deepEqual(result.planning, ["creator"]);
  result.acceptance.push("new");
  assert.deepEqual(selected.acceptance, ["reviewer", "qa"]);
});

test("planning and terminal stages are hidden from configuration and stay with creator", () => {
  assert.deepEqual(
    states.filter(canConfigureStateAssignees).map((state) => state.id),
    ["todo", "development", "acceptance"]
  );
  const result = getDefaultStateAssignees(states, "creator", {
    planning: ["other"],
    done: [],
    cancelled: ["other"],
  });
  for (const key of ["planning", "done", "cancelled"]) assert.deepEqual(result[key], ["creator"]);
});

test("changing projects drops foreign stages and defaults the new stages to creator", () => {
  const result = getDefaultStateAssignees([{ id: "new-todo", group: "unstarted" }], "creator", {
    development: ["developer"],
    acceptance: ["reviewer"],
  });
  assert.deepEqual(result, { "new-todo": ["creator"] });
});

test("form submission ignores hidden assignees from templates, grouping and old drafts", () => {
  const data = {
    name: "Verify the release",
    state_id: "acceptance",
    assignee_ids: ["old-owner"],
    state_assignees: { acceptance: ["reviewer"] },
  };
  const result = getIssueWorkflowFormData(data, states, "creator");
  assert.equal(Object.hasOwn(result, "assignee_ids"), false);
  assert.equal(result.state_id, "acceptance");
  assert.deepEqual(result.state_assignees.acceptance, ["reviewer"]);
  assert.deepEqual(result.state_assignees.development, ["creator"]);
  assert.deepEqual(data.assignee_ids, ["old-owner"]);
});

test("new create-more form defaults to its creator independently of the previous form", () => {
  getIssueWorkflowFormData({ state_assignees: { development: ["developer"] } }, states, "creator");
  const result = getIssueWorkflowFormData({}, states, "creator");
  assert.deepEqual(result.state_assignees.development, ["creator"]);
});

test("missing creator never falls back to a current assignee", () => {
  const result = getIssueWorkflowFormData({ assignee_ids: ["old-owner"] }, states, undefined);
  for (const state of states) assert.deepEqual(result.state_assignees[state.id], []);
});

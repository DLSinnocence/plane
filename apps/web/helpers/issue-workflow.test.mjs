/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EUserPermissions } from "@plane/constants";
import { getIssueWorkflowPermissions } from "./issue-workflow.ts";

const allowed = { canTransition: true, canManageAssignments: true };
const denied = { canTransition: false, canManageAssignments: false };
const assignmentsOnly = { canTransition: false, canManageAssignments: true };
const transitionOnly = { canTransition: true, canManageAssignments: false };
const issue = {
  state_id: "todo",
  state_assignees: { todo: ["current"], doing: ["next"] },
  assignee_ids: ["current"],
  created_by: "creator",
};
const permissions = (userId, overrides = {}) =>
  getIssueWorkflowPermissions({ issue, userId, role: EUserPermissions.MEMBER, leadId: "lead", ...overrides });

test("current state assignees can transition but cannot configure assignments", () => {
  assert.deepEqual(permissions("current"), transitionOnly);
  assert.deepEqual(permissions("next"), denied);
  const transitioned = { ...issue, state_id: "doing", assignee_ids: ["next"] };
  assert.deepEqual(permissions("current", { issue: transitioned }), denied);
  assert.deepEqual(permissions("next", { issue: transitioned }), transitionOnly);
});

test("the owner can configure an already assigned issue without gaining transition permission", () => {
  assert.deepEqual(permissions("creator"), assignmentsOnly);
  assert.deepEqual(permissions("creator", { issue: { ...issue, state_assignees: { todo: ["creator"] } } }), allowed);
});

test("an explicit empty current assignment overrides stale flat assignees", () => {
  const unassigned = { ...issue, state_assignees: { todo: [], doing: ["next"] } };
  assert.deepEqual(permissions("current", { issue: unassigned }), denied);
  assert.deepEqual(permissions("next", { issue: unassigned }), denied);
  assert.deepEqual(permissions("creator", { issue: unassigned }), assignmentsOnly);
  assert.deepEqual(permissions("creator", { issue: { ...unassigned, assignee_ids: [] } }), assignmentsOnly);
});

test("an omitted current state entry defaults to the creator, never flat assignees", () => {
  for (const state_assignees of [undefined, {}, { doing: ["next"] }]) {
    assert.deepEqual(permissions("current", { issue: { ...issue, state_assignees } }), denied);
    assert.deepEqual(permissions("creator", { issue: { ...issue, state_assignees } }), allowed);
  }
});

test("admins can configure and transition while member project leads can only transition", () => {
  assert.deepEqual(permissions("admin", { role: EUserPermissions.ADMIN }), allowed);
  assert.deepEqual(permissions("lead"), transitionOnly);
  assert.deepEqual(permissions("lead", { issue: { ...issue, created_by: "lead" } }), allowed);
  assert.deepEqual(permissions("lead", { role: EUserPermissions.ADMIN }), allowed);
  assert.deepEqual(permissions("other"), denied);
});

test("guests and users without project membership cannot act even when assigned, owner, or lead", () => {
  for (const role of [EUserPermissions.GUEST, undefined]) {
    for (const userId of ["current", "creator", "lead"]) {
      assert.deepEqual(permissions(userId, { role }), denied);
      assert.deepEqual(permissions(userId, { role, issue: { ...issue, state_assignees: { todo: [] } } }), denied);
    }
  }
});

test("the unassigned owner can configure assignments but cannot transition", () => {
  const unassigned = { ...issue, assignee_ids: [], state_assignees: { todo: [] } };
  assert.deepEqual(permissions("creator", { issue: unassigned }), assignmentsOnly);
  assert.deepEqual(permissions("other", { issue: unassigned }), denied);
  assert.deepEqual(permissions("lead", { issue: unassigned }), transitionOnly);
});

test("fixed stages belong to the creator even if an older configuration says otherwise", () => {
  for (const stateGroup of ["backlog", "completed", "cancelled"]) {
    assert.deepEqual(permissions("current", { stateGroup }), denied);
    assert.deepEqual(permissions("creator", { stateGroup }), allowed);
  }
});

test("missing issue or unidentified member never gains permissions", () => {
  assert.deepEqual(permissions("admin", { issue: undefined, role: EUserPermissions.ADMIN }), denied);
  assert.deepEqual(permissions(undefined), denied);
  assert.deepEqual(permissions(undefined, { role: EUserPermissions.ADMIN }), denied);
});

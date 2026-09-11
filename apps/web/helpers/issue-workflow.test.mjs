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
const bootstrapOnly = { canTransition: false, canManageAssignments: true };
const issue = {
  state_id: "todo",
  state_assignees: { todo: ["current"], doing: ["next"] },
  assignee_ids: ["current"],
  created_by: "creator",
};
const permissions = (userId, overrides = {}) =>
  getIssueWorkflowPermissions({ issue, userId, role: EUserPermissions.MEMBER, leadId: "lead", ...overrides });

test("only the current state owner gains responsibility; the next owner waits for transition", () => {
  assert.deepEqual(permissions("current"), allowed);
  assert.deepEqual(permissions("next"), denied);
  const transitioned = { ...issue, state_id: "doing", assignee_ids: ["next"] };
  assert.deepEqual(permissions("current", { issue: transitioned }), denied);
  assert.deepEqual(permissions("next", { issue: transitioned }), allowed);
});

test("an explicit empty current assignment overrides stale flat assignees", () => {
  const unassigned = { ...issue, state_assignees: { todo: [], doing: ["next"] } };
  assert.deepEqual(permissions("current", { issue: unassigned }), denied);
  assert.deepEqual(permissions("next", { issue: unassigned }), denied);
  assert.deepEqual(permissions("creator", { issue: unassigned }), denied);
  assert.deepEqual(permissions("creator", { issue: { ...unassigned, assignee_ids: [] } }), bootstrapOnly);
});

test("an omitted current state entry or map falls back to flat assignees", () => {
  for (const state_assignees of [undefined, {}, { doing: ["next"] }]) {
    assert.deepEqual(permissions("current", { issue: { ...issue, state_assignees } }), allowed);
    assert.deepEqual(permissions("creator", { issue: { ...issue, state_assignees } }), denied);
  }
});

test("admins and project leads bypass responsibility while ordinary members do not", () => {
  assert.deepEqual(permissions("admin", { role: EUserPermissions.ADMIN }), allowed);
  assert.deepEqual(permissions("lead"), allowed);
  assert.deepEqual(permissions("other"), denied);
  assert.deepEqual(permissions("creator"), denied);
});

test("guests and users without project membership cannot act even when assigned, creator, or lead", () => {
  for (const role of [EUserPermissions.GUEST, undefined]) {
    for (const userId of ["current", "creator", "lead"]) {
      assert.deepEqual(permissions(userId, { role }), denied);
      assert.deepEqual(permissions(userId, { role, issue: { ...issue, state_assignees: { todo: [] } } }), denied);
    }
  }
});

test("the unassigned creator can bootstrap assignments but cannot transition", () => {
  const unassigned = { ...issue, assignee_ids: [], state_assignees: {} };
  assert.deepEqual(permissions("creator", { issue: unassigned }), bootstrapOnly);
  assert.deepEqual(permissions("other", { issue: unassigned }), denied);
  assert.deepEqual(permissions("lead", { issue: unassigned }), allowed);
});

test("missing issue or unidentified member never gains permissions", () => {
  assert.deepEqual(permissions("admin", { issue: undefined, role: EUserPermissions.ADMIN }), denied);
  assert.deepEqual(permissions(undefined), denied);
  assert.deepEqual(permissions(undefined, { role: EUserPermissions.ADMIN }), denied);
});

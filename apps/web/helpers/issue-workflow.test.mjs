/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Exercise the real helper and role definitions without installing the web app.
const constantsUrl = new URL("../../../packages/constants/src/user.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@plane/constants") return { url: constantsUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts"))
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }),
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});
const { EUserPermissions } = await import("@plane/constants");
const { getIssueWorkflowPermissions, canCreateIssue, getIntakePermissions } = await import("./issue-workflow.ts");
hooks.deregister();

const allowed = { canEdit: true, canUploadAttachments: true, canTransition: true, canManageAssignments: true };
const denied = { canEdit: false, canUploadAttachments: false, canTransition: false, canManageAssignments: false };
const assigned = { ...allowed, canManageAssignments: false };
const issue = {
  state_id: "todo",
  state_assignees: { todo: ["current"], doing: ["next"] },
  assignee_ids: ["current"],
  created_by: "creator",
};
const permissions = (userId, overrides = {}) =>
  getIssueWorkflowPermissions({
    issue,
    userId,
    role: EUserPermissions.MEMBER,
    stateGroup: "unstarted",
    ...overrides,
  });

test("only effective project administrators can create formal work items", () => {
  assert.equal(canCreateIssue(EUserPermissions.ADMIN), true);
  for (const role of [EUserPermissions.MEMBER, EUserPermissions.GUEST, undefined]) {
    assert.equal(canCreateIssue(role), false);
  }
});

test("creator OR current assignee can edit, transition and upload; next stage cannot", () => {
  assert.deepEqual(permissions("creator"), allowed);
  assert.deepEqual(permissions("current"), assigned);
  assert.deepEqual(permissions("next"), denied);
  const transitioned = { ...issue, state_id: "doing", assignee_ids: ["next"] };
  assert.deepEqual(permissions("current", { issue: transitioned }), denied);
  assert.deepEqual(permissions("next", { issue: transitioned }), assigned);
  assert.deepEqual(permissions("creator", { issue: transitioned }), allowed);
});

test("empty stage assignments override stale flat assignees while creator keeps access", () => {
  const unassigned = { ...issue, state_assignees: { todo: [], doing: ["next"] } };
  assert.deepEqual(permissions("current", { issue: unassigned }), denied);
  assert.deepEqual(permissions("creator", { issue: unassigned }), allowed);
});

test("missing stage assignments default to creator, never stale flat assignees", () => {
  for (const state_assignees of [undefined, {}, { doing: ["next"] }]) {
    assert.deepEqual(permissions("current", { issue: { ...issue, state_assignees } }), denied);
    assert.deepEqual(permissions("creator", { issue: { ...issue, state_assignees } }), allowed);
  }
});

test("project lead alone grants no rights; admin can act on others' items", () => {
  assert.deepEqual(permissions("lead", { leadId: "lead" }), denied);
  assert.deepEqual(permissions("admin", { role: EUserPermissions.ADMIN }), allowed);
});

test("guests and missing memberships cannot act even as owner or assignee", () => {
  for (const role of [EUserPermissions.GUEST, undefined]) {
    for (const userId of ["creator", "current", "lead"]) assert.deepEqual(permissions(userId, { role }), denied);
  }
});

test("fixed stages ignore old assignments", () => {
  for (const stateGroup of ["backlog", "completed", "cancelled"]) {
    assert.deepEqual(permissions("current", { stateGroup }), denied);
    assert.deepEqual(permissions("creator", { stateGroup }), allowed);
  }
});

test("missing issue, user, or stage data does not open permissions", () => {
  assert.deepEqual(permissions("admin", { issue: undefined, role: EUserPermissions.ADMIN }), denied);
  assert.deepEqual(permissions(undefined, { role: EUserPermissions.ADMIN }), denied);
  assert.deepEqual(permissions("current", { stateGroup: undefined }), denied);
  assert.deepEqual(permissions(undefined, { issue: { ...issue, created_by: undefined } }), denied);
});

test("intake allows member submission and owner editing, but only admin review", () => {
  assert.deepEqual(getIntakePermissions(EUserPermissions.MEMBER, "creator", "creator"), {
    canSubmit: true,
    canEdit: true,
    canReview: false,
  });
  assert.deepEqual(getIntakePermissions(EUserPermissions.MEMBER, "other", "creator"), {
    canSubmit: true,
    canEdit: false,
    canReview: false,
  });
  assert.deepEqual(getIntakePermissions(EUserPermissions.ADMIN, "admin", "creator"), {
    canSubmit: true,
    canEdit: true,
    canReview: true,
  });
  for (const role of [undefined, EUserPermissions.GUEST])
    assert.deepEqual(getIntakePermissions(role, "creator", "creator"), {
      canSubmit: false,
      canEdit: false,
      canReview: false,
    });
  assert.deepEqual(getIntakePermissions(EUserPermissions.ADMIN), {
    canSubmit: false,
    canEdit: false,
    canReview: false,
  });
});

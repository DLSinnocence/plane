/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentToolLabelKeys,
  agentWorkItemHref,
  canSendAgentMessage,
  collectAgentWorkItems,
  updateAgentTools,
} from "./agent-chat.ts";

test("tool completion preserves safe input and collects successful references only", () => {
  const ref = {
    id: "12345678-1234-4234-8234-123456789abc",
    projectId: "87654321-1234-4234-8234-123456789abc",
    identifier: "ENG-42",
    name: "Fix login",
  };
  const base = {
    type: "tool",
    id: "one",
    name: "workitem",
    action: "create",
    status: "running",
    details: { input: "safe input" },
  };
  const tools = updateAgentTools(updateAgentTools([], base), {
    ...base,
    status: "complete",
    details: { output: "safe output", workItems: [ref] },
  });
  assert.equal(tools[0].details.input, "safe input");
  assert.deepEqual(
    collectAgentWorkItems([...tools, ...tools, { ...base, details: { workItems: [{ ...ref, id: "other" }] } }]),
    [ref]
  );
  assert.equal(agentWorkItemHref("a b", ref), `/a%20b/projects/${ref.projectId}/issues/${ref.id}/`);
});

test("tool progress updates by ID without merging separate actions", () => {
  const event = { type: "tool", id: "one", name: "workitem", action: "create", status: "running" };
  let tools = updateAgentTools([], event);
  tools = updateAgentTools(tools, { ...event, id: "two" });
  tools = updateAgentTools(tools, { ...event, status: "complete" });
  assert.equal(tools.length, 2);
  assert.equal(tools[0].status, "complete");
  assert.equal(tools[1].status, "running");
  assert.equal(updateAgentTools([], { ...event, id: undefined })[0].key, "workitem:create");
});
test("friendly labels use known translation keys and never raw tool identifiers", () => {
  assert.deepEqual(
    agentToolLabelKeys({ type: "tool", name: "workitem", action: "manage_assignee", status: "running" }),
    {
      action: "account_settings.ai.action_update",
      entity: "account_settings.ai.entity_workitem",
    }
  );
  assert.deepEqual(
    agentToolLabelKeys({ type: "tool", name: "unknown_internal_name", action: "unknown_action", status: "running" }),
    {
      action: "account_settings.ai.action_run",
      entity: "account_settings.ai.entity_workspace",
    }
  );
});
test("interrupted turns cannot send follow-ups until explicitly reset", () => {
  assert.equal(canSendAgentMessage("verify my change", false, true, true), false);
  assert.equal(canSendAgentMessage("verify my change", false, true, false), true);
  assert.equal(canSendAgentMessage("hello", true, true, false), false);
  assert.equal(canSendAgentMessage("hello", false, null, false), false);
  assert.equal(canSendAgentMessage("  ", false, true, false), false);
});

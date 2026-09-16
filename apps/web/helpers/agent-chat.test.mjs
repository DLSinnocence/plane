/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
    agentToolLabelKeys({ type: "tool", name: "workitem_metadata", action: "update", status: "running" }),
    { action: "account_settings.ai.action_update", entity: "account_settings.ai.entity_workitem" }
  );
  assert.deepEqual(
    agentToolLabelKeys({ type: "tool", name: "unknown_internal_name", action: "unknown_action", status: "running" }),
    {
      action: "account_settings.ai.action_run",
      entity: "account_settings.ai.entity_workspace",
    }
  );
});
test("skill loading uses localized labels for every status and locale", () => {
  const locales = new URL("../../../packages/i18n/src/locales/", import.meta.url);
  for (const status of ["running", "complete", "error"]) {
    const keys = agentToolLabelKeys({ type: "tool", name: "skill", action: "load", status });
    assert.deepEqual(keys, {
      action: "account_settings.ai.action_load",
      entity: "account_settings.ai.entity_skill",
    });
    for (const locale of readdirSync(locales, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const settings = JSON.parse(readFileSync(new URL(`${locale.name}/settings.json`, locales), "utf8"));
      const labels = [keys.action, keys.entity].map((key) =>
        key.split(".").reduce((value, segment) => value?.[segment], settings)
      );
      for (const label of labels) assert.ok(typeof label === "string" && label.trim(), `${locale.name}: ${status}`);
      if (locale.name === "zh-CN") assert.deepEqual(labels, ["加载", "写作规范"]);
      if (locale.name === "en") assert.deepEqual(labels, ["Load", "Writing guidelines"]);
    }
  }
});

test("skill completion and failure update separate records without producing work item links", () => {
  const loading = { type: "tool", id: "skill-1", name: "skill", action: "load", status: "running" };
  let tools = updateAgentTools([], loading);
  tools = updateAgentTools(tools, { ...loading, id: "skill-2" });
  tools = updateAgentTools(tools, {
    ...loading,
    status: "complete",
    details: { input: "writing-plane-requirements", output: "Loaded writing-plane-requirements." },
  });
  tools = updateAgentTools(tools, {
    ...loading,
    id: "skill-2",
    status: "error",
    details: { output: "Skill unavailable." },
  });
  assert.equal(tools.length, 2);
  assert.deepEqual(
    tools.map((tool) => tool.status),
    ["complete", "error"]
  );
  assert.deepEqual(tools[0].details, {
    input: "writing-plane-requirements",
    output: "Loaded writing-plane-requirements.",
  });
  assert.deepEqual(tools[1].details, { output: "Skill unavailable." });
  assert.deepEqual(collectAgentWorkItems(tools), []);
});

test("composer permits follow-ups when configured and idle", () => {
  assert.equal(canSendAgentMessage("verify my change", false, true), true);
  assert.equal(canSendAgentMessage("hello", true, true), false);
  assert.equal(canSendAgentMessage("hello", false, null), false);
  assert.equal(canSendAgentMessage("  ", false, true), false);
});

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { clone, concat, pull, uniq } from "lodash-es";

const webRoot = new URL("../../../", import.meta.url);
const parse = (path) =>
  ts.createSourceFile(path, readFileSync(new URL(path, webRoot), "utf8"), ts.ScriptTarget.Latest, true);
const collect = (source, predicate) => {
  const matches = [];
  const visit = (node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matches;
};
const evaluate = (expression, dependencies = {}) => {
  const compiled = ts.transpileModule(`const result = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${compiled}; return result;`)(...Object.values(dependencies));
};

for (const path of [
  "core/components/issues/issue-detail/sidebar.tsx",
  "core/components/issues/peek-overview/properties.tsx",
  "core/components/issues/issue-layouts/properties/all-properties.tsx",
  "core/components/issues/issue-layouts/spreadsheet/columns/assignee-column.tsx",
  "core/components/issues/issue-detail-widgets/sub-issues/issues-list/properties.tsx",
  "core/components/issues/relations/properties.tsx",
  "core/components/issues/workspace-draft/draft-issue-properties.tsx",
  "core/components/inbox/content/issue-properties.tsx",
]) {
  test(`${path}: current assignees remain visible without a mutation callback`, () => {
    const source = parse(path);
    const controls = collect(
      source,
      (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "MemberDropdown"
    );
    assert.equal(controls.length, 1);
    const attributes = controls[0].attributes.properties;
    const attribute = (name) => attributes.find((node) => ts.isJsxAttribute(node) && node.name.text === name);
    assert.ok(attribute("value").initializer.expression.getText(source).includes("assignee_ids"));
    assert.ok(attribute("disabled"));
    assert.equal(attribute("disabled").initializer, undefined, "disabled must be unconditional for every role");
    const onChange = attribute("onChange").initializer.expression;
    const writes = [];
    const callback = evaluate(onChange.getText(source), {
      issueOperations: { update: (...args) => writes.push(args) },
      updateIssue: (...args) => writes.push(args),
      updateSubIssue: (...args) => writes.push(args),
      onChange: (...args) => writes.push(args),
    });
    callback(["new-owner"]);
    callback([]);
    assert.deepEqual(writes, []);
  });
}

test("Power K offers no direct assignment command or assignment page", () => {
  const commands = parse("core/components/power-k/ui/pages/context-based/work-item/commands.ts");
  const ids = new Set(
    collect(commands, (node) => ts.isPropertyAssignment(node) && node.name.getText(commands) === "id").map(
      (node) => node.initializer.text
    )
  );
  assert.ok(ids.has("change_work_item_state"), "other work item commands remain available");
  assert.ok(!ids.has("change_work_item_assignees"));
  assert.ok(!ids.has("assign_work_item_to_me"));
  const pages = parse("core/components/power-k/ui/pages/context-based/work-item/root.tsx");
  assert.equal(
    collect(pages, (node) => ts.isStringLiteral(node) && node.text === "update-work-item-assignee").length,
    0
  );
});

for (const layout of ["list", "kanban"]) {
  test(`${layout}: assignee groups and swimlanes disable drag handles regardless of transition permission`, () => {
    const source = parse(`core/components/issues/issue-layouts/${layout}/block.tsx`);
    const permission = collect(
      source,
      (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "canDragWorkflow"
    )[0];
    for (const canTransition of [true, false]) {
      for (const groups of [["assignees"], ["state", "assignees"]]) {
        assert.equal(
          evaluate(permission.initializer.getText(source), {
            groupings: new Set(groups),
            canTransition,
          }),
          false
        );
      }
    }
    assert.equal(
      evaluate(permission.initializer.getText(source), {
        groupings: new Set(["priority"]),
        canTransition: false,
      }),
      true
    );
  });
}

const dragSource = parse("core/components/issues/issue-layouts/utils.tsx");
const declaration = (name) =>
  collect(dragSource, (node) => ts.isVariableDeclaration(node) && node.name.getText(dragSource) === name)[0];
const dragDependencies = {
  clone,
  concat,
  pull,
  uniq,
  ISSUE_FILTER_DEFAULT_DATA: { assignees: "assignee_ids", priority: "priority", state: "state_id" },
};
for (const name of ["handleSortOrder", "getGroupId"]) {
  dragDependencies[name] = evaluate(declaration(name).initializer.getText(dragSource));
}
const handleGroupDragDrop = evaluate(
  declaration("handleGroupDragDrop").initializer.getText(dragSource),
  dragDependencies
);

for (const [groupBy, subGroupBy] of [
  ["assignees", undefined],
  ["state", "assignees"],
]) {
  test(`dragging ${groupBy}/${subGroupBy} cannot change current assignees, including None`, async () => {
    await Promise.all(
      ["other-owner", "None"].map(async (destinationId) => {
        const updates = [];
        await handleGroupDragDrop(
          { id: "issue", groupId: "owner", subGroupId: "owner" },
          { groupId: destinationId, subGroupId: destinationId },
          () => ({ id: "issue", project_id: "project", assignee_ids: ["owner"] }),
          () => [],
          (...args) => updates.push(args),
          groupBy,
          subGroupBy
        );
        assert.deepEqual(updates, []);
      })
    );
  });
}

test("dragging by priority still updates that property without sending assignees", async () => {
  const updates = [];
  await handleGroupDragDrop(
    { id: "issue", groupId: "low" },
    { groupId: "high" },
    () => ({ id: "issue", project_id: "project", priority: "low", assignee_ids: ["owner"] }),
    () => [],
    (...args) => updates.push(args),
    "priority",
    undefined
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0][2].priority, "high");
  assert.ok(!Object.hasOwn(updates[0][2], "assignee_ids"));
});

const bulkSource = parse("core/store/issue/helpers/base-issues.store.ts");
const bulkProperty = collect(
  bulkSource,
  (node) => ts.isPropertyDeclaration(node) && node.name.getText(bulkSource) === "bulkUpdateProperties"
)[0];
const makeBulkUpdate = evaluate(`function () { return ${bulkProperty.initializer.getText(bulkSource)}; }`, {
  clone,
  uniq,
  runInAction: (callback) => callback(),
});

test("bulk updates reject assignment and clearing before any request or optimistic update", async () => {
  const requests = [];
  const store = { issueService: { bulkOperations: (...args) => requests.push(args) } };
  const update = makeBulkUpdate.call(store);
  await Promise.all(
    [["new-owner"], []].map((assignee_ids) =>
      assert.rejects(
        update("workspace", "project", {
          issue_ids: ["issue"],
          properties: { assignee_ids, priority: "high" },
        }),
        /stage configuration and workflow transitions/
      )
    )
  );
  assert.deepEqual(requests, []);
});

test("bulk updates retain ordinary editable properties", async () => {
  const issue = { id: "issue", priority: "low", assignee_ids: ["owner"] };
  const requests = [];
  const store = {
    issueService: { bulkOperations: (...args) => requests.push(args) },
    rootIssueStore: {
      issues: {
        getIssueById: () => issue,
        updateIssue: (_id, data) => Object.assign(issue, data),
      },
    },
    updateIssueList: () => {},
  };
  await makeBulkUpdate.call(store)("workspace", "project", {
    issue_ids: ["issue"],
    properties: { priority: "high" },
  });
  assert.equal(requests.length, 1);
  assert.equal(issue.priority, "high");
  assert.deepEqual(issue.assignee_ids, ["owner"]);
});

for (const layout of ["list", "kanban"]) {
  test(`${layout}: quick creation ignores owner groups and preserves other presets`, () => {
    const source = parse(`core/components/issues/issue-layouts/${layout}/${layout}-group.tsx`);
    const preset = collect(
      source,
      (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "prePopulateQuickAddData"
    )[0];
    const populate = evaluate(preset.initializer.getText(source), {
      projectState: { projectStates: [{ id: "default-state", default: true }] },
    });
    for (const owner of ["owner", "None"]) {
      const data = layout === "list" ? populate("assignees", owner) : populate("assignees", "assignees", owner, owner);
      assert.deepEqual(data, { state_id: "default-state" });
      if (layout === "kanban") {
        assert.deepEqual(populate("state", "assignees", "started", owner), { state_id: "started" });
        assert.deepEqual(populate("assignees", "priority", owner, "high"), {
          state_id: "default-state",
          priority: "high",
        });
      }
    }
    const priorityData = layout === "list" ? populate("priority", "high") : populate("priority", undefined, "high", "");
    assert.equal(priorityData.priority, "high");
  });
}

test("group-header creation does not preselect the displayed assignee", () => {
  const assigneeColumns = declaration("getAssigneeColumns");
  const payloads = collect(
    assigneeColumns,
    (node) => ts.isPropertyAssignment(node) && node.name.getText(dragSource) === "payload"
  );
  assert.ok(payloads.length > 0);
  for (const payload of payloads) assert.deepEqual(evaluate(payload.initializer.getText(dragSource)), {});
});

test("intake creation has no single-assignee control, default, or submitted owner", () => {
  const properties = parse("core/components/inbox/modals/create-modal/issue-properties.tsx");
  assert.equal(
    collect(
      properties,
      (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(properties) === "MemberDropdown"
    ).length,
    0
  );
  const source = parse("core/components/inbox/modals/create-modal/create-root.tsx");
  const defaults = collect(
    source,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "defaultIssueData"
  )[0];
  assert.ok(
    !Object.hasOwn(
      evaluate(defaults.initializer.getText(source), { renderFormattedPayloadDate: () => "2026-01-01" }),
      "assignee_ids"
    )
  );
  const payload = collect(
    source,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "payload"
  )[0];
  for (const assignee_ids of [undefined, [], ["legacy-owner"]]) {
    const data = evaluate(payload.initializer.getText(source), {
      formData: { name: "Intake work item", assignee_ids },
    });
    assert.equal(data.name, "Intake work item");
    assert.ok(!Object.hasOwn(data, "assignee_ids"));
  }
});

const createMethod = collect(
  bulkSource,
  (node) => ts.isMethodDeclaration(node) && node.name.getText(bulkSource) === "createIssue"
)[0];
const CreationStore = evaluate(`class { ${createMethod.getText(bulkSource)} }`);
for (const assignee_ids of [[], ["legacy-owner"]]) {
  test(`creation strips optimistic or legacy assignees ${JSON.stringify(assignee_ids)} and retains stage configuration`, async () => {
    const data = { name: "Quick work item", assignee_ids, state_assignees: { started: ["stage-owner"] } };
    const requests = [];
    const response = { id: "created", ...data, assignee_ids: ["creator"] };
    const added = [];
    const store = new CreationStore();
    store.issueService = {
      createIssue: async (...args) => {
        requests.push(args);
        return response;
      },
    };
    store.addIssue = (issue) => added.push(issue);
    store.fetchParentStats = async () => {};
    assert.equal(await store.createIssue("workspace", "project", data), response);
    assert.deepEqual(requests[0], ["workspace", "project", { name: data.name, state_assignees: data.state_assignees }]);
    assert.equal(data.assignee_ids, assignee_ids, "the optimistic issue is not mutated");
    assert.deepEqual(added[0].assignee_ids, ["creator"], "the API's derived assignment is displayed");
  });
}

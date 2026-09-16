/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { getIssueUpdateErrorKey } from "./issue-update-error.ts";

const policyError = {
  error: "Finish or cancel all sub-work items before completing this work item.",
  code: "unfinished_sub_issues",
};
const policyMessage = "仍有未完成的子工作项，请先完成或取消所有子工作项。";
const workflowLocale = JSON.parse(
  readFileSync(new URL("../../../packages/i18n/src/locales/zh-CN/workflow.json", import.meta.url), "utf8")
);
const t = (key) =>
  key === "workflows.errors.unfinished_sub_issues" ? workflowLocale.workflows.errors.unfinished_sub_issues : key;

// Execute production callback bodies at their UI boundary without requiring the
// application router or stores. The rejected update simulates the API's 400 body.
function callback(path, name, bindings, kind = "variable") {
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let initializer;
  const visit = (node) => {
    const matches = kind === "variable" ? ts.isVariableDeclaration(node) : ts.isPropertyAssignment(node);
    if (matches && node.name.getText(source) === name) initializer = node.initializer.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(initializer, `${name} must be present in ${path}`);
  const compiled = ts.transpileModule(`const callback = ${initializer};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(bindings), `${compiled}; return callback;`)(...Object.values(bindings));
}

function dropdown(onChange, toasts = []) {
  let closed = false;
  const change = callback("../core/components/dropdowns/state/base.tsx", "dropdownOnChange", {
    onChange,
    handleClose: () => {
      closed = true;
    },
    t,
    getIssueUpdateErrorKey,
    setToast: (toast) => toasts.push(toast),
    TOAST_TYPE: { ERROR: "error" },
  });
  return {
    change,
    toasts,
    get closed() {
      return closed;
    },
  };
}

test("the completion error key resolves to real English and Chinese locale messages", () => {
  const key = getIssueUpdateErrorKey(policyError);
  assert.equal(key, "workflows.errors.unfinished_sub_issues");
  for (const locale of ["en", "zh-CN"]) {
    const messages = JSON.parse(
      readFileSync(new URL(`../../../packages/i18n/src/locales/${locale}/workflow.json`, import.meta.url), "utf8")
    );
    const message = key.split(".").reduce((value, part) => value?.[part], messages);
    assert.equal(typeof message, "string", `${locale} must define ${key}`);
    assert.ok(message.trim().length > 0, `${locale} must provide a nonempty message`);
    assert.notEqual(message, key);
  }
  assert.equal(t(key), policyMessage);
});

test("a rejected state update stays open and shows the localized completion rule once", async () => {
  let reject;
  const pending = new Promise((_resolve, fail) => {
    reject = fail;
  });
  // Keep the pre-fix fire-and-forget callback from creating an unhandled rejection.
  // The assertions still fail if the UI callback does not await and handle it.
  void pending.catch(() => {});
  const view = dropdown(() => pending);
  const changing = view.change("done");
  reject(policyError);
  await changing;
  assert.equal(view.closed, false);
  assert.deepEqual(
    view.toasts.map(({ type, message }) => ({ type, message })),
    [{ type: "error", message: policyMessage }]
  );
});

test("a successful state update closes only after the update settles", async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const view = dropdown(() => pending);
  const changing = view.change("done");
  assert.equal(view.closed, false);
  resolve();
  await changing;
  assert.equal(view.closed, true);
  assert.deepEqual(view.toasts, []);
});

for (const [label, path, property] of [
  ["details", "../core/components/issues/issue-detail/root.tsx", "update"],
  ["peek", "../core/components/issues/peek-overview/root.tsx", "update"],
  ["relations", "../core/components/issues/issue-detail-widgets/relations/helper.tsx", "update"],
  ["sub-items", "../core/components/issues/issue-detail-widgets/sub-issues/helper.ts", "updateSubIssue"],
]) {
  test(`${label} passes a state rejection to the dropdown without a duplicate or success toast`, async () => {
    const toasts = [];
    const loading = new Set();
    const updateIssue = async () => {
      throw policyError;
    };
    const operation = callback(
      path,
      property,
      {
        updateIssue,
        updateSubIssue: updateIssue,
        issues: { updateIssue },
        fetchActivities: () => assert.fail("a rejected mutation must not refresh success activity"),
        setSubIssueHelpers: (_parent, _key, id) => (loading.has(id) ? loading.delete(id) : loading.add(id)),
        entityName: "Work item",
        t,
        setToast: (toast) => toasts.push(toast),
        TOAST_TYPE: { ERROR: "error", SUCCESS: "success" },
      },
      "property"
    );
    const call = (state) =>
      label === "sub-items"
        ? operation("workspace", "project", "parent", "issue", { state_id: state })
        : operation("workspace", "project", "issue", { state_id: state });
    const view = dropdown(call, toasts);
    await view.change("done");
    assert.equal(view.closed, false);
    assert.deepEqual(
      toasts.map(({ type, message }) => ({ type, message })),
      [{ type: "error", message: policyMessage }]
    );
    assert.equal(loading.size, 0);
  });
}

test("other state errors retain the generic failure message and do not close the dropdown", async () => {
  const view = dropdown(async () => {
    throw { error: "network unavailable" };
  });
  await view.change("done");
  assert.equal(view.closed, false);
  assert.deepEqual(
    view.toasts.map(({ message }) => message),
    ["entity.update.failed"]
  );
});

test("dragging to completed waits for the rejected mutation and shows the rule exactly once", async () => {
  const toasts = [];
  let reject;
  const pending = new Promise((_resolve, fail) => {
    reject = fail;
  });
  const shared = {
    setToast: (toast) => toasts.push(toast),
    TOAST_TYPE: { ERROR: "error" },
    t,
    getIssueUpdateErrorKey,
  };
  const updateIssueOnDrop = callback("../core/hooks/use-group-dragndrop.ts", "updateIssueOnDrop", {
    ...shared,
    workspaceSlug: "workspace",
    ISSUE_FILTER_DEFAULT_DATA: { module: "module_ids", cycle: "cycle_id" },
    updateIssue: () => pending,
  });
  const handleOnDrop = callback("../core/hooks/use-group-dragndrop.ts", "handleOnDrop", {
    ...shared,
    updateIssueOnDrop,
    groupBy: "state",
    subGroupBy: undefined,
    orderBy: "sort_order",
    getIssueById: () => {},
    getIssueIds: () => [],
    handleGroupDragDrop: async (_source, _destination, _issue, _ids, update) =>
      update("project", "parent", { state_id: "done" }, {}),
  });
  let settled = false;
  const moving = handleOnDrop({ id: "parent", groupId: "doing" }, { groupId: "done" }).then(() => {
    settled = true;
    return true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  reject(policyError);
  await moving;
  assert.deepEqual(
    toasts.map(({ type, message }) => ({ type, message })),
    [{ type: "error", message: policyMessage }]
  );
});

test("the edit modal reports completion rejection without closing or running success actions", async () => {
  const toasts = [];
  const fail = () => assert.fail("success action must not run after a rejected mutation");
  const update = callback("../core/components/issues/issue-modal/base.tsx", "handleUpdateIssue", {
    workspaceSlug: "workspace",
    data: { id: "parent", project_id: "project" },
    isDraft: false,
    getIssuePermissions: () => ({ canEdit: true }),
    getIssueById: () => ({ id: "parent" }),
    updateIssue: async () => {
      throw policyError;
    },
    handleCycleChange: fail,
    handleModuleChange: fail,
    handleCreateUpdatePropertyValues: fail,
    handleClose: fail,
    console: { error: () => {} },
    setToast: (toast) => toasts.push(toast),
    TOAST_TYPE: { ERROR: "error", SUCCESS: "success" },
    t,
    getIssueUpdateErrorKey,
  });
  await update({ project_id: "project", state_id: "done" });
  assert.deepEqual(
    toasts.map(({ type, message }) => ({ type, message })),
    [{ type: "error", message: policyMessage }]
  );
});

test("keyboard state changes report the same localized rule", async () => {
  const toasts = [];
  const update = callback(
    "../core/components/power-k/ui/pages/context-based/work-item/commands.ts",
    "handleUpdateEntity",
    {
      useCallback: (fn) => fn,
      workspaceSlug: "workspace",
      entityDetails: { id: "parent", project_id: "project" },
      isEpic: false,
      updateEntity: async () => {
        throw policyError;
      },
      setToast: (toast) => toasts.push(toast),
      TOAST_TYPE: { ERROR: "error" },
      t,
      getIssueUpdateErrorKey,
    }
  );
  await update({ state_id: "done" });
  assert.deepEqual(
    toasts.map(({ type, message }) => ({ type, message })),
    [{ type: "error", message: policyMessage }]
  );
});

test("the production issue store restores the original state before the dropdown reports rejection", async () => {
  const source = ts.createSourceFile(
    "base-issues.store.ts",
    readFileSync(new URL("../core/store/issue/helpers/base-issues.store.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const storeClass = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name.text === "BaseIssuesStore"
  );
  const method = storeClass.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === "issueUpdate"
  );
  const compiled = ts.transpileModule(`class Store { ${method.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const update = new Function("clone", "runInAction", `${compiled}; return Store.prototype.issueUpdate;`)(
    (value) => ({ ...value }),
    (action) => action()
  );
  const issue = { id: "parent", project_id: "project", state_id: "doing", assignee_ids: ["alice"] };
  const store = {
    assertCanEditIssue: () => {},
    rootIssueStore: {
      issues: {
        getIssueById: () => issue,
        updateIssue: (_id, changes) => Object.assign(issue, changes),
      },
    },
    issueService: {
      patchIssue: async () => {
        assert.equal(issue.state_id, "done");
        throw policyError;
      },
    },
    updateIssueList: () => {},
    updateParentStats: () => {},
    fetchParentStats: () => assert.fail("success stats must not run after rejection"),
  };
  const view = dropdown((state) => update.call(store, "workspace", "project", "parent", { state_id: state }));
  await view.change("done");
  assert.equal(issue.state_id, "doing");
  assert.deepEqual(issue.assignee_ids, ["alice"]);
  assert.equal(view.closed, false);
  assert.deepEqual(
    view.toasts.map(({ message }) => message),
    [policyMessage]
  );
});

test("the error parser only recognizes the explicit public code field", () => {
  assert.equal(getIssueUpdateErrorKey(policyError), "workflows.errors.unfinished_sub_issues");
  for (const error of [
    undefined,
    null,
    1,
    "unfinished_sub_issues",
    {},
    { code: "other" },
    { error: policyError.error },
  ]) {
    assert.equal(getIssueUpdateErrorKey(error), undefined);
  }
});

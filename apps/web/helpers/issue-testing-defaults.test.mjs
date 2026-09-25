/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { isStateAvailableForIssue } from "./issue-testing-state.ts";
import { canConfigureStateAssignees } from "./issue-state-assignees.ts";

const root = new URL("../../../", import.meta.url);
const parse = (path) =>
  ts.createSourceFile(path, readFileSync(new URL(path, root), "utf8"), ts.ScriptTarget.Latest, true);
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
const variable = (source, name) =>
  collect(source, (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name)[0];

const constants = parse("packages/constants/src/issue/modal.ts");
const defaults = evaluate(variable(constants, "DEFAULT_WORK_ITEM_FORM_VALUES").initializer.getText(constants));

test("new work item forms default to No", () => {
  assert.equal(defaults.needs_testing, false);
});

test("project reset defaults to No and preserves explicit testing preferences", () => {
  const source = parse("packages/utils/src/work-item/modal.ts");
  const reset = evaluate(variable(source, "getUpdateFormDataForReset").initializer.getText(source), {
    DEFAULT_WORK_ITEM_FORM_VALUES: defaults,
  });
  for (const value of [undefined, false, true]) {
    const input = value === undefined ? {} : { needs_testing: value };
    assert.equal(reset("new-project", input).needs_testing, value ?? false);
    assert.deepEqual(input, value === undefined ? {} : { needs_testing: value });
  }
});

test("the testing selector displays No for missing values and Yes for explicit true", () => {
  const source = parse("apps/web/core/components/issues/needs-testing-select.tsx");
  const valueExpression = collect(
    source,
    (node) => ts.isJsxAttribute(node) && node.name.text === "value" && ts.isJsxExpression(node.initializer)
  )[0].initializer.expression.getText(source);
  for (const value of [undefined, false, true]) {
    assert.equal(evaluate(valueExpression, { value }), value === true ? "yes" : "no");
  }
});

test("state choices and stage owner fields consistently hide testing unless explicitly enabled", () => {
  const states = [
    { id: "todo", group: "unstarted" },
    { id: "testing", group: "started", is_testing: true },
    { id: "done", group: "completed" },
  ];
  const dropdown = parse("apps/web/core/components/dropdowns/state/base.tsx");
  const binding = collect(
    dropdown,
    (node) => ts.isBindingElement(node) && node.name.getText(dropdown) === "needsTesting"
  )[0];
  const fallback = evaluate(binding.initializer.getText(dropdown));
  const fields = parse("apps/web/core/components/issues/state-assignee-fields.tsx");
  const filter = collect(
    fields,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "filter"
  )[0].arguments[0].getText(fields);
  for (const needsTesting of [undefined, false, true]) {
    const visibleStates = states.filter((state) => isStateAvailableForIssue(state, needsTesting ?? fallback));
    const visibleFields = states.filter(evaluate(filter, {
      props: { needsTesting },
      canConfigureStateAssignees,
      isStateAvailableForIssue,
    }));
    assert.equal(visibleStates.some((state) => state.id === "testing"), needsTesting === true);
    assert.equal(visibleFields.some((state) => state.id === "testing"), needsTesting === true);
    assert.ok(visibleFields.some((state) => state.id === "todo"));
    assert.ok(!visibleFields.some((state) => state.id === "done"));
  }
});

test("issue detail hydration defaults to No without changing explicit values", () => {
  const source = parse("apps/web/core/store/issue/issue-details/issue.store.ts");
  const member = collect(
    source,
    (node) => ts.isPropertyDeclaration(node) && node.name.getText(source) === "addIssueToStore"
  )[0];
  const compiled = ts.transpileModule(`class Store { ${member.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const Store = new Function(`${compiled}; return Store;`)();
  for (const value of [undefined, false, true]) {
    const store = new Store();
    let stored;
    store.rootIssueDetailStore = {
      rootIssueStore: {
        issues: {
          addIssue: ([issue]) => {
            stored = issue;
          },
        },
      },
    };
    const input = { id: "issue", ...(value === undefined ? {} : { needs_testing: value }) };
    assert.equal(store.addIssueToStore(input).needs_testing, value ?? false);
    assert.equal(stored.needs_testing, value ?? false);
    assert.equal(input.needs_testing, value);
  }
});

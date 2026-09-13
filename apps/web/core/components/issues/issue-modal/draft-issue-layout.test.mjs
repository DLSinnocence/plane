/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = ts.createSourceFile(
  "draft-issue-layout.tsx",
  readFileSync(new URL("./draft-issue-layout.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
);
let handler;
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleCreateDraftIssue")
    handler = node.initializer;
  ts.forEachChild(node, visit);
};
visit(source);
const compiled = ts.transpileModule(`const handler = ${handler.getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const selectedProject of ["selected-project", undefined]) {
  test(`saving a draft retains stage selections in ${selectedProject ?? "the initial project"}`, async () => {
    const stageAssignees = { development: ["developer"], acceptance: ["reviewer"], done: ["creator"] };
    const writes = [];
    const properties = [];
    const dependencies = {
      changesMade: { name: "Review release", project_id: selectedProject, state_assignees: stageAssignees },
      projectId: "initial-project",
      workspaceSlug: "workspace",
      createIssue: async (...args) => {
        writes.push(args);
        return { id: "draft", type_id: "type" };
      },
      handleCreateUpdatePropertyValues: async (data) => {
        properties.push(data);
      },
      setToast: () => {},
      TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
      t: (key) => key,
      onChange: () => {},
      onClose: () => {},
      setIssueDiscardModal: () => {},
    };
    const save = new Function(...Object.keys(dependencies), `${compiled}; return handler;`)(
      ...Object.values(dependencies)
    );
    await save();
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "workspace");
    assert.equal(writes[0][1].project_id, selectedProject ?? "initial-project");
    assert.deepEqual(writes[0][1].state_assignees, stageAssignees);
    assert.equal(Object.hasOwn(writes[0][1], "assignee_ids"), false);
    assert.equal(properties[0].projectId, selectedProject ?? "initial-project");
  });
}

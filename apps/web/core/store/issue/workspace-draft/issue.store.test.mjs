/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clone, set } from "lodash-es";
import ts from "typescript";

const source = ts.createSourceFile(
  "issue.store.ts",
  readFileSync(new URL("./issue.store.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
);
let update;
const visit = (node) => {
  if (ts.isPropertyDeclaration(node) && node.name.getText(source) === "updateIssue") update = node.initializer;
  ts.forEachChild(node, visit);
};
visit(source);
const compiled = ts.transpileModule(`const factory = function () { return ${update.getText(source)}; };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const fixture = (response) => {
  const initial = { id: "draft", state_id: "todo", state_assignees: { todo: ["creator"] }, assignee_ids: ["creator"] };
  const requests = [];
  const store = {
    issuesMap: { draft: initial },
    getIssueById(id) {
      return this.issuesMap[id];
    },
    addIssue(issues) {
      for (const issue of issues) this.issuesMap[issue.id] = { ...this.issuesMap[issue.id], ...issue };
    },
  };
  const dependencies = {
    clone,
    set,
    runInAction: (callback) => callback(),
    getCurrentDateTimeInISO: () => "now",
    workspaceDraftService: {
      updateIssue: async (...args) => {
        requests.push(args);
        return response();
      },
    },
  };
  const factory = new Function(...Object.keys(dependencies), `${compiled}; return factory;`)(
    ...Object.values(dependencies)
  );
  return { store, initial, requests, update: factory.call(store) };
};

test("draft workflow saves use server owners and replace the optimistic stage map", async () => {
  const saved = {
    id: "draft",
    state_id: "doing",
    assignee_ids: ["reviewer"],
    state_assignees: { doing: ["reviewer"], done: ["creator"] },
  };
  const result = fixture(async () => saved);
  await result.update("workspace", "draft", { state_id: "doing", state_assignees: { doing: [] } });
  assert.deepEqual(result.store.issuesMap.draft.assignee_ids, ["reviewer"]);
  assert.deepEqual(result.store.issuesMap.draft.state_assignees, saved.state_assignees);
  assert.equal(Object.hasOwn(result.requests[0][2], "assignee_ids"), false);
  assert.equal(result.store.loader, undefined);
});

test("ordinary draft edits support responses without a body", async () => {
  const result = fixture(async () => undefined);
  await result.update("workspace", "draft", { name: "Renamed" });
  assert.equal(result.store.issuesMap.draft.name, "Renamed");
  assert.deepEqual(result.store.issuesMap.draft.assignee_ids, ["creator"]);
});

test("failed draft workflow saves restore owners and the saved stage selections", async () => {
  const result = fixture(async () => {
    throw new Error("Invalid stage owners");
  });
  await assert.rejects(
    result.update("workspace", "draft", { state_assignees: { todo: ["other"] } }),
    /Invalid stage owners/
  );
  assert.deepEqual(result.store.issuesMap.draft, result.initial);
  assert.equal(result.store.loader, undefined);
});

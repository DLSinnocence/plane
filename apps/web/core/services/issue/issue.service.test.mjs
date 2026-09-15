/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("./issue.service.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(get) {
  const dependencies = {
    "@plane/constants": { API_BASE_URL: "" },
    "@plane/types": { EIssueServiceType: { ISSUES: "issues", EPICS: "epics" } },
    "@/services/api.service": {
      APIService: class {
        get = get;
      },
    },
  };
  const exports = {};
  new Function("require", "exports", compiled)((name) => {
    assert.ok(dependencies[name], `Unexpected import: ${name}`);
    return dependencies[name];
  }, exports);
  return new exports.IssueService();
}

test("child requests have a finite timeout and retain their scope and query", async () => {
  const response = { sub_issues: [{ id: "child" }], state_distribution: {} };
  let request;
  const service = fixture(async (...args) => {
    request = args;
    return { data: response };
  });
  const result = await service.subIssues("workspace", "project", "parent", { order_by: "name" });
  assert.equal(result, response);
  assert.equal(request[0], "/api/workspaces/workspace/projects/project/issues/parent/sub-issues/");
  assert.deepEqual(request[1].params, { order_by: "name" });
  assert.ok(request[1].timeout > 0 && request[1].timeout <= 30000);
});

test("network and timeout failures keep an error instead of rejecting with undefined", async () => {
  await Promise.all(
    ["ERR_NETWORK", "ECONNABORTED"].map(async (code) => {
      const error = Object.assign(new Error("Unable to load children"), { code });
      const service = fixture(async () => {
        throw error;
      });
      await assert.rejects(service.subIssues("workspace", "project", "parent"), (reason) => reason === error);
    })
  );
});

test("HTTP failures retain the server's existing error payload", async () => {
  const payload = { error: "Parent is unavailable" };
  const service = fixture(async () => {
    throw { response: { status: 404, data: payload } };
  });
  await assert.rejects(service.subIssues("workspace", "project", "parent"), (reason) => reason === payload);
});

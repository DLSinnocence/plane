/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Exercise the production methods while isolating their network/store collaborators.
function subject(file, className, methodName, bindings = {}) {
  const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className);
  const member = declaration.members.find((node) => node.name?.getText(source) === methodName);
  assert.ok(member, `${className}.${methodName} exists`);
  const code = ts.transpileModule(`class Subject { ${member.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const Subject = new Function(...Object.keys(bindings), `${code}; return Subject;`)(...Object.values(bindings));
  return new Subject();
}

function service(response) {
  const instance = subject(new URL("./user.service.ts", import.meta.url), "UserService", "currentUser");
  instance.get = async (path, options) => {
    assert.equal(path, "/api/users/me/");
    assert.equal(options.validateStatus, null);
    return response;
  };
  return instance;
}

for (const status of [401, 403]) {
  test(`currentUser treats ${status} as anonymous instead of returning its error object`, async () => {
    assert.equal(
      await service({ status, data: { detail: "Authentication credentials were not provided." } }).currentUser(),
      undefined
    );
  });
}

test("currentUser rejects malformed user shapes even with a successful status", async () => {
  await Promise.all(
    [null, {}, { detail: "error" }, { id: "user-without-email" }].map(async (data) => {
      assert.equal(await service({ status: 200, data }).currentUser(), undefined);
    })
  );
});

test("currentUser returns a real user and preserves server failures", async () => {
  const user = { id: "user-id", email: "invited@example.test" };
  assert.equal(await service({ status: 200, data: user }).currentUser(), user);
  const response = { status: 500, data: { error: "temporary failure" } };
  await assert.rejects(service(response).currentUser(), (error) => error === response);
});

function store(response) {
  const instance = subject(new URL("../store/user/index.ts", import.meta.url), "UserStore", "fetchCurrentUser", {
    runInAction: (action) => action(),
  });
  instance.data = { id: "old-session", email: "old@example.test" };
  instance.isLoading = false;
  instance.isAuthenticated = true;
  instance.calls = [];
  instance.userService = { currentUser: async () => response };
  instance.userProfile = { fetchUserProfile: async () => instance.calls.push("profile") };
  instance.userSettings = { fetchCurrentUserSettings: async () => instance.calls.push("settings") };
  instance.store = { workspaceRoot: { fetchWorkspaces: async () => instance.calls.push("workspaces") } };
  return instance;
}

test("an expired session clears stale user data and never stores an authentication error payload", async () => {
  await Promise.all(
    [undefined, { detail: "Authentication credentials were not provided." }, {}].map(async (response) => {
      const instance = store(response);
      assert.equal(await instance.fetchCurrentUser(), undefined);
      assert.equal(instance.data, undefined);
      assert.equal(instance.isAuthenticated, false);
      assert.equal(instance.isLoading, false);
      assert.deepEqual(instance.calls, []);
    })
  );
});

test("a valid session still loads profile, settings and workspaces", async () => {
  const user = { id: "real-user", email: "invited@example.test" };
  const instance = store(user);
  assert.equal(await instance.fetchCurrentUser(), user);
  assert.equal(instance.data, user);
  assert.equal(instance.isAuthenticated, true);
  assert.equal(instance.isLoading, false);
  assert.deepEqual(instance.calls.toSorted(), ["profile", "settings", "workspaces"]);
});

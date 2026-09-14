/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const jsx = (type, props) => ({ type, props });
const find = (node, type) => {
  if (!node || typeof node !== "object") return undefined;
  if (node.type === type) return node;
  const children = [node.props?.children].flat(Infinity);
  return children.map((child) => find(child, type)).find(Boolean);
};

// Exercise component handlers and layout-effect cleanup without a browser renderer.
function fixture(source, exportName, attachment) {
  const hooks = [];
  const cleanups = [];
  const writes = [];
  let cursor = 0;
  let effects = [];
  let dirty = false;
  const react = {
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [
        hooks[index],
        (value) => {
          writes.push(value);
          if (hooks[index] !== value) dirty = true;
          hooks[index] = value;
        },
      ];
    },
    useLayoutEffect(effect, deps) {
      const index = cursor++;
      if (!hooks[index] || deps.some((value, offset) => value !== hooks[index][offset])) {
        hooks[index] = deps;
        effects.push(() => {
          cleanups[index]?.();
          cleanups[index] = effect();
        });
      }
    },
  };
  const modules = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "mobx-react": { observer: (component) => component },
    "lucide-react": { Plus: "plus" },
    "@plane/constants": {
      EUserPermissions: { ADMIN: "admin", MEMBER: "member" },
      EUserPermissionsLevel: { WORKSPACE: "workspace" },
    },
    "@plane/i18n": { useTranslation: () => ({ t: (key) => key }) },
    "@plane/propel/button": { Button: "button" },
    "@plane/types": { EIssueServiceType: { ISSUES: "issues" } },
    "@/hooks/store/use-issue-detail": { useIssueDetail: () => ({ attachment }) },
    "@/hooks/store/user": { useUserPermissions: () => ({ allowPermissions: () => true }) },
    "./slot-helpers": { nextEmptyAttachmentName: () => "Empty attachment 1" },
    "./template-library": { AttachmentTemplateLibrary: "library" },
  };
  const compiled = ts.transpileModule(readFileSync(new URL(source, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)((specifier) => {
    assert.ok(specifier in modules, `Unexpected import: ${specifier}`);
    return modules[specifier];
  }, exports);
  let tree;
  return {
    writes,
    render(props) {
      do {
        dirty = false;
        cursor = 0;
        effects = [];
        tree = exports[exportName](props);
        effects.forEach((effect) => effect());
      } while (dirty);
    },
    click: () => find(tree, "button").props.onClick({ stopPropagation() {} }),
    library: () => find(tree, "library"),
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()),
  };
}
const props = { workspaceSlug: "workspace", projectId: "project", issueId: "first", disabled: false };

test("leaving during initial empty-attachment fetch prevents creation and state updates", async () => {
  const pending = deferred();
  let creates = 0;
  const view = fixture("./empty-action-button.tsx", "EmptyAttachmentActionButton", {
    fetchAttachmentSlots: () => pending.promise,
    getAttachmentSlotsByIssueId: () => [],
    createAttachmentSlot: () => {
      creates += 1;
    },
  });
  view.render({ ...props, onCreated: () => assert.fail("stale callback") });
  const request = view.click();
  view.unmount();
  const writesBefore = view.writes.length;
  pending.resolve([]);
  await request;
  assert.equal(creates, 0);
  assert.equal(view.writes.length, writesBefore);
});

test("switching issues during creation ignores old callback without unlocking new request", async () => {
  const oldCreate = deferred();
  const newCreate = deferred();
  const calls = [];
  const callbacks = [];
  const view = fixture("./empty-action-button.tsx", "EmptyAttachmentActionButton", {
    fetchAttachmentSlots: async () => [],
    getAttachmentSlotsByIssueId: () => [],
    createAttachmentSlot: (_workspace, _project, id) => {
      calls.push(id);
      return id === "first" ? oldCreate.promise : newCreate.promise;
    },
  });
  const onCreated = (id) => callbacks.push(id);
  view.render({ ...props, onCreated });
  const first = view.click();
  await Promise.resolve();
  view.render({ ...props, issueId: "second", onCreated });
  const second = view.click();
  await Promise.resolve();
  oldCreate.resolve({ id: "old-slot" });
  await first;
  await view.click();
  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(callbacks, []);
  newCreate.resolve({ id: "new-slot" });
  await second;
  assert.deepEqual(callbacks, ["new-slot"]);
});

test("template fetch from a previous issue cannot open the library or unlock the current fetch", async () => {
  const firstFetch = deferred();
  const secondFetch = deferred();
  let fetches = 0;
  const view = fixture("./template-library-button.tsx", "AttachmentTemplateLibraryButton", {
    fetchAttachmentSlots: () => {
      fetches += 1;
      return fetches === 1 ? firstFetch.promise : secondFetch.promise;
    },
    getAttachmentSlotsByIssueId: () => [],
  });
  view.render(props);
  const first = view.click();
  view.render({ ...props, issueId: "second" });
  const second = view.click();
  firstFetch.resolve([]);
  await first;
  view.render({ ...props, issueId: "second" });
  assert.equal(view.library(), undefined);
  await view.click();
  assert.equal(fetches, 2);
  secondFetch.resolve([]);
  await second;
  view.render({ ...props, issueId: "second" });
  assert.ok(view.library());
});

test("a rejected template fetch after unmount does not update component state", async () => {
  const pending = deferred();
  const view = fixture("./template-library-button.tsx", "AttachmentTemplateLibraryButton", {
    fetchAttachmentSlots: () => pending.promise,
    getAttachmentSlotsByIssueId: () => [],
  });
  view.render(props);
  const request = view.click();
  view.unmount();
  const writesBefore = view.writes.length;
  pending.reject(new Error("fetch failed"));
  await request;
  assert.equal(view.writes.length, writesBefore);
});

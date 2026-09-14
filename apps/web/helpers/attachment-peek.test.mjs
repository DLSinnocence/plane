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
  "view.tsx",
  readFileSync(new URL("../core/components/issues/peek-overview/view.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
const nodes = [];
const visit = (node) => {
  nodes.push(node);
  ts.forEachChild(node, visit);
};
visit(source);
const handler = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown");
assert.ok(handler?.initializer, "production peek handler must be present");
const compiled = ts.transpileModule(`const handle = ${handler.initializer.getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

// Run the production AST with only its surrounding store/DOM inputs supplied.
function execute(overrides = {}, event = { defaultPrevented: false }) {
  let closed = 0;
  let focused = 0;
  const context = {
    isAnyModalOpen: false,
    isAnyEpicModalOpen: false,
    isAnyLocalModalOpen: false,
    editorRef: { current: { isAnyDropbarOpen: () => false } },
    issueId: "issue",
    document: {
      activeElement: { tagName: "BUTTON" },
      querySelector: () => null,
      getElementById: () => ({ focus: () => focused++ }),
    },
    removeRoutePeekId: () => closed++,
    ...overrides,
  };
  const run = new Function(...Object.keys(context), `${compiled}\nreturn handle;`)(...Object.values(context));
  run(event);
  return { closed, focused };
}

test("real peek useKeypress forwards the Escape event to the tested handler", () => {
  const hookup = nodes.find((node) => ts.isCallExpression(node) && node.expression.getText(source) === "useKeypress");
  assert.ok(hookup);
  assert.equal(hookup.arguments[0].text, "Escape");
  assert.match(hookup.arguments[1].getText(source), /\(event\)\s*=>\s*!embedIssue\s*&&\s*handleKeyDown\(event\)/);
});

test("consumed Escape and any active issue, epic, local or portal modal retain the underlying peek", () => {
  assert.deepEqual(execute({}, { defaultPrevented: true }), { closed: 0, focused: 0 });
  for (const key of ["isAnyModalOpen", "isAnyEpicModalOpen", "isAnyLocalModalOpen"])
    assert.equal(execute({ [key]: true }).closed, 0, key);
  assert.equal(
    execute({
      document: { querySelector: (selector) => (selector === '[role="dialog"][aria-modal="true"]' ? {} : null) },
    }).closed,
    0
  );
});

test("unhandled Escape closes peek and restores focus when no overlay owns it", () => {
  assert.deepEqual(execute(), { closed: 1, focused: 1 });
});

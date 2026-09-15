/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(
  readFileSync(new URL("./use-table-keyboard-navigation.tsx", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;
const exports = {};
new Function("exports", compiled)(exports);
const navigate = exports.useTableKeyboardNavigation();

// Minimal DOM fixture with separate element siblings and text-inclusive childNodes.
function element(tagName, children = [], attributes = {}) {
  const node = {
    tagName,
    children,
    childNodes: [],
    parentElement: null,
    parentNode: null,
    previousElementSibling: null,
    nextElementSibling: null,
    previousSibling: null,
    nextSibling: null,
    focused: 0,
    scrolled: 0,
    get firstElementChild() {
      return this.children[0] ?? null;
    },
    get lastElementChild() {
      return this.children.at(-1) ?? null;
    },
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    closest(selector) {
      for (let current = this; current; current = current.parentElement) {
        if (current.tagName === selector.toUpperCase()) return current;
      }
      return null;
    },
    focus() {
      this.focused++;
    },
    scrollIntoView() {
      this.scrolled++;
    },
  };
  children.forEach((child, index) => {
    child.parentElement = node;
    child.parentNode = node;
    child.previousElementSibling = children[index - 1] ?? null;
    child.nextElementSibling = children[index + 1] ?? null;
    // Whitespace should not affect vertical row or column selection.
    child.previousSibling = { nodeType: 3 };
    child.nextSibling = { nodeType: 3 };
    node.childNodes.push({ nodeType: 3 }, child);
  });
  return node;
}
const row = (tag = "TD", count = 3) =>
  element(
    "TR",
    Array.from({ length: count }, () => element(tag))
  );
const status = () => element("TR", [element("TD")], { "data-skip-keyboard-navigation": "true" });
function table(headerRows, bodyRows) {
  return element("TABLE", [element("THEAD", headerRows), element("TBODY", bodyRows)]);
}
function key(target, value) {
  const event = {
    target,
    key: value,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  navigate(event);
  return event;
}
function assertMove(source, direction, destination) {
  const previousFocus = destination.focused;
  const previousScroll = destination.scrolled;
  assert.equal(key(source, direction).prevented, true);
  assert.equal(destination.focused, previousFocus + 1);
  assert.equal(destination.scrolled, previousScroll + 1);
}

for (const column of [0, 2]) {
  test(`up/down skip consecutive status rows in column ${column}`, () => {
    const first = row();
    const last = row();
    const pending = status();
    const failed = status();
    table([row("TH")], [first, pending, failed, last]);
    assertMove(first.children[column], "ArrowDown", last.children[column]);
    assertMove(last.children[column], "ArrowUp", first.children[column]);
    assert.equal(pending.children[0].focused, 0);
    assert.equal(failed.children[0].focused, 0);
  });

  test(`header/body transitions skip boundary status rows in column ${column}`, () => {
    const header = row("TH");
    const body = row();
    table([row("TH"), header, status()], [status(), status(), body]);
    assertMove(header.children[column], "ArrowDown", body.children[column]);
    assertMove(body.children[column], "ArrowUp", header.children[column]);
  });

  test(`table edges with skipped rows do not consume arrows in column ${column}`, () => {
    const header = row("TH");
    const body = row();
    table([status(), header], [body, status(), status()]);
    assert.equal(key(header.children[column], "ArrowUp").prevented, false);
    assert.equal(key(body.children[column], "ArrowDown").prevented, false);
    assert.equal(header.children[column].focused, 0);
    assert.equal(body.children[column].focused, 0);
  });
}

test("an entirely skipped body terminates at the table edge", () => {
  const header = row("TH");
  table([header], [status(), status()]);
  assert.equal(key(header.children[0], "ArrowDown").prevented, false);
});

test("ordinary header/body transitions still preserve the target column", () => {
  const header = row("TH");
  const body = row();
  table([header], [body]);
  assertMove(header.children[2], "ArrowDown", body.children[2]);
  assertMove(body.children[2], "ArrowUp", header.children[2]);
});

test("retry button keyboard events are left to the button", () => {
  const button = element("BUTTON");
  const failed = element("TR", [element("TD", [button])], { "data-skip-keyboard-navigation": "true" });
  const first = row();
  const last = row();
  table([row("TH")], [first, failed, last]);
  for (const value of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Space", "Tab"]) {
    assert.equal(key(button, value).prevented, false);
  }
  assert.equal(button.focused, 0);
  assert.equal(button.scrolled, 0);
  assert.equal(first.children[0].focused, 0);
  assert.equal(last.children[0].focused, 0);
});

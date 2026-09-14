/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fillMissingKeys } from "../scripts/lib/fill-missing.ts";

test("missing translations use source text while existing translations remain intact", () => {
  const source = { attachment: { title: "Attachments", limit: "Maximum {size} MB", slots: { add: "Add slot" } } };
  const translated = { attachment: { title: "附件", existing: "保留", limit: "" }, extra: "unchanged" };
  const originalSource = structuredClone(source);
  assert.equal(fillMissingKeys(source, translated), 1);
  assert.deepEqual(translated, {
    attachment: { title: "附件", existing: "保留", limit: "", slots: { add: "Add slot" } },
    extra: "unchanged",
  });
  assert.deepEqual(source, originalSource);
});

test("sync is idempotent and preserves ICU variables and plural messages exactly", () => {
  const source = { count: "{count, plural, one {# file for {name}} other {# files for {name}}}", list: ["one", "two"] };
  const translated = {};
  assert.equal(fillMissingKeys(source, translated), 2);
  assert.deepEqual(translated, source);
  assert.equal(fillMissingKeys(source, translated), 0);
  assert.notEqual(translated.list, source.list);
});

test("a source branch cannot overwrite a translated leaf or vice versa", () => {
  assert.throws(() => fillMissingKeys({ title: { short: "Title" } }, { title: "已翻译" }), /path conflict at title/);
  assert.throws(() => fillMissingKeys({ title: "Title" }, { title: { short: "已翻译" } }), /path conflict at title/);
});

test("translation keys are treated as own data properties", () => {
  const source = JSON.parse('{"__proto__":{"name":"safe"},"constructor":"translated"}');
  const translated = {};
  assert.equal(fillMissingKeys(source, translated), 2);
  assert.equal(Object.getPrototypeOf(translated), Object.prototype);
  assert.equal(Object.hasOwn(translated, "__proto__"), true);
  assert.equal(translated.constructor, "translated");
});

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { copyUrlToClipboard } from "../src/string.ts";

const origin = "https://task.meowalive.com";
const path = "/meowalive/browse/WITCHFARM-10/";
const title = "WITCHFARM-10 修复农场显示";

function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
}

function clipboard(t, overrides = {}) {
  const write = t.mock.fn(async () => {});
  const writeText = t.mock.fn(async () => {});
  globals(t, {
    window: { location: { origin } },
    navigator: { clipboard: { write, writeText, ...overrides } },
    ClipboardItem: class {
      constructor(data) {
        this.data = data;
      }
      async getType(type) {
        return this.data[type];
      }
    },
  });
  return { write, writeText };
}

test("copies an issue title as a hyperlink while plain-text paste retains the exact URL", async (t) => {
  const { write, writeText } = clipboard(t);
  await copyUrlToClipboard(path, title);
  assert.equal(write.mock.callCount(), 1);
  const [item] = write.mock.calls[0].arguments[0];
  assert.equal(await item.data["text/plain"].text(), origin + path);
  assert.equal(await item.data["text/html"].text(), `<a href="${origin}${path}">${title}</a>`);
  assert.equal(item.data["text/html"].type, "text/html");
  assert.equal(item.data["text/plain"].type, "text/plain");
  assert.equal(writeText.mock.callCount(), 0);
});

test("escapes user-supplied names and URL attributes without losing query strings or anchors", async (t) => {
  const { write } = clipboard(t);
  const url = `${origin}${path}?a=1&b='two'#comment-123`;
  await copyUrlToClipboard(url, `中文 <img src=x onerror="alert(1)"> & '引号'`);
  const [item] = write.mock.calls[0].arguments[0];
  assert.equal(await item.data["text/plain"].text(), `${origin}${path}?a=1&b=%27two%27#comment-123`);
  assert.equal(
    await item.data["text/html"].text(),
    `<a href="${origin}${path}?a=1&amp;b=%27two%27#comment-123">中文 &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;引号&#39;</a>`
  );
});

test("ordinary URL copies and blank titles keep their existing plain-text behaviour", async (t) => {
  const { write, writeText } = clipboard(t);
  await Promise.all([undefined, "", "  "].map((label) => copyUrlToClipboard(path, label)));
  assert.equal(write.mock.callCount(), 0);
  assert.equal(writeText.mock.callCount(), 3);
  assert.ok(writeText.mock.calls.every((call) => call.arguments[0] === origin + path));
});

test("falls back to the URL when rich clipboard APIs are missing", async (t) => {
  const { writeText } = clipboard(t, { write: undefined });
  await copyUrlToClipboard(path, title);
  assert.deepEqual(writeText.mock.calls[0].arguments, [origin + path]);
});

test("falls back to the URL when ClipboardItem is missing", async (t) => {
  const { write, writeText } = clipboard(t);
  globals(t, { ClipboardItem: undefined });
  await copyUrlToClipboard(path, title);
  assert.equal(write.mock.callCount(), 0);
  assert.deepEqual(writeText.mock.calls[0].arguments, [origin + path]);
});

test("falls back when the browser rejects HTML clipboard writes", async (t) => {
  const { writeText } = clipboard(t, {
    write: async () => {
      throw new DOMException("HTML unsupported", "NotSupportedError");
    },
  });
  await copyUrlToClipboard(path, title);
  assert.deepEqual(writeText.mock.calls[0].arguments, [origin + path]);
});

test("reports failure when the browser denies both clipboard formats", async (t) => {
  const denied = new DOMException("Clipboard denied", "NotAllowedError");
  clipboard(t, {
    write: async () => {
      throw denied;
    },
    writeText: async () => {
      throw denied;
    },
  });
  await assert.rejects(copyUrlToClipboard(path, title), (error) => error === denied);
});

test("rejects executable rich links before touching the clipboard", async (t) => {
  const { write, writeText } = clipboard(t);
  await Promise.all(
    ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"].map((url) =>
      assert.rejects(copyUrlToClipboard(url, title), /Only HTTP\(S\)/)
    )
  );
  assert.equal(write.mock.callCount(), 0);
  assert.equal(writeText.mock.callCount(), 0);
});

for (const succeeds of [true, false]) {
  test(`legacy copy ${succeeds ? "copies the URL" : "reports failure"} and removes the temporary input`, async (t) => {
    const input = { value: "", style: {}, focus() {}, select() {} };
    const appendChild = t.mock.fn();
    const removeChild = t.mock.fn();
    globals(t, {
      window: { location: { origin } },
      navigator: {},
      ClipboardItem: undefined,
      document: {
        createElement: () => input,
        body: { appendChild, removeChild },
        execCommand: (command) => {
          assert.equal(command, "copy");
          assert.equal(input.value, origin + path);
          return succeeds;
        },
      },
    });
    if (succeeds) await copyUrlToClipboard(path, title);
    else await assert.rejects(copyUrlToClipboard(path, title), /Clipboard copy failed/);
    assert.equal(appendChild.mock.callCount(), 1);
    assert.deepEqual(removeChild.mock.calls[0].arguments, [input]);
  });
}

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

function boot({ browser = false, storedLanguage = null, changeTo = null } = {}) {
  // Each process starts the actual singleton with a fresh browser/server context.
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
    const browser = ${JSON.stringify(browser)};
    let storedLanguage = ${JSON.stringify(storedLanguage)};
    if (browser) {
      globalThis.window = {};
      globalThis.document = { documentElement: { lang: "" } };
      globalThis.localStorage = {
        getItem: () => storedLanguage,
        setItem: (_key, value) => { storedLanguage = value; },
      };
    }
    const { i18nInstance, initPromise } = await import("./src/core/instance.ts");
    await initPromise;
    const initialLanguage = i18nInstance.language;
    const initialLabel = i18nInstance.t("language");
    const changeTo = ${JSON.stringify(changeTo)};
    if (changeTo) {
      const { setLanguage } = await import("./src/core/set-language.ts");
      await setLanguage(changeTo);
    }
    console.log("RESULT " + JSON.stringify({
      initialLanguage,
      initialLabel,
      language: i18nInstance.language,
      label: i18nInstance.t("language"),
      storedLanguage,
      documentLanguage: globalThis.document?.documentElement.lang,
    }));
  `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
    }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split("\n").find((value) => value.startsWith("RESULT "));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice("RESULT ".length));
}

test("fresh server rendering loads Simplified Chinese resources", () => {
  const result = boot();
  assert.equal(result.initialLanguage, "zh-CN");
  assert.equal(result.initialLabel, "语言");
});

test("a new browser defaults to Simplified Chinese", () => {
  const result = boot({ browser: true });
  assert.equal(result.initialLanguage, "zh-CN");
  assert.equal(result.initialLabel, "语言");
});

test("an existing user's saved English preference takes priority", () => {
  const result = boot({ browser: true, storedLanguage: "en" });
  assert.equal(result.initialLanguage, "en");
  assert.equal(result.initialLabel, "Language");
  assert.equal(result.storedLanguage, "en");
});

test("users can still select and persist a different language", () => {
  const result = boot({ browser: true, changeTo: "en" });
  assert.equal(result.initialLanguage, "zh-CN");
  assert.equal(result.language, "en");
  assert.equal(result.label, "Language");
  assert.equal(result.storedLanguage, "en");
  assert.equal(result.documentLanguage, "en");
});

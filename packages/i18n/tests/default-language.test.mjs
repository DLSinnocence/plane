/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

function boot({ browser = false, storedLanguage = null, storageFailure = null, changeTo = null } = {}) {
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
    const values = new Map([["unrelatedSetting", "untouched"]]);
    const storedLanguage = ${JSON.stringify(storedLanguage)};
    if (storedLanguage !== null) values.set("userLanguage", storedLanguage);
    const storageFailure = ${JSON.stringify(storageFailure)};
    if (browser) {
      globalThis.window = {};
      globalThis.document = { documentElement: { lang: "zh-CN" } };
      const storage = {
        getItem: (key) => {
          if (storageFailure === "read") throw new Error("Storage denied");
          return values.get(key) ?? null;
        },
        setItem: (key, value) => {
          if (storageFailure === "write") throw new Error("Storage full");
          values.set(key, value);
        },
      };
      Object.defineProperty(window, "localStorage", {
        get: () => {
          if (storageFailure === "access") throw new Error("Storage unavailable");
          return storage;
        },
      });
    }
    const { i18nInstance, initPromise } = await import("./src/core/instance.ts");
    await initPromise;
    const initialLanguage = i18nInstance.language;
    const initialLabel = i18nInstance.t("language");
    const initialDocumentLanguage = globalThis.document?.documentElement.lang;
    const changeTo = ${JSON.stringify(changeTo)};
    if (changeTo !== null) {
      const { setLanguage } = await import("./src/core/set-language.ts");
      await setLanguage(changeTo);
    }
    console.log("RESULT " + JSON.stringify({
      initialLanguage,
      initialLabel,
      initialDocumentLanguage,
      language: i18nInstance.language,
      label: i18nInstance.t("language"),
      storedLanguage: values.get("userLanguage") ?? null,
      storage: Object.fromEntries(values),
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

function assertChinese(result) {
  assert.equal(result.initialLanguage, "zh-CN");
  assert.equal(result.initialLabel, "语言");
}

test("fresh server rendering loads Simplified Chinese resources", () => {
  assertChinese(boot());
});

test("a new browser defaults to Chinese without changing storage", () => {
  const result = boot({ browser: true });
  assertChinese(result);
  assert.equal(result.initialDocumentLanguage, "zh-CN");
  assert.deepEqual(result.storage, { unrelatedSetting: "untouched" });
});

test("saved English remains a preference and updates HTML on boot", () => {
  const result = boot({ browser: true, storedLanguage: "en" });
  assert.equal(result.initialLanguage, "en");
  assert.equal(result.initialLabel, "Language");
  assert.equal(result.initialDocumentLanguage, "en");
  assert.deepEqual(result.storage, { unrelatedSetting: "untouched", userLanguage: "en" });
});

test("other supported cached locales are preserved", () => {
  for (const language of ["fr", "zh-TW"]) {
    const result = boot({ browser: true, storedLanguage: language });
    assert.equal(result.initialLanguage, language);
    assert.equal(result.storedLanguage, language);
    assert.equal(result.initialDocumentLanguage, language);
  }
});

test("unsupported and empty caches fall back to Chinese without overwriting storage", () => {
  for (const storedLanguage of ["invalid", "", null]) {
    const result = boot({ browser: true, storedLanguage });
    assertChinese(result);
    assert.equal(result.initialDocumentLanguage, "zh-CN");
    assert.equal(result.storedLanguage, storedLanguage);
  }
});

test("unavailable storage does not crash boot or explicit language selection", () => {
  for (const storageFailure of ["access", "read", "write"]) {
    const result = boot({ browser: true, storageFailure, changeTo: "en" });
    assertChinese(result);
    assert.equal(result.language, "en");
    assert.equal(result.documentLanguage, "en");
  }
});

test("explicit English persists and survives another boot", () => {
  const result = boot({ browser: true, changeTo: "en" });
  assertChinese(result);
  assert.equal(result.language, "en");
  assert.equal(result.label, "Language");
  assert.equal(result.documentLanguage, "en");
  assert.deepEqual(result.storage, { unrelatedSetting: "untouched", userLanguage: "en" });
  const nextBoot = boot({ browser: true, storedLanguage: result.storedLanguage });
  assert.equal(nextBoot.initialLanguage, "en");
});

test("unsupported runtime profile language is normalized before loading and persistence", () => {
  const result = boot({ browser: true, changeTo: "not-supported" });
  assert.equal(result.language, "zh-CN");
  assert.equal(result.storedLanguage, "zh-CN");
  assert.equal(result.documentLanguage, "zh-CN");
});

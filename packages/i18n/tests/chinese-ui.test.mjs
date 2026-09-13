/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createInstance } from "i18next";

// Native Node ESM resolves intl-messageformat's CommonJS default differently
// from the web bundler. Use the plugin's CommonJS entry in these Node tests.
const { default: ICU } = createRequire(import.meta.url)("i18next-icu");

const localesDirectory = new URL("../src/locales/", import.meta.url);
const locales = readdirSync(localesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const resources = Object.fromEntries(
  locales.map((locale) => [
    locale,
    Object.fromEntries(
      ["common", "navigation"].map((namespace) => [
        namespace,
        JSON.parse(readFileSync(new URL(`${locale}/${namespace}.json`, localesDirectory), "utf8")),
      ])
    ),
  ])
);
const i18n = createInstance().use(
  new ICU({
    parseErrorHandler: (error) => {
      throw error;
    },
  })
);
await i18n.init({
  lng: "zh-CN",
  supportedLngs: locales,
  fallbackLng: false,
  resources,
  ns: ["common", "navigation"],
  defaultNS: "common",
  fallbackNS: ["navigation"],
  nsSeparator: false,
  interpolation: { escapeValue: false },
});

test("Chinese greetings are complete sentences with the user's name", () => {
  for (const [period, expected] of [
    ["morning", "早上好，张三"],
    ["afternoon", "下午好，张三"],
    ["evening", "晚上好，张三"],
  ]) {
    assert.equal(i18n.t(`greetings.${period}`, { lng: "zh-CN", name: "张三" }), expected);
  }
  assert.equal(i18n.t("greetings.morning", { lng: "en", name: "Sam" }), "Good morning, Sam");
  assert.equal(i18n.t("greetings.morning", { lng: "zh-TW", name: "王小明" }), "早安，王小明");
});

test("every supported locale supplies complete greetings without relying on Chinese fallback", () => {
  for (const locale of locales) {
    for (const period of ["morning", "afternoon", "evening"]) {
      const greeting = i18n.t(`greetings.${period}`, { lngs: [locale], name: "Test User" });
      assert.ok(greeting.includes("Test User"), `${locale}: ${greeting}`);
      assert.doesNotMatch(greeting, /greetings\.|\{name\}/);
    }
  }
});

test("project labels and navigation actions render in Chinese", () => {
  for (const [key, expected] of Object.entries({
    "sidebar.work_items": "工作项",
    "sidebar.cycles": "周期",
    "sidebar.modules": "模块",
    "sidebar.intake": "收集",
    "common.members": "成员",
    "sidebar.pages": "页面",
    "sidebar.views": "视图",
    "navigation.project.clear_default": "取消默认",
    "navigation.project.set_as_default": "设为默认",
    "navigation.project.hide_in_more_menu": "收起到更多菜单",
    "navigation.project.show": "显示",
    "common.your_profile": "个人资料",
    "common.completed_on": "完成于",
    forum: "论坛",
  })) {
    assert.equal(i18n.t(key), expected, key);
  }
});

test("project work item counts interpolate zero, one and multiple items", () => {
  for (const count of [0, 1, 2]) {
    assert.equal(i18n.t("navigation.project.card.members_count", { count }), `成员：${count}`);
    for (const [key, scope] of [
      ["work_item_count", "项目"],
      ["module_work_item_count", "模块"],
      ["cycle_work_item_count", "周期"],
    ]) {
      assert.equal(i18n.t(`navigation.project.${key}`, { count }), `此${scope}中有 ${count} 个工作项`);
    }
    assert.equal(
      i18n.t("navigation.project.archived_work_item_count", { count }),
      `此项目中有 ${count} 个已归档工作项`
    );
    assert.equal(
      i18n.t("navigation.project.work_item_count", { lng: "en", count }),
      count === 1 ? "There is 1 work item in this project" : `There are ${count} work items in this project`
    );
  }
});

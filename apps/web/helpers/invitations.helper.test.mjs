import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { invitationErrorMessage, invitationStatusMessage } from "./invitations.helper.ts";

test("email states distinguish created, queued and unsent invitations", () => {
  assert.match(invitationStatusMessage({ email_status: "not_configured" }), /created.*not configured.*Copy/);
  assert.match(invitationStatusMessage({ email_status: "failed" }), /created.*could not be queued.*Copy/);
  assert.match(invitationStatusMessage({ email_status: "queued" }), /queued for delivery/);
  assert.match(invitationStatusMessage({ email_status: "pending" }), /pending/);
  assert.doesNotMatch(invitationStatusMessage({}), /sent successfully/);
});

test("plain API error objects and nested recipient validation errors are visible", () => {
  assert.equal(invitationErrorMessage({ error: "Already a member" }), "Already a member");
  assert.equal(invitationErrorMessage({ detail: "Permission denied" }), "Permission denied");
  assert.equal(
    invitationErrorMessage({ emails: [{ email: ["Enter a valid email address."] }] }),
    "Enter a valid email address."
  );
  assert.equal(invitationErrorMessage({ emails: [{ role: ["Invalid role."] }] }), "Invalid role.");
  assert.equal(invitationErrorMessage(new Error("Network unavailable")), "Network unavailable");
  assert.match(invitationErrorMessage(undefined), /Unable to complete/);
});

const locale = (language) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/i18n/src/locales/${language}/workspace-settings.json`, import.meta.url),
      "utf8"
    )
  );
const english = locale("en");
const chinese = locale("zh-CN");
const translateChinese = (key) => key.split(".").reduce((value, part) => value[part], chinese);

test("Chinese invitation statuses and generic fallback use the active translator", () => {
  assert.match(
    invitationStatusMessage({ email_status: "not_configured" }, translateChinese),
    /邀请已创建.*尚未配置邮件服务.*复制/
  );
  assert.match(invitationStatusMessage({ email_status: "failed" }, translateChinese), /未能加入发送队列/);
  assert.match(invitationStatusMessage({ email_status: "queued" }, translateChinese), /已加入发送队列/);
  assert.match(invitationStatusMessage({ email_status: "pending" }, translateChinese), /等待发送处理/);
  assert.match(invitationStatusMessage({}, translateChinese), /待处理邀请列表/);
  assert.equal(invitationErrorMessage(undefined, translateChinese), "无法完成邀请请求，请重试。");
  assert.equal(
    invitationErrorMessage({ detail: "Server validation error" }, translateChinese),
    "Server validation error"
  );
});

test("English and Chinese invitation feedback have matching keys and interpolation parameters", () => {
  const en = english.workspace_settings.settings.members.invitation_flow;
  const zh = chinese.workspace_settings.settings.members.invitation_flow;
  assert.deepEqual(Object.keys(zh).toSorted(), Object.keys(en).toSorted());
  for (const [key, value] of Object.entries(en)) {
    assert.ok(zh[key].trim(), key);
    assert.deepEqual(zh[key].match(/\{\w+\}/g) ?? [], value.match(/\{\w+\}/g) ?? [], key);
  }
});

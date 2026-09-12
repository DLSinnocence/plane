/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { FeishuConfiguration, FeishuConfigurationUpdate } from "../core/services/integrations/feishu.service";

const deliveryStatuses = new Set(["pending", "sending", "sent", "failed", "skipped"]);
const deliveryErrors = new Set([
  "phone_missing",
  "phone_invalid",
  "phone_not_found",
  "phone_ambiguous",
  "phone_changed",
  "phone_conflict",
  "phone_inactive",
  "enqueue_failed",
  "integration_disabled",
  "app_changed",
  "recipient_inactive",
  "issue_unavailable",
  "project_membership_inactive",
  "secret_decryption_failed",
  "network_error",
  "provider_unavailable",
  "provider_http_error",
  "invalid_provider_response",
  "provider_rejected",
  "delivery_failed",
  "attempt_limit",
]);

/** Only known codes become translation keys; never expose arbitrary provider error text. */
export function getFeishuDeliveryLabelKey(kind: "status" | "error", value: string): string {
  const known = kind === "status" ? deliveryStatuses : deliveryErrors;
  return `feishu_integration.delivery_${kind}.${known.has(value) ? value : "unknown"}`;
}

/** A blank secret preserves the saved credential; never submit the placeholder. */
export function prepareFeishuConfiguration(
  saved: FeishuConfiguration,
  appId: string,
  secret: string,
  enabled: boolean
): { data: FeishuConfigurationUpdate; error?: "app_id_required" | "secret_required" } {
  const data: FeishuConfigurationUpdate = { app_id: appId.trim(), enabled };
  if (secret.trim()) data.app_secret = secret.trim();
  if (enabled && !data.app_id) return { data, error: "app_id_required" };
  if (!data.app_secret && (data.app_id !== saved.app_id || (enabled && !saved.has_app_secret))) {
    return { data, error: "secret_required" };
  }
  return { data };
}

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TIssueAttachment } from "@plane/types";

/** The original filename determines whether to attempt native image decoding. */
export function canPreviewAttachment(attachment: Pick<TIssueAttachment, "attributes" | "asset_url">): boolean {
  return Boolean(attachment.asset_url.trim()) && /\.(jpe?g|png|gif|webp)$/i.test(attachment.attributes.name);
}

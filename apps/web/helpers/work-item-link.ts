/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

type WorkItemLinkTitle = {
  name?: string | null;
  projectIdentifier?: string | null;
  sequenceId?: number | null;
};

export function getWorkItemLinkTitle({ name, projectIdentifier, sequenceId }: WorkItemLinkTitle): string {
  const identifier = projectIdentifier?.trim();
  const key = identifier && sequenceId != null ? `${identifier}-${sequenceId}` : "";
  return [key, name?.trim()].filter(Boolean).join(" ");
}

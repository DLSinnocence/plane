/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TIssueMap } from "@plane/types";

/** Keep a work item at the root unless it can be reached through an ancestor in this list group. */
export function getListRootIssueIds(issueIds: string[], issuesMap: TIssueMap): string[] {
  const groupIssueIds = new Set(issueIds);

  return issueIds.filter((issueId) => {
    const visited = new Set([issueId]);
    let parentId = issuesMap[issueId]?.parent_id;
    let hasVisibleAncestor = false;

    while (parentId) {
      // Keep malformed hierarchies accessible instead of hiding every member of a cycle.
      if (visited.has(parentId)) return true;
      visited.add(parentId);

      const parent = issuesMap[parentId];
      // A missing or non-expandable parent cannot provide access to this work item.
      if (!parent?.created_at || !parent.sub_issues_count) break;

      if (groupIssueIds.has(parentId)) hasVisibleAncestor = true;
      parentId = parent.parent_id;
    }

    return !hasVisibleAncestor;
  });
}

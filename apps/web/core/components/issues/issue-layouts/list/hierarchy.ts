/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TIssueMap } from "@plane/types";

export const MAX_LIST_NESTING_LEVEL = 3;

/** Keep a work item at the root unless it can be reached through an ancestor in this list group. */
export function getListRootIssueIds(issueIds: string[], issuesMap: TIssueMap): string[] {
  const groupIssueIds = new Set(issueIds);

  return issueIds.filter((issueId) => {
    const visited = new Set([issueId]);
    const ancestorDepths = [0];
    let parentId = issuesMap[issueId]?.parent_id;
    let depth = 0;

    while (parentId) {
      // Keep malformed hierarchies accessible instead of hiding every member of a cycle.
      if (visited.has(parentId)) return true;
      visited.add(parentId);

      const parent = issuesMap[parentId];
      // A missing or non-expandable parent cannot provide access to this work item.
      if (!parent?.created_at || !parent.sub_issues_count) break;

      depth += 1;
      if (groupIssueIds.has(parentId)) ancestorDepths.push(depth);
      parentId = parent.parent_id;
    }

    // Walk from the highest listed ancestor back towards this work item. Only a
    // retained root resets the depth; an ancestor nested below it does not.
    let rootDepth = ancestorDepths[ancestorDepths.length - 1];
    for (let index = ancestorDepths.length - 2; index >= 0; index--) {
      if (rootDepth - ancestorDepths[index] > MAX_LIST_NESTING_LEVEL) rootDepth = ancestorDepths[index];
    }

    return rootDepth === 0;
  });
}

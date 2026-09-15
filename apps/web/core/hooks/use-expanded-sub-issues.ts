/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { MAX_LIST_NESTING_LEVEL } from "../components/issues/issue-layouts/list/hierarchy";

type TExpandedSubIssues = {
  workspaceSlug: string | undefined;
  projectId: string | null | undefined;
  issueId: string;
  subIssueCount: number | undefined;
  nestingLevel: number;
  isEpic?: boolean;
  fetchSubIssues: (workspaceSlug: string, projectId: string, issueId: string) => Promise<unknown>;
};

/** Expansion is a read operation and must not depend on work item edit permissions. */
export const useExpandedSubIssues = ({
  workspaceSlug,
  projectId,
  issueId,
  subIssueCount,
  nestingLevel,
  isEpic = false,
  fetchSubIssues,
}: TExpandedSubIssues) => {
  const canExpand = !isEpic && nestingLevel < MAX_LIST_NESTING_LEVEL;
  const [isExpanded, setExpanded] = useState(canExpand);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    if (!isExpanded || !canExpand || !workspaceSlug || !projectId || !issueId || !subIssueCount) return;
    const key = JSON.stringify([workspaceSlug, projectId, issueId, subIssueCount]);
    if (requested.current.has(key)) return;
    requested.current.add(key);
    void fetchSubIssues(workspaceSlug, projectId, issueId).catch((error: unknown) => {
      requested.current.delete(key);
      console.error("Unable to load expanded sub-work items:", error);
    });
  }, [isExpanded, canExpand, workspaceSlug, projectId, issueId, subIssueCount, fetchSubIssues]);

  return { isExpanded: canExpand && isExpanded, setExpanded };
};

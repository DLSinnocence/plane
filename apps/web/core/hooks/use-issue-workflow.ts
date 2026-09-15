/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TIssue } from "@plane/types";
import { useUserPermissions } from "@/hooks/store/user";

/** Share the same fail-closed permission calculation with mutation handlers. */
export const useIssueWorkflow = (issue: TIssue | undefined, workspaceSlug: string) => {
  const { getIssuePermissions } = useUserPermissions();
  return getIssuePermissions(workspaceSlug, issue);
};

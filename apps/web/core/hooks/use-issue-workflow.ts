/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TIssue } from "@plane/types";
import { getIssueWorkflowPermissions } from "@/helpers/issue-workflow";
import { useProject } from "@/hooks/store/use-project";
import { useUser, useUserPermissions } from "@/hooks/store/user";

/** UI affordances only; the API rechecks responsibility against the persisted issue. */
export const useIssueWorkflow = (issue: TIssue | undefined, workspaceSlug: string) => {
  const { data: user } = useUser();
  const { getProjectById } = useProject();
  const { getProjectRoleByWorkspaceSlugAndProjectId } = useUserPermissions();
  const project = getProjectById(issue?.project_id);
  const role = getProjectRoleByWorkspaceSlugAndProjectId(workspaceSlug, issue?.project_id ?? undefined);
  const leadId = typeof project?.project_lead === "string" ? project.project_lead : project?.project_lead?.id;
  return getIssueWorkflowPermissions({ issue, userId: user?.id, role, leadId });
};

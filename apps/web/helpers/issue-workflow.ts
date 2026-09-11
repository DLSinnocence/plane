/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EUserPermissions } from "@plane/constants";
import type { TIssue } from "@plane/types";

type TIssueWorkflowContext = {
  issue: Pick<TIssue, "state_id" | "state_assignees" | "assignee_ids" | "created_by"> | undefined;
  userId: string | undefined;
  role: EUserPermissions | undefined;
  leadId: string | undefined;
};

/** UI affordances only; the API checks responsibility against the persisted issue. */
export const getIssueWorkflowPermissions = ({ issue, userId, role, leadId }: TIssueWorkflowContext) => {
  const isMember = role === EUserPermissions.MEMBER || role === EUserPermissions.ADMIN;
  const isManager = isMember && (role === EUserPermissions.ADMIN || (!!userId && leadId === userId));
  // An explicit empty state assignment is authoritative; only an omitted entry
  // falls back to the current assignee list.
  const assignees =
    (issue?.state_id ? issue.state_assignees?.[issue.state_id] : undefined) ?? issue?.assignee_ids ?? [];
  const isResponsible = !!userId && assignees.includes(userId);
  const canBootstrap =
    !!userId && issue?.created_by === userId && assignees.length === 0 && (issue?.assignee_ids?.length ?? 0) === 0;

  return {
    canTransition: !!issue && !!userId && isMember && (isManager || isResponsible),
    canManageAssignments: !!issue && !!userId && isMember && (isManager || isResponsible || canBootstrap),
  };
};

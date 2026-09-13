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
  stateGroup?: string;
};

/** UI affordances only; the API checks responsibility against the persisted issue. */
export const getIssueWorkflowPermissions = ({ issue, userId, role, leadId, stateGroup }: TIssueWorkflowContext) => {
  const isMember = role === EUserPermissions.MEMBER || role === EUserPermissions.ADMIN;
  const isManager = isMember && (role === EUserPermissions.ADMIN || (!!userId && leadId === userId));
  // Missing stages default to the creator; explicit empty selections remain unassigned.
  const fixedStage = stateGroup !== undefined && ["backlog", "completed", "cancelled"].includes(stateGroup);
  const assignees =
    (!fixedStage && issue?.state_id ? issue.state_assignees?.[issue.state_id] : undefined) ??
    (issue?.created_by ? [issue.created_by] : []);
  const isResponsible = !!userId && assignees.includes(userId);
  const isOwner = !!userId && issue?.created_by === userId;

  return {
    canTransition: !!issue && !!userId && isMember && (isManager || isResponsible),
    canManageAssignments: !!issue && !!userId && isMember && (role === EUserPermissions.ADMIN || isOwner),
  };
};

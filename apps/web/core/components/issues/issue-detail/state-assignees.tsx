/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { Collapsible } from "@makeplane/propel/components/collapsible";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TIssue } from "@plane/types";
import { StateAssigneeFields } from "@/components/issues/state-assignee-fields";
import { useIssueWorkflow } from "@/hooks/use-issue-workflow";
import type { TIssueOperations } from "./root";

type Props = {
  issue: TIssue;
  workspaceSlug: string;
  projectId: string;
  issueOperations: TIssueOperations;
  disabled: boolean;
};

export const IssueStateAssignees = observer(function IssueStateAssignees(props: Props) {
  const { issue, workspaceSlug, projectId, issueOperations, disabled } = props;
  const { t } = useTranslation();
  const { canTransition, canManageAssignments } = useIssueWorkflow(issue, workspaceSlug);
  const [isSaving, setIsSaving] = useState(false);

  const saveOwners = async (assignments: NonNullable<TIssue["state_assignees"]>) => {
    if (disabled || !canManageAssignments || isSaving) return;
    setIsSaving(true);
    try {
      await issueOperations.update(workspaceSlug, projectId, issue.id, { state_assignees: assignments });
    } catch (error: unknown) {
      console.error("Error saving workflow owners:", error);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("common.error.label"),
        message: t("entity.update.failed", { entity: t("issue.label") }),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="mt-5 border-t border-subtle pt-4 pb-3" aria-busy={isSaving}>
      <Collapsible
        key={issue.id}
        defaultOpen={false}
        trigger={<span className="text-body-xs-medium">{t("workflows.state_assignees.title")}</span>}
      >
        {!disabled && !canManageAssignments && (
          <p className="mt-2 text-body-xs-regular text-secondary">
            {t("workflows.state_assignees.configuration_permission_hint")}
          </p>
        )}
        {!disabled && !canTransition && (
          <p className="mt-2 text-body-xs-regular text-secondary">{t("workflows.state_assignees.permission_hint")}</p>
        )}
        <StateAssigneeFields
          workspaceSlug={workspaceSlug}
          projectId={projectId}
          needsTesting={issue.needs_testing}
          stateId={issue.state_id}
          creatorId={issue.created_by}
          value={issue.state_assignees}
          onChange={(assignments) => void saveOwners(assignments)}
          disabled={disabled || !canManageAssignments || isSaving}
        />
      </Collapsible>
    </section>
  );
});

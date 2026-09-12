/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import type { TIssue } from "@plane/types";
import { MemberDropdown } from "@/components/dropdowns/member/dropdown";
import { useProjectState } from "@/hooks/store/use-project-state";
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
  const { getProjectStates, fetchProjectStates } = useProjectState();
  const { canTransition, canManageAssignments } = useIssueWorkflow(issue, workspaceSlug);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const states = getProjectStates(projectId);
  const needsStates = states === undefined;

  useEffect(() => {
    if (!needsStates) return;
    let active = true;
    setLoadError(false);
    void fetchProjectStates(workspaceSlug, projectId).catch((error: unknown) => {
      console.error("Error loading workflow states:", error);
      if (active) setLoadError(true);
    });
    return () => {
      active = false;
    };
  }, [fetchProjectStates, needsStates, projectId, workspaceSlug, retryCount]);

  const saveOwners = async (stateId: string, owners: string[] | undefined) => {
    if (disabled || !canManageAssignments || isSaving) return;
    const assignments = Object.fromEntries(
      Object.entries(issue.state_assignees ?? {}).filter(([id]) => states?.some((state) => state.id === id))
    );
    if (owners === undefined) delete assignments[stateId];
    else assignments[stateId] = owners;
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
      <h6 className="text-body-xs-medium">{t("workflows.state_assignees.title")}</h6>
      <p className="mt-1 text-body-xs-regular text-secondary">{t("workflows.state_assignees.description")}</p>
      {!disabled && !canManageAssignments && (
        <p className="mt-2 text-body-xs-regular text-secondary">
          {t("workflows.state_assignees.configuration_permission_hint")}
        </p>
      )}
      {!disabled && !canTransition && (
        <p className="mt-2 text-body-xs-regular text-secondary">{t("workflows.state_assignees.permission_hint")}</p>
      )}
      {loadError ? (
        <div className="mt-3 text-body-xs-regular text-secondary" role="alert">
          {t("workflows.state_assignees.load_error")}{" "}
          <button type="button" className="underline" onClick={() => setRetryCount((count) => count + 1)}>
            {t("workflows.state_assignees.retry")}
          </button>
        </div>
      ) : !states ? (
        <p className="mt-3 text-body-xs-regular text-secondary">{t("workflows.state_assignees.loading")}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {states.map((state) => {
            const owners = issue.state_assignees?.[state.id];
            const isCurrent = state.id === issue.state_id;
            return (
              <div key={state.id} className="rounded-sm border border-subtle p-2">
                <div className="flex items-center gap-2 text-body-xs-medium">
                  <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: state.color }} />
                  <span className="min-w-0 flex-1 break-words">{state.name}</span>
                  {isCurrent && (
                    <span className="shrink-0 text-secondary">{t("workflows.state_assignees.current")}</span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1">
                  <MemberDropdown
                    projectId={projectId}
                    value={owners ?? []}
                    onChange={(value) => void saveOwners(state.id, value)}
                    disabled={disabled || !canManageAssignments || isSaving}
                    multiple
                    placeholder={t(
                      owners === undefined
                        ? "workflows.state_assignees.inherited"
                        : "workflows.state_assignees.unassigned"
                    )}
                    buttonVariant="transparent-with-text"
                    className="min-w-0 flex-1"
                    buttonContainerClassName="w-full text-left"
                    buttonClassName="text-body-xs-regular"
                    showTooltip
                    tooltipContent={state.name}
                    dropdownArrow
                  />
                  {owners !== undefined && !disabled && canManageAssignments && (
                    <button
                      type="button"
                      className="shrink-0 text-body-xs-regular text-secondary underline disabled:opacity-50"
                      disabled={isSaving}
                      onClick={() => void saveOwners(state.id, undefined)}
                      aria-label={t("workflows.state_assignees.reset_label", { state: state.name })}
                    >
                      {t("workflows.state_assignees.reset")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
});

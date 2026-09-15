/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import type { TIssue } from "@plane/types";
import { MemberDropdown } from "@/components/dropdowns/member/dropdown";
import { canConfigureStateAssignees, getDefaultStateAssignees } from "@/helpers/issue-state-assignees";
import { useProjectState } from "@/hooks/store/use-project-state";

type Props = {
  workspaceSlug: string;
  projectId: string;
  stateId: string | null | undefined;
  creatorId: string | null | undefined;
  value: TIssue["state_assignees"];
  onChange: (assignments: NonNullable<TIssue["state_assignees"]>) => void;
  disabled?: boolean;
  columns?: 1 | 2;
};

export const StateAssigneeFields = observer(function StateAssigneeFields(props: Props) {
  const { workspaceSlug, projectId, stateId, creatorId, value, onChange, disabled = false, columns = 1 } = props;
  const { t } = useTranslation();
  const { getProjectStates, fetchProjectStates } = useProjectState();
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

  if (needsStates && loadError) {
    return (
      <div className="mt-3 text-body-xs-regular text-secondary" role="alert">
        {t("workflows.state_assignees.load_error")}{" "}
        <button type="button" className="underline" onClick={() => setRetryCount((count) => count + 1)}>
          {t("workflows.state_assignees.retry")}
        </button>
      </div>
    );
  }
  if (!states) {
    return <p className="mt-3 text-body-xs-regular text-secondary">{t("workflows.state_assignees.loading")}</p>;
  }

  const assignments = getDefaultStateAssignees(states, creatorId, value);
  const currentStateId = stateId || states.find((state) => state.default)?.id || states[0]?.id;

  return (
    <div className={columns === 2 ? "mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" : "mt-3 grid grid-cols-1 gap-2"}>
      {states.filter(canConfigureStateAssignees).map((state) => {
        const owners = assignments[state.id];
        const isCreator = owners.length === 1 && owners[0] === creatorId;
        return (
          <div key={state.id} className="min-w-0 rounded-sm border border-subtle p-2">
            <div className="flex items-center gap-2 text-body-xs-medium">
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: state.color }} />
              <span className="min-w-0 flex-1 break-words">{state.name}</span>
              {state.id === currentStateId && (
                <span className="shrink-0 text-secondary">{t("workflows.state_assignees.current")}</span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-1">
              <MemberDropdown
                projectId={projectId}
                value={owners}
                onChange={(members) => onChange({ ...assignments, [state.id]: members })}
                disabled={disabled}
                multiple
                placeholder={t(
                  isCreator ? "workflows.state_assignees.creator" : "workflows.state_assignees.unassigned"
                )}
                buttonVariant="transparent-with-text"
                className="min-w-0 flex-1"
                buttonContainerClassName="w-full text-left"
                buttonClassName="text-body-xs-regular"
                showUserDetails
                showTooltip
                tooltipContent={state.name}
                dropdownArrow={!disabled}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
});

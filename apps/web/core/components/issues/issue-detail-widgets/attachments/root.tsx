/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useEffect, useState } from "react";
import { EIssueServiceType } from "@plane/types";
import { EmptyAttachmentActionButton } from "../../attachment/empty-action-button";
import { observer } from "mobx-react";
// plane imports
import { Collapsible } from "@makeplane/propel/components/collapsible";
import type { TIssueServiceType } from "@plane/types";
// hooks
import { useIssueWorkflow } from "@/hooks/use-issue-workflow";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// local imports
import { IssueAttachmentsCollapsibleContent } from "./content";
import { IssueAttachmentsCollapsibleTitle } from "./title";
import { IssueAttachmentActionButton } from "./quick-action-button";

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled?: boolean;
  issueServiceType: TIssueServiceType;
};

export const AttachmentsCollapsible = observer(function AttachmentsCollapsible(props: Props) {
  const { workspaceSlug, projectId, issueId, disabled: disabledByParent = false, issueServiceType } = props;
  // store hooks
  const issueDetail = useIssueDetail(issueServiceType);
  const { canUploadAttachments } = useIssueWorkflow(issueDetail.issue.getIssueById(issueId), workspaceSlug);
  const disabled = disabledByParent || !canUploadAttachments;
  const { openWidgets, toggleOpenWidget, attachment } = issueDetail;
  const [focusSlotId, setFocusSlotId] = useState<string | null>(null);
  useEffect(() => {
    setFocusSlotId(null);
    if (issueServiceType === EIssueServiceType.ISSUES)
      void attachment.fetchAttachmentSlots(workspaceSlug, projectId, issueId).catch(() => undefined);
  }, [attachment, workspaceSlug, projectId, issueId, issueServiceType]);

  // derived values
  const isCollapsibleOpen = openWidgets.includes("attachments");

  return (
    <Collapsible
      open={isCollapsibleOpen}
      onOpenChange={() => toggleOpenWidget("attachments")}
      trigger={<IssueAttachmentsCollapsibleTitle issueId={issueId} issueServiceType={issueServiceType} />}
      trailing={
        !disabled && issueServiceType === EIssueServiceType.ISSUES ? (
          <EmptyAttachmentActionButton
            key={issueId}
            workspaceSlug={workspaceSlug}
            projectId={projectId}
            issueId={issueId}
            onCreated={(id) => {
              if (!issueDetail.openWidgets.includes("attachments")) toggleOpenWidget("attachments");
              setFocusSlotId(id);
            }}
          />
        ) : isCollapsibleOpen && !disabled ? (
          <IssueAttachmentActionButton
            workspaceSlug={workspaceSlug}
            projectId={projectId}
            issueId={issueId}
            disabled={disabled}
            issueServiceType={issueServiceType}
          />
        ) : undefined
      }
    >
      <IssueAttachmentsCollapsibleContent
        focusSlotId={focusSlotId}
        onFocusHandled={() => setFocusSlotId(null)}
        workspaceSlug={workspaceSlug}
        projectId={projectId}
        issueId={issueId}
        disabled={disabled}
        issueServiceType={issueServiceType}
      />
    </Collapsible>
  );
});

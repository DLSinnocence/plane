/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { observer } from "mobx-react";
import type { TIssueServiceType } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
// local imports
import { IssueAttachmentSlots } from "../../attachment/slots";
import { IssueAttachmentItemList } from "../../attachment/attachment-item-list";
import { useAttachmentOperations } from "./helper";

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled: boolean;
  issueServiceType?: TIssueServiceType;
  focusSlotId?: string | null;
  onFocusHandled?: () => void;
};

export const IssueAttachmentsCollapsibleContent = observer(function IssueAttachmentsCollapsibleContent(props: Props) {
  const { workspaceSlug, projectId, issueId, disabled, issueServiceType = EIssueServiceType.ISSUES } = props;
  // helper
  const attachmentHelpers = useAttachmentOperations(workspaceSlug, projectId, issueId, issueServiceType);
  return (
    <>
      {issueServiceType === EIssueServiceType.ISSUES && (
        <IssueAttachmentSlots
          focusSlotId={props.focusSlotId}
          onFocusHandled={props.onFocusHandled}
          key={`${workspaceSlug}:${projectId}:${issueId}`}
          workspaceSlug={workspaceSlug}
          projectId={projectId}
          issueId={issueId}
          disabled={disabled}
          attachmentHelpers={attachmentHelpers}
        />
      )}
      <IssueAttachmentItemList
        workspaceSlug={workspaceSlug}
        projectId={projectId}
        issueId={issueId}
        disabled={disabled}
        attachmentHelpers={attachmentHelpers}
        issueServiceType={issueServiceType}
      />
    </>
  );
});

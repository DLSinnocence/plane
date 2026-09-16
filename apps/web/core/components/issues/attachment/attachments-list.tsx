/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// types
import type { TAttachmentHelpers } from "../issue-detail-widgets/attachments/helper";
// components
import { IssueAttachmentsDetail } from "./attachment-detail";
import { IssueAttachmentsUploadDetails } from "./attachment-upload-details";
import { useAttachmentPreview } from "./use-attachment-preview";

type TIssueAttachmentsList = {
  issueId: string;
  attachmentHelpers: TAttachmentHelpers;
  disabled?: boolean;
};

export const IssueAttachmentsList = observer(function IssueAttachmentsList(props: TIssueAttachmentsList) {
  const { issueId, attachmentHelpers, disabled } = props;
  // store hooks
  const {
    attachment: { getAttachmentsByIssueId, getAttachmentById },
  } = useIssueDetail();
  // derived values
  const { snapshot: attachmentSnapshot } = attachmentHelpers;
  const { uploadStatus } = attachmentSnapshot;
  const issueAttachments = getAttachmentsByIssueId(issueId);
  const { openPreview, preview } = useAttachmentPreview(
    issueId,
    (issueAttachments ?? []).flatMap((id) => {
      const file = getAttachmentById(id);
      return file ? [file] : [];
    })
  );

  return (
    <>
      {preview}
      {uploadStatus?.map((status) => (
        <IssueAttachmentsUploadDetails key={status.id} uploadStatus={status} />
      ))}
      {issueAttachments?.map((attachmentId) => (
        <IssueAttachmentsDetail
          key={attachmentId}
          attachmentId={attachmentId}
          onPreview={openPreview}
          disabled={disabled}
          attachmentHelpers={attachmentHelpers}
        />
      ))}
    </>
  );
});

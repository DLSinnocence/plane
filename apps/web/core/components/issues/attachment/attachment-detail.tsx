/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { CustomMenu } from "@plane/ui";
import type { TIssueAttachment } from "@plane/types";
import { AttachmentFileLink } from "./file-link";
import { AttachmentDownloadMenuItem } from "./download";
import { DeleteOutline, WarningCircleOutline } from "@makeplane/propel/icons";
// ui
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { convertBytesToSize, getFileExtension, getFileName, renderFormattedDate, truncateText } from "@plane/utils";
// icons
//
import { getFileIcon } from "@/components/icons";
// components
import { IssueAttachmentDeleteModal } from "@/components/issues/attachment/delete-attachment-modal";
// helpers
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useMember } from "@/hooks/store/use-member";
import { usePlatformOS } from "@/hooks/use-platform-os";
// types
import type { TAttachmentHelpers } from "../issue-detail-widgets/attachments/helper";

type TAttachmentOperationsRemoveModal = Exclude<TAttachmentHelpers, "create">;

type TIssueAttachmentsDetail = {
  attachmentId: string;
  attachmentHelpers: TAttachmentOperationsRemoveModal;
  onPreview: (attachment: TIssueAttachment) => void;
  disabled?: boolean;
};

export const IssueAttachmentsDetail = observer(function IssueAttachmentsDetail(props: TIssueAttachmentsDetail) {
  // props
  const { attachmentId, attachmentHelpers, disabled, onPreview } = props;
  const { t } = useTranslation();
  // store hooks
  const { getUserDetails } = useMember();
  const {
    attachment: { getAttachmentById },
  } = useIssueDetail();
  // state
  const [isDeleteIssueAttachmentModalOpen, setIsDeleteIssueAttachmentModalOpen] = useState(false);
  // derived values
  const attachment = attachmentId ? getAttachmentById(attachmentId) : undefined;
  const fileName = getFileName(attachment?.attributes.name ?? "");
  const fileExtension = getFileExtension(attachment?.attributes.name ?? "");
  const fileIcon = getFileIcon(fileExtension, 28);
  // hooks
  const { isMobile } = usePlatformOS();

  if (!attachment) return <></>;

  return (
    <>
      {isDeleteIssueAttachmentModalOpen && (
        <IssueAttachmentDeleteModal
          isOpen={isDeleteIssueAttachmentModalOpen}
          onClose={() => setIsDeleteIssueAttachmentModalOpen(false)}
          attachmentOperations={attachmentHelpers.operations}
          attachmentId={attachmentId}
        />
      )}
      <div className="flex min-h-[60px] items-center justify-between gap-1 rounded-md border-[2px] border-subtle bg-surface-1 px-4 py-2 text-13">
        <AttachmentFileLink attachment={attachment} onPreview={onPreview} aria-label={attachment.attributes.name}>
          <div className="flex items-center gap-3">
            <div className="h-7 w-7">{fileIcon}</div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Tooltip label={fileName} layout="stacked" disabled={isMobile}>
                  <span className="text-13">{truncateText(`${fileName}`, 10)}</span>
                </Tooltip>
                <Tooltip
                  label={`${
                    getUserDetails(attachment.updated_by)?.display_name ?? ""
                  } uploaded on ${renderFormattedDate(attachment.updated_at)}`}
                  layout="stacked"
                  disabled={isMobile}
                >
                  <span>
                    <WarningCircleOutline className="h-3 w-3" />
                  </span>
                </Tooltip>
              </div>

              <div className="flex items-center gap-3 text-11 text-secondary">
                <span>{fileExtension.toUpperCase()}</span>
                <span>{convertBytesToSize(attachment.attributes.size)}</span>
              </div>
            </div>
          </div>
        </AttachmentFileLink>

        <CustomMenu ellipsis closeOnSelect placement="bottom-end">
          <AttachmentDownloadMenuItem attachment={attachment} />
          {!disabled && (
            <CustomMenu.MenuItem
              className="flex items-center gap-2"
              onClick={() => setIsDeleteIssueAttachmentModalOpen(true)}
            >
              <DeleteOutline className="size-3.5" />
              <span>{t("common.actions.delete")}</span>
            </CustomMenu.MenuItem>
          )}
        </CustomMenu>
      </div>
    </>
  );
});

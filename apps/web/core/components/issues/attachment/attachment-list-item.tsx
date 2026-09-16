/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { DeleteOutline } from "@makeplane/propel/icons";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import type { TIssueAttachment, TIssueServiceType } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
import { CustomMenu } from "@plane/ui";
import { convertBytesToSize, getFileExtension, renderFormattedDate } from "@plane/utils";
import { ButtonAvatars } from "@/components/dropdowns/member/avatar";
import { getFileIcon } from "@/components/icons";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useMember } from "@/hooks/store/use-member";
import { usePlatformOS } from "@/hooks/use-platform-os";
import { AttachmentFileLink } from "./file-link";

type TIssueAttachmentsListItem = {
  attachmentId: string;
  disabled?: boolean;
  issueServiceType?: TIssueServiceType;
  onPreview: (attachment: TIssueAttachment) => void;
};

export const IssueAttachmentsListItem = observer(function IssueAttachmentsListItem(props: TIssueAttachmentsListItem) {
  const { t } = useTranslation();
  const { attachmentId, disabled, issueServiceType = EIssueServiceType.ISSUES, onPreview } = props;
  const { getUserDetails } = useMember();
  const {
    attachment: { getAttachmentById },
    toggleDeleteAttachmentModal,
  } = useIssueDetail(issueServiceType);
  const attachment = attachmentId ? getAttachmentById(attachmentId) : undefined;
  const { isMobile } = usePlatformOS();
  if (!attachment) return null;

  const fileName = attachment.attributes.name;
  const fileIcon = getFileIcon(getFileExtension(fileName), 18);
  return (
    <div
      role="presentation"
      onClick={(event) => event.stopPropagation()}
      className="group flex min-h-11 items-center justify-between gap-3 px-3 hover:bg-surface-2"
    >
      <AttachmentFileLink
        attachment={attachment}
        onPreview={onPreview}
        className="flex min-w-0 flex-1 items-center gap-3 truncate text-13"
      >
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {fileIcon}
        </span>
        <Tooltip label={fileName} layout="stacked" disabled={isMobile}>
          <span className="truncate font-medium text-secondary">{fileName}</span>
        </Tooltip>
        <span className="flex size-1.5 shrink-0 rounded-full bg-layer-1" />
        <span className="shrink-0 text-placeholder">{convertBytesToSize(attachment.attributes.size)}</span>
      </AttachmentFileLink>
      <div className="flex items-center gap-3">
        {attachment.created_by && (
          <Tooltip
            label={`${getUserDetails(attachment.created_by)?.display_name ?? ""} uploaded on ${renderFormattedDate(attachment.updated_at)}`}
            layout="stacked"
            disabled={isMobile}
          >
            <div className="flex items-center justify-center">
              <ButtonAvatars showTooltip userIds={attachment.created_by} />
            </div>
          </Tooltip>
        )}
        <CustomMenu ellipsis closeOnSelect placement="bottom-end" disabled={disabled}>
          <CustomMenu.MenuItem onClick={() => toggleDeleteAttachmentModal(attachmentId)}>
            <div className="flex items-center gap-2">
              <DeleteOutline className="h-3.5 w-3.5" />
              <span>{t("common.actions.delete")}</span>
            </div>
          </CustomMenu.MenuItem>
        </CustomMenu>
      </div>
    </div>
  );
});

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { EIssueServiceType } from "@plane/types";
import { IssueAttachmentActionButton } from "@/components/issues/issue-detail-widgets/attachments/quick-action-button";
import { IssueAttachmentSlots } from "@/components/issues/attachment/slots";
import { IssueAttachmentUpload } from "@/components/issues/attachment/attachment-upload";
import { IssueAttachmentItemList } from "@/components/issues/attachment/attachment-item-list";
import { attachmentFixture } from "./attachment-state";

export const AttachmentSlotsFixture = observer(function AttachmentSlotsFixture() {
  const props = {
    workspaceSlug: "workspace",
    projectId: "project",
    issueId: "issue",
    disabled: new URLSearchParams(window.location.search).has("disabled"),
    attachmentHelpers: {
      operations: {
        create: attachmentFixture.upload,
        remove: (id: string) => attachmentFixture.removeAttachment("workspace", "project", "issue", id),
      },
      snapshot: { uploadStatus: [] },
    },
  };
  return (
    <main>
      <h1>Attachment slots fixture</h1>
      <section data-testid="slots">
        <IssueAttachmentSlots {...props} />
      </section>
      <section data-testid="ordinary-quick-upload">
        <IssueAttachmentActionButton
          workspaceSlug={props.workspaceSlug}
          projectId={props.projectId}
          issueId={props.issueId}
          disabled={props.disabled}
          issueServiceType={EIssueServiceType.ISSUES}
          customButton={<span>Upload ordinary attachment</span>}
        />
      </section>
      <section data-testid="ordinary-upload-dropzone">
        <IssueAttachmentUpload
          workspaceSlug={props.workspaceSlug}
          disabled={props.disabled}
          attachmentOperations={props.attachmentHelpers.operations}
        />
      </section>
      <section data-testid="ordinary">
        <IssueAttachmentItemList {...props} />
      </section>
      <output data-testid="attachment-state">
        {JSON.stringify({
          slots: attachmentFixture.slots,
          files: attachmentFixture.files,
          templates: attachmentFixture.templates,
          calls: attachmentFixture.calls,
        })}
      </output>
    </main>
  );
});

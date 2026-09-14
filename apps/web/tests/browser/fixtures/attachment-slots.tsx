/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef, useState } from "react";
import { observer } from "mobx-react";
import { EIssueServiceType } from "@plane/types";
import { createPeekEscapeHandler } from "virtual:attachment-peek-handler";
import { IssueAttachmentActionButton } from "@/components/issues/issue-detail-widgets/attachments/quick-action-button";
import { AttachmentsCollapsible } from "@/components/issues/issue-detail-widgets/attachments/root";
import { IssueDetailWidgetActionButtons } from "@/components/issues/issue-detail-widgets/action-buttons";
import { IssueAttachmentUpload } from "@/components/issues/attachment/attachment-upload";
import { IssueAttachmentItemList } from "@/components/issues/attachment/attachment-item-list";
import usePeekOverviewOutsideClickDetector from "@/hooks/use-peek-overview-outside-click";
import useKeypress from "@/hooks/use-keypress";
import { attachmentFixture } from "./attachment-state";

export const AttachmentSlotsFixture = observer(function AttachmentSlotsFixture() {
  const [open, setOpen] = useState(true);
  const peekRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  usePeekOverviewOutsideClickDetector(peekRef, close, "issue");
  useKeypress("Escape", createPeekEscapeHandler(close));
  const props = {
    workspaceSlug: "workspace",
    projectId: "project",
    issueId: "issue",
    issueServiceType: EIssueServiceType.ISSUES,
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
      <button type="button" data-testid="outside-peek">
        Outside peek
      </button>
      {open ? (
        <div ref={peekRef} data-testid="attachment-peek">
          <h1>Attachment slots fixture</h1>
          <section data-testid="top-attachment-actions">
            <IssueDetailWidgetActionButtons {...props} hideWidgets={["sub-work-items", "relations", "links"]} />
          </section>
          <section data-testid="slots">
            <AttachmentsCollapsible {...props} />
          </section>
          <section data-testid="ordinary-quick-upload">
            <IssueAttachmentActionButton {...props} customButton={<span>Upload ordinary attachment</span>} />
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
        </div>
      ) : (
        <p data-testid="peek-closed">Peek closed</p>
      )}
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

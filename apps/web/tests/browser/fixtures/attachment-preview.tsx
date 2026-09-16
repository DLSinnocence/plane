/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { EIssueServiceType } from "@plane/types";
import { createPeekEscapeHandler } from "virtual:attachment-peek-handler";
import { AttachmentsCollapsible } from "@/components/issues/issue-detail-widgets/attachments/root";
import { useAttachmentOperations } from "@/components/issues/issue-detail-widgets/attachments/helper";
import { IssueAttachmentItemList } from "@/components/issues/attachment/attachment-item-list";
import { IssueAttachmentsList } from "@/components/issues/attachment/attachments-list";
import usePeekOverviewOutsideClickDetector from "@/hooks/use-peek-overview-outside-click";
import useKeypress from "@/hooks/use-keypress";
import { attachmentFixture } from "./attachment-state";

const params = new URLSearchParams(window.location.search);
if (params.has("attachment-preview")) {
  attachmentFixture.seedPreview(
    params.get("filename") ?? "reference.PNG",
    params.get("src") ?? "/preview-assets/canonical?signature=keep%2Bexact&expires=123"
  );
}

export const AttachmentPreviewFixture = observer(function AttachmentPreviewFixture() {
  const [open, setOpen] = useState(true);
  const [issueId, setIssueId] = useState("issue");
  const peekRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  usePeekOverviewOutsideClickDetector(peekRef, close, "issue");
  useKeypress("Escape", createPeekEscapeHandler(close));
  const disabled = params.has("disabled") || params.get("role") === "guest";
  const attachmentHelpers = useAttachmentOperations("workspace", "project", issueId, EIssueServiceType.EPICS);

  useEffect(() => {
    const mutate = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      if (action === "switch-issue") setIssueId((id) => (id === "issue" ? "other-issue" : "issue"));
      if (action === "remove")
        void attachmentFixture.removeAttachment("workspace", "project", issueId, "preview-image");
      if (action === "replace") attachmentFixture.replacePreview();
    };
    window.addEventListener("attachment-preview:mutate", mutate);
    return () => window.removeEventListener("attachment-preview:mutate", mutate);
  }, [issueId]);

  return (
    <main className="p-4">
      <button type="button" data-testid="outside-peek">
        Outside peek
      </button>
      {open ? (
        <div ref={peekRef} data-testid="attachment-peek" className="space-y-4">
          <h1>Attachment preview fixture</h1>
          <section data-testid="preview-slots">
            <AttachmentsCollapsible
              workspaceSlug="workspace"
              projectId="project"
              issueId={issueId}
              issueServiceType={EIssueServiceType.ISSUES}
              disabled={disabled}
            />
          </section>
          <section data-testid="preview-legacy">
            <IssueAttachmentItemList
              workspaceSlug="workspace"
              projectId="project"
              issueId={issueId}
              issueServiceType={EIssueServiceType.EPICS}
              attachmentHelpers={attachmentHelpers}
              disabled={disabled}
            />
          </section>
          <section data-testid="preview-inbox">
            <IssueAttachmentsList issueId={issueId} attachmentHelpers={attachmentHelpers} disabled={disabled} />
          </section>
          <output data-testid="preview-issue">{issueId}</output>
        </div>
      ) : (
        <p data-testid="peek-closed">Peek closed</p>
      )}
    </main>
  );
});

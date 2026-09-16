/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "@plane/i18n";
import type { TIssueAttachment } from "@plane/types";
import { ImagePreviewModal } from "@plane/ui";
import { getFileURL } from "@plane/utils";
import { canPreviewAttachment } from "@/helpers/attachment-preview";

type Selection = { issueId: string; attachmentId: string; assetUrl: string };

/** One dialog per attachment region, always derived from the current live files. */
export function useAttachmentPreview(issueId: string, attachments: TIssueAttachment[]) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectedAttachment =
    selection?.issueId === issueId
      ? attachments.find((item) => item.id === selection.attachmentId && item.asset_url === selection.assetUrl)
      : undefined;
  const src =
    selectedAttachment && canPreviewAttachment(selectedAttachment)
      ? getFileURL(selectedAttachment.asset_url)
      : undefined;

  useEffect(() => {
    if (selection && !src) setSelection(null);
  }, [selection, src]);

  return {
    openPreview: (attachment: TIssueAttachment) => {
      if (canPreviewAttachment(attachment))
        setSelection({ issueId, attachmentId: attachment.id, assetUrl: attachment.asset_url });
    },
    preview:
      selectedAttachment && src ? (
        <ImagePreviewModal
          key={`${issueId}:${selectedAttachment.id}:${src}`}
          src={src}
          name={selectedAttachment.attributes.name}
          onClose={() => setSelection(null)}
          labels={{
            loading: t("attachment.preview.loading"),
            error: t("attachment.preview.error"),
            retry: t("attachment.preview.retry"),
            close: t("attachment.preview.close"),
            download: t("attachment.preview.download"),
            zoomIn: t("attachment.preview.zoom_in"),
            zoomOut: t("attachment.preview.zoom_out"),
            resetZoom: t("attachment.preview.reset_zoom"),
          }}
        />
      ) : null,
  };
}

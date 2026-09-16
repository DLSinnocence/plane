/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { AnchorHTMLAttributes } from "react";
import { useTranslation } from "@plane/i18n";
import { ImageThumbnail } from "@plane/ui";
import type { TIssueAttachment } from "@plane/types";
import { cn, getFileURL } from "@plane/utils";
import { canPreviewAttachment } from "@/helpers/attachment-preview";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick" | "target" | "rel"> & {
  attachment: TIssueAttachment;
  onPreview: (attachment: TIssueAttachment) => void;
};

export function AttachmentFileLink({ attachment, onPreview, children, className, ...props }: Props) {
  const { t } = useTranslation();
  const href = getFileURL(attachment.asset_url);
  const canPreview = canPreviewAttachment(attachment);
  return (
    <a
      {...props}
      className={cn(
        className,
        canPreview &&
          "flex min-w-0 flex-1 cursor-zoom-in flex-col items-center gap-2 py-2 text-13 text-secondary hover:text-accent-primary"
      )}
      aria-label={canPreview ? attachment.attributes.name : props["aria-label"]}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-haspopup={canPreview ? "dialog" : undefined}
      onClick={(event) => {
        // File actions must not open an enclosing upload dropzone.
        event.stopPropagation();
        if (!href) {
          event.preventDefault();
          return;
        }
        if (
          canPreview &&
          !event.defaultPrevented &&
          event.button === 0 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          onPreview(attachment);
        }
      }}
    >
      {canPreview && href ? (
        <>
          <ImageThumbnail
            key={`${attachment.id}:${href}`}
            src={href}
            name={attachment.attributes.name}
            loadingLabel={t("attachment.preview.loading")}
            errorLabel={t("attachment.preview.error")}
          />
          <div className="flex max-w-full min-w-0 items-center gap-3">
            {children ?? <span className="truncate">{attachment.attributes.name}</span>}
          </div>
        </>
      ) : (
        (children ?? attachment.attributes.name)
      )}
    </a>
  );
}

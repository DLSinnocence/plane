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
import { AttachmentDownloadLink } from "./download";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick" | "target" | "rel"> & {
  attachment: TIssueAttachment;
  onPreview: (attachment: TIssueAttachment) => void;
};

export function AttachmentFileLink({ attachment, onPreview, children, className, ...props }: Props) {
  const { t } = useTranslation();
  const href = getFileURL(attachment.asset_url);
  const canPreview = canPreviewAttachment(attachment);
  const fileLink = (
    <a
      {...props}
      className={
        canPreview
          ? "flex max-w-full min-w-0 items-center gap-3 overflow-hidden text-13 text-secondary hover:text-accent-primary"
          : className
      }
      aria-label={canPreview ? attachment.attributes.name : props["aria-label"]}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-haspopup={canPreview ? "dialog" : undefined}
      onClick={(event) => {
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
      {children ?? <span className="truncate">{attachment.attributes.name}</span>}
    </a>
  );

  if (!canPreview || !href) return fileLink;
  return (
    <div className={cn(className, "flex min-w-0 flex-1 flex-col items-center gap-2 py-2")}>
      <button
        type="button"
        aria-label={attachment.attributes.name}
        aria-haspopup="dialog"
        className="inline-flex max-w-full cursor-zoom-in rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPreview(attachment);
        }}
      >
        <ImageThumbnail
          key={`${attachment.id}:${href}`}
          src={href}
          name={attachment.attributes.name}
          loadingLabel={t("attachment.preview.loading")}
          errorLabel={t("attachment.preview.error")}
        />
      </button>
      <div className="flex w-full min-w-0 items-center justify-center gap-2">
        {fileLink}
        <AttachmentDownloadLink attachment={attachment} />
      </div>
    </div>
  );
}

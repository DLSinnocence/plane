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
  "data-testid"?: string;
};

export function AttachmentFileLink({ attachment, onPreview, children, className, ...props }: Props) {
  const { t } = useTranslation();
  const href = getFileURL(attachment.asset_url);

  if (canPreviewAttachment(attachment) && href) {
    return (
      <div className={cn(className, "flex min-w-0 flex-1 items-center justify-center py-2")}>
        <button
          type="button"
          data-testid={props["data-testid"]}
          title={props.title ?? attachment.attributes.name}
          aria-label={props["aria-label"] ?? attachment.attributes.name}
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
      </div>
    );
  }

  return (
    <a
      {...props}
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.stopPropagation();
        if (!href) event.preventDefault();
      }}
    >
      {children ?? <span className="truncate">{attachment.attributes.name}</span>}
    </a>
  );
}

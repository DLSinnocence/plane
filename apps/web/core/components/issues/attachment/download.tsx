/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Download } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TIssueAttachment } from "@plane/types";
import { CustomMenu } from "@plane/ui";
import { getFileURL } from "@plane/utils";

type Props = { attachment: TIssueAttachment };

export function AttachmentDownloadLink({ attachment }: Props) {
  const { t } = useTranslation();
  const href = getFileURL(attachment.asset_url);
  if (!href) return null;
  return (
    <a
      href={href}
      download={attachment.attributes.name}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="inline-flex shrink-0 items-center gap-1.5 rounded border border-strong bg-layer-2 px-2 py-1 text-11 font-medium text-secondary hover:bg-layer-2-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <Download aria-hidden="true" className="size-3.5" />
      {t("attachment.preview.download")}
    </a>
  );
}

export function AttachmentDownloadMenuItem({ attachment }: Props) {
  const { t } = useTranslation();
  const href = getFileURL(attachment.asset_url);
  if (!href) return null;
  return (
    <CustomMenu.MenuItem
      className="flex items-center gap-2"
      onClick={() => {
        // The menu item is a button. Use a separate native link, without nesting
        // interactive elements or fetching the file into JavaScript memory.
        const link = document.createElement("a");
        link.href = href;
        link.download = attachment.attributes.name;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.hidden = true;
        document.body.append(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
      }}
    >
      <Download aria-hidden="true" className="size-3.5" />
      <span>{t("attachment.preview.download")}</span>
    </CustomMenu.MenuItem>
  );
}

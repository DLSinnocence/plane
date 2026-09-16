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

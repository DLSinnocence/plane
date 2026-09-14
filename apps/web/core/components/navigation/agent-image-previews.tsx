/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { AgentImage } from "@/helpers/agent-stream";
import { imagePreviewUrl } from "@/helpers/agent-images";

export function AgentImagePreviews({
  images = [],
  onRemove,
}: {
  images?: AgentImage[];
  onRemove?: (index: number) => void;
}) {
  const { t } = useTranslation();
  if (!images.length) return null;
  return (
    <ul className="agent-image-list" aria-label={t("account_settings.ai.image_preview")}>
      {images.map((image, index) => (
        // eslint-disable-next-line react/no-array-index-key -- previews have no local state; bytes come from immutable attachments
        <li key={`${image.name}-${index}`} className="agent-image-preview">
          <img src={imagePreviewUrl(image)} alt={image.name || t("account_settings.ai.image_preview")} />
          {image.name && <span title={image.name}>{image.name}</span>}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`${t("account_settings.ai.image_remove")}: ${image.name || index + 1}`}
            >
              <X className="size-3" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

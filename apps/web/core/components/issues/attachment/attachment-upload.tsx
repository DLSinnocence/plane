/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import type { FileRejection } from "react-dropzone";
import { useDropzone } from "react-dropzone";
import { useTranslation } from "@plane/i18n";
import {
  getAttachmentRejectionKey,
  getAttachmentRejectionDetails,
  getAttachmentUploadErrorKey,
  getAttachmentUploadErrorDetails,
} from "@/helpers/attachment-upload";
import { useFileSize } from "@/hooks/use-file-size";
import type { TAttachmentOperations } from "../issue-detail-widgets/attachments/helper";

type Props = {
  workspaceSlug: string;
  disabled?: boolean;
  attachmentOperations: Pick<TAttachmentOperations, "create">;
};

export const IssueAttachmentUpload = observer(function IssueAttachmentUpload(props: Props) {
  const { workspaceSlug, disabled = false, attachmentOperations } = props;
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<{ key: string; details: string; size: number } | null>(null);
  const { maxFileSize } = useFileSize();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const onDrop = useCallback(
    (acceptedFiles: File[], rejections: FileRejection[]) => {
      setError(null);
      if (rejections.length) {
        setError({
          key: getAttachmentRejectionKey(rejections, maxFileSize, acceptedFiles.length + rejections.length),
          details: getAttachmentRejectionDetails(rejections),
          size: rejections.reduce((total, rejection) => total + rejection.file.size, 0),
        });
        return;
      }
      const currentFile = acceptedFiles[0];
      if (!currentFile || !workspaceSlug) return;
      setIsLoading(true);
      void attachmentOperations
        .create(currentFile)
        .catch((cause: unknown) => {
          if (active.current)
            setError({
              key: getAttachmentUploadErrorKey(cause),
              details: getAttachmentUploadErrorDetails(cause),
              size: currentFile.size,
            });
        })
        .finally(() => {
          if (active.current) setIsLoading(false);
        });
    },
    [attachmentOperations, workspaceSlug, maxFileSize]
  );

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    maxSize: maxFileSize,
    multiple: false,
    disabled: isLoading || disabled,
  });

  return (
    <div
      {...getRootProps()}
      className={`flex min-h-[60px] items-center justify-center rounded-md border-2 border-dashed bg-accent-primary/5 px-4 py-2 text-11 text-accent-primary ${isDragActive ? "border-accent-strong bg-accent-primary/10" : "border-subtle"} ${isDragReject ? "bg-danger-subtle" : ""} ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
    >
      <input {...getInputProps()} />
      {error ? (
        <div role="alert" className="space-y-1 text-center break-words text-danger-primary">
          <p>{t(error.key, { size: maxFileSize / 1024 / 1024 })}</p>
          <p>{t("attachment.selection_details", { size: error.size, limit: maxFileSize, reason: error.details })}</p>
        </div>
      ) : (
        <p className="text-center">{isLoading ? t("attachment.slots.uploading") : t("attachment.drag_and_drop")}</p>
      )}
    </div>
  );
});

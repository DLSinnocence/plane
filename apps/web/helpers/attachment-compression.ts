/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TFileMetaDataLite } from "@plane/types";

export const ATTACHMENT_COMPRESSION_THRESHOLD = 50 * 1024 * 1024;

export type TAttachmentUploadMetadata = TFileMetaDataLite & {
  content_encoding?: "gzip";
  compressed_size?: number;
};

export type TPreparedAttachmentUpload = {
  file: File;
  metadata: TAttachmentUploadMetadata;
};

/** Keep original metadata for display/validation; only the storage body is compressed. */
export async function prepareAttachmentUpload(
  file: File,
  metadata: TFileMetaDataLite
): Promise<TPreparedAttachmentUpload> {
  if (file.size <= ATTACHMENT_COMPRESSION_THRESHOLD) return { file, metadata };

  if (typeof CompressionStream === "undefined" || typeof file.stream !== "function") {
    throw Object.assign(
      new Error("This browser cannot compress large attachments. Use a browser that supports gzip CompressionStream."),
      { code: "ATTACHMENT_COMPRESSION_UNSUPPORTED" }
    );
  }

  try {
    // Stream the source instead of materializing a potentially 1GB input ArrayBuffer.
    // Only the compressed output is collected for the signed multipart storage upload.
    const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = await new Response(stream).blob();
    const uploadFile = new File([compressed], file.name, { type: metadata.type, lastModified: file.lastModified });
    return {
      file: uploadFile,
      metadata: { ...metadata, content_encoding: "gzip", compressed_size: uploadFile.size },
    };
  } catch (cause) {
    // Never fall back to uploading the uncompressed source with gzip metadata.
    throw Object.assign(
      new Error("The attachment could not be compressed. No file was uploaded. Please retry.", { cause }),
      {
        code: "ATTACHMENT_COMPRESSION_FAILED",
      }
    );
  }
}

/** An older API may ignore gzip metadata. Refuse its signed form before sending any bytes. */
export function validateAttachmentUploadEncoding(
  metadata: TAttachmentUploadMetadata,
  fields: Record<string, string> | undefined
): void {
  if (metadata.content_encoding !== "gzip") return;

  const matches = (name: string, expected: string) => {
    const values = Object.entries(fields ?? {})
      .filter(([key]) => key.toLowerCase() === name)
      .map(([, value]) => value);
    return values.length === 1 && values[0] === expected;
  };
  if (!matches("content-encoding", "gzip") || !matches("content-type", metadata.type)) {
    throw Object.assign(
      new Error(
        "The upload service did not authorize gzip with the original file type. No file was uploaded. Contact an administrator to update the service."
      ),
      { code: "ATTACHMENT_COMPRESSION_NOT_ACCEPTED" }
    );
  }
}

/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { FileRejection } from "react-dropzone";

export type TAttachmentUploadErrorKey =
  | "attachment.error"
  | "attachment.only_one_file_allowed"
  | "attachment.file_size_limit"
  | "attachment.invalid_file_type"
  | "attachment.file_read_error"
  | "attachment.permission_denied"
  | "attachment.server_size_rejected"
  | "attachment.compression_unsupported"
  | "attachment.compression_failed"
  | "attachment.compression_not_accepted";

export function getAttachmentRejectionKey(
  rejections: FileRejection[],
  maxFileSize: number,
  totalFiles = rejections.length
): TAttachmentUploadErrorKey {
  const codes = new Set(rejections.flatMap(({ errors }) => errors.map(({ code }) => code)));
  if (totalFiles > 1 || codes.has("too-many-files")) return "attachment.only_one_file_allowed";
  if (codes.has("file-too-large") && rejections.some(({ file }) => file.size > maxFileSize)) {
    return "attachment.file_size_limit";
  }
  if (codes.has("file-invalid-type")) return "attachment.invalid_file_type";
  return "attachment.file_read_error";
}

export function getAttachmentRejectionDetails(rejections: FileRejection[]): string {
  return [...new Set(rejections.flatMap(({ errors }) => errors.map(({ code, message }) => `${code}: ${message}`)))]
    .join("; ")
    .slice(0, 600);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function getAttachmentUploadErrorDetails(error: unknown): string {
  const details = record(error);
  const response = record(details?.response);
  const status = response?.status ?? details?.status;
  const data = response?.data ?? error;
  const body = data instanceof Error ? undefined : record(data);
  const reasons: string[] = [];
  if (typeof data === "string") {
    // S3 returns XML; retain its error code and message, never the signed request or HTML page.
    const code = data.match(/<Code>([^<]{1,100})<\/Code>/)?.[1];
    const message = data.match(/<Message>([^<]{1,400})<\/Message>/)?.[1];
    if (code) reasons.push(code);
    if (message) reasons.push(message);
    if (!data.includes("<") && data.trim()) reasons.push(data.trim().slice(0, 400));
  }
  if (body) {
    for (const key of ["error", "detail", "name", "size", "type", "slot_id", "content_encoding", "compressed_size"]) {
      const value = body[key];
      const text =
        typeof value === "string"
          ? value
          : Array.isArray(value)
            ? value.filter((item) => typeof item === "string").join("; ")
            : "";
      if (text) reasons.push(key === "error" || key === "detail" ? text : `${key}: ${text}`);
    }
  }
  if (!reasons.length && typeof details?.message === "string") reasons.push(details.message);
  const reason = [...new Set(reasons)].join("; ").slice(0, 600);
  return [typeof status === "number" ? `HTTP ${status}` : "", reason].filter(Boolean).join(": ");
}

export function getAttachmentUploadErrorKey(error: unknown): TAttachmentUploadErrorKey {
  const details = record(error);
  const response = record(details?.response);
  const status = response?.status ?? details?.status;
  const body = record(response?.data) ?? details;
  if (
    status === 401 ||
    status === 403 ||
    body?.error === "You don't have the required permissions." ||
    body?.detail === "You don't have the required permissions."
  ) {
    return "attachment.permission_denied";
  }
  if (details?.code === "ATTACHMENT_COMPRESSION_UNSUPPORTED") return "attachment.compression_unsupported";
  if (details?.code === "ATTACHMENT_COMPRESSION_FAILED") return "attachment.compression_failed";
  if (details?.code === "ATTACHMENT_COMPRESSION_NOT_ACCEPTED") return "attachment.compression_not_accepted";
  if (status === 413 || body?.error === "REQUEST_BODY_TOO_LARGE") return "attachment.server_size_rejected";
  if (body?.error === "Invalid file type.") return "attachment.invalid_file_type";
  return "attachment.error";
}

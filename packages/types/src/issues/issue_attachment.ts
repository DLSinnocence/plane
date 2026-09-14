/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TFileSignedURLResponse } from "../file";

export type TIssueAttachment = {
  id: string;
  attributes: {
    name: string;
    size: number;
  };
  asset_url: string;
  issue_id: string;
  attachment_slot_id?: string | null;
  // required
  updated_at: string;
  updated_by: string;
  created_by: string;
};

export type TAttachmentTemplate = {
  id: string;
  name: string;
  slots: string[];
  created_by: string | null;
  updated_at: string;
};

export type TIssueAttachmentSlot = {
  id: string;
  name: string;
  sort_order: number;
  attachment: TIssueAttachment | null;
};

export type TIssueAttachmentSlotDeleteResponse = {
  slot_id: string;
  deleted_attachment_ids: string[];
};

export type TIssueAttachmentUploadResult = TIssueAttachment & {
  deleted_attachment_ids?: string[];
  attachment_slot?: TIssueAttachmentSlot;
};

export type TIssueAttachmentUploadResponse = TFileSignedURLResponse & {
  attachment: TIssueAttachment;
  attachment_slot?: Omit<TIssueAttachmentSlot, "attachment">;
};

export type TIssueAttachmentMap = {
  [issue_id: string]: TIssueAttachment;
};

export type TIssueAttachmentIdMap = {
  [issue_id: string]: string[];
};

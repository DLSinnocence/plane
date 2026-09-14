/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { AxiosRequestConfig } from "axios";
import { API_BASE_URL } from "@plane/constants";
// plane types
import { getFileMetaDataForUpload, generateFileUploadPayload } from "@plane/services";
import type {
  TIssueAttachment,
  TIssueAttachmentSlot,
  TIssueAttachmentUploadResponse,
  TIssueAttachmentUploadResult,
  TIssueServiceType,
} from "@plane/types";
import { EIssueServiceType } from "@plane/types";
// services
import { APIService } from "@/services/api.service";
import { FileUploadService } from "@/services/file-upload.service";

export class IssueAttachmentService extends APIService {
  private fileUploadService: FileUploadService;
  private serviceType: TIssueServiceType;

  constructor(serviceType: TIssueServiceType = EIssueServiceType.ISSUES) {
    super(API_BASE_URL);
    // upload service
    this.fileUploadService = new FileUploadService();
    this.serviceType = serviceType;
  }

  private async updateIssueAttachmentUploadStatus(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    attachmentId: string
  ): Promise<
    | {
        attachment_slot_id?: string | null;
        attachment_slot?: Omit<TIssueAttachmentSlot, "attachment">;
        deleted_attachment_ids?: string[];
      }
    | undefined
  > {
    return this.patch(
      `/api/assets/v2/workspaces/${workspaceSlug}/projects/${projectId}/${this.serviceType}/${issueId}/attachments/${attachmentId}/`
    ).then((response) => response?.data);
  }

  async uploadIssueAttachment(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    file: File,
    uploadProgressHandler?: AxiosRequestConfig["onUploadProgress"],
    slotId?: string
  ): Promise<TIssueAttachmentUploadResult> {
    const fileMetaData = await getFileMetaDataForUpload(file);
    return this.post(
      `/api/assets/v2/workspaces/${workspaceSlug}/projects/${projectId}/${this.serviceType}/${issueId}/attachments/`,
      slotId ? { ...fileMetaData, slot_id: slotId } : fileMetaData
    ).then(async (response) => {
      const signedURLResponse: TIssueAttachmentUploadResponse = response?.data;
      const fileUploadPayload = generateFileUploadPayload(signedURLResponse, file);
      await this.fileUploadService.uploadFile(
        signedURLResponse.upload_data.url,
        fileUploadPayload,
        uploadProgressHandler
      );
      const completion = await this.updateIssueAttachmentUploadStatus(
        workspaceSlug,
        projectId,
        issueId,
        signedURLResponse.asset_id
      );
      const attachment = {
        ...signedURLResponse.attachment,
        ...(completion?.attachment_slot_id ? { attachment_slot_id: completion.attachment_slot_id } : {}),
      };
      const row = completion?.attachment_slot ?? signedURLResponse.attachment_slot;
      return {
        ...attachment,
        deleted_attachment_ids: completion?.deleted_attachment_ids ?? [],
        ...(row ? { attachment_slot: { ...row, attachment } } : {}),
      };
    });
  }

  async getIssueAttachments(workspaceSlug: string, projectId: string, issueId: string): Promise<TIssueAttachment[]> {
    return this.get(
      `/api/assets/v2/workspaces/${workspaceSlug}/projects/${projectId}/${this.serviceType}/${issueId}/attachments/`
    ).then((response) => response?.data);
  }

  async deleteIssueAttachment(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    assetId: string
  ): Promise<TIssueAttachment> {
    return this.delete(
      `/api/assets/v2/workspaces/${workspaceSlug}/projects/${projectId}/${this.serviceType}/${issueId}/attachments/${assetId}/`
    ).then((response) => response?.data);
  }
}

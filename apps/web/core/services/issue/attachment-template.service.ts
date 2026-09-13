/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type { TAttachmentTemplate, TIssueAttachmentSlot } from "@plane/types";
import { APIService } from "@/services/api.service";

type TTemplateInput = Pick<TAttachmentTemplate, "name" | "slots">;

export class AttachmentTemplateService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  private templatesPath(workspaceSlug: string) {
    return `/api/workspaces/${workspaceSlug}/attachment-templates/`;
  }

  private slotsPath(workspaceSlug: string, projectId: string, issueId: string) {
    return `/api/workspaces/${workspaceSlug}/projects/${projectId}/issues/${issueId}/attachment-slots/`;
  }

  async fetchTemplates(workspaceSlug: string): Promise<TAttachmentTemplate[]> {
    return this.get(this.templatesPath(workspaceSlug))
      .then((response) => response.data)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async createTemplate(workspaceSlug: string, data: TTemplateInput): Promise<TAttachmentTemplate> {
    return this.post(this.templatesPath(workspaceSlug), data)
      .then((response) => response.data)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async updateTemplate(workspaceSlug: string, templateId: string, data: TTemplateInput): Promise<TAttachmentTemplate> {
    return this.patch(`${this.templatesPath(workspaceSlug)}${templateId}/`, data)
      .then((response) => response.data)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async deleteTemplate(workspaceSlug: string, templateId: string): Promise<void> {
    await this.delete(`${this.templatesPath(workspaceSlug)}${templateId}/`).catch((error) => {
      throw error?.response?.data ?? error;
    });
  }

  async fetchSlots(workspaceSlug: string, projectId: string, issueId: string): Promise<TIssueAttachmentSlot[]> {
    return this.get(this.slotsPath(workspaceSlug, projectId, issueId))
      .then((response) => response.data)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async createSlot(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    name: string
  ): Promise<TIssueAttachmentSlot> {
    return this.post(this.slotsPath(workspaceSlug, projectId, issueId), { name })
      .then((response) => response.data)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async updateSlot(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    slotId: string,
    name: string
  ): Promise<TIssueAttachmentSlot> {
    return this.patch(`${this.slotsPath(workspaceSlug, projectId, issueId)}${slotId}/`, { name })
      .then((response) => response.data)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async deleteSlot(workspaceSlug: string, projectId: string, issueId: string, slotId: string): Promise<void> {
    await this.delete(`${this.slotsPath(workspaceSlug, projectId, issueId)}${slotId}/`).catch((error) => {
      throw error?.response?.data ?? error;
    });
  }

  async applyTemplate(
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    templateId: string
  ): Promise<TIssueAttachmentSlot[]> {
    return this.post(`${this.slotsPath(workspaceSlug, projectId, issueId)}apply-template/`, { template_id: templateId })
      .then((response) => response.data)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }
}
